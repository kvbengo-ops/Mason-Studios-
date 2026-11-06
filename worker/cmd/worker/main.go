// Command worker is the ugc-pipeline worker: four background loops
// (dispatch, reconcile, assemble, weekly credit notifications) plus one
// public HTTP route for kie.ai's webhook callback. See docs/architecture.md
// § "The worker".
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata"

	"github.com/joho/godotenv"

	"ugc-pipeline/worker/internal/byteplus"
	"ugc-pipeline/worker/internal/config"
	whttp "ugc-pipeline/worker/internal/http"
	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/logging"
	"ugc-pipeline/worker/internal/loop"
	"ugc-pipeline/worker/internal/media"
	"ugc-pipeline/worker/internal/store"
)

// The router is loop's one video vendor; pinned here, where both packages are
// already imported, because byteplus deliberately does not import loop.
var _ loop.VideoVendor = (*byteplus.Router)(nil)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	// Local dev convenience only; in production (Render) env vars are
	// injected directly and no .env file exists, so a missing file here
	// is not an error.
	//
	// .env.local comes FIRST and wins: godotenv never overwrites a variable
	// that is already set, so the earlier file takes precedence. That is the
	// same precedence Next.js gives the same filename on the web side, which
	// matters because both halves of this stack are configured together and
	// a developer who learns the rule on one should not be surprised by the
	// other. .env stays readable for anything shared and committed.
	//
	// Loading only .env was a quiet trap: a worker/.env.local sitting right
	// there, gitignored and full of correct values, was read by nothing, and
	// the worker died on "required environment variable DATABASE_URL is not
	// set" while pointing at a file that sets it.
	_ = godotenv.Load(".env.local")
	_ = godotenv.Load()

	logger := logging.New()
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("startup: %w", err)
	}

	// Non-fatal configuration facts whose symptom is otherwise silence —
	// see config.Config.Warnings. Logged before anything else starts, so
	// they sit at the top of the boot output rather than buried under the
	// first render.
	for _, warning := range cfg.Warnings {
		logger.Warn(warning)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	// cfg.IsDev() is baked into the Store at construction, not threaded as a
	// per-call argument — this worker's own mode never varies mid-process
	// (Mode is read once at Load(), config.go), so every claim/reconcile
	// query the Store makes for the rest of its life must filter on that
	// same value. See store.New's doc comment and scenes.dev
	// (0063_scenes_dev_flag.sql) for what this actually closes off.
	st, err := store.New(ctx, cfg.DatabaseURL, cfg.IsDev())
	if err != nil {
		return fmt.Errorf("startup: connect to database: %w", err)
	}
	defer st.Close()

	// Migrations check: the worker does not run migrations itself
	// (supabase/migrations owns that); a successful ping is our signal
	// that the expected database is reachable at startup.
	if err := st.Ping(ctx); err != nil {
		return fmt.Errorf("startup: database ping: %w", err)
	}
	logger.Info("connected to database")

	// The mock video URL must be one this worker can download from ITSELF
	// (ingest.FromResult fetches it back over HTTP), which is why it comes
	// from the listen port and not from AppBaseURL — that variable holds the
	// address kie must reach from the outside, a different question with a
	// different answer everywhere except production. See http.MockClipURL.
	mockVideoURL := whttp.MockClipURL(cfg.Port)

	mediaRunner := media.NewRunner(cfg.FFmpegConcurrency)

	// kieClient is unconditional now — kie is the only video vendor this
	// worker speaks to, and KieAPIKey is a required config var (see
	// config.Config.KieAPIKey), so there is no longer an "opt-in" state to
	// gate construction on the way KIE_ENABLED used to.
	kieClient := kie.NewClient(cfg.KieAPIKey, cfg.IsDev(), nil, mockVideoURL)
	if cfg.IsDev() {
		logger.Warn("MODE=development: kie submissions are simulated, no real renders will be requested",
			slog.String("mock_video_url", mockVideoURL))
	}

	// Seedance 2.5 goes to BytePlus ModelArk when BYTEPLUS_API_KEY is set
	// (internal/byteplus); every other model, and every render when it is
	// unset, stays on kie. Never in development: there every render is
	// mocked through kie's client, and a real key there would bill.
	router := &byteplus.Router{Kie: kieClient, Log: logger}
	if cfg.BytePlusAPIKey != "" && !cfg.IsDev() {
		router.BytePlus = byteplus.NewClient(cfg.BytePlusAPIKey, cfg.BytePlusModel, nil)
		router.Route = cfg.BytePlusRoute
		router.MaxInflight = cfg.BytePlusMaxInflight
		router.Inflight = func(ctx context.Context) (int, error) {
			return st.RenderingWithTaskPrefix(ctx, kie.BytePlusTaskPrefix)
		}
		if router.Route {
			logger.Info("BYTEPLUS_API_KEY is set: Seedance 2.5 renders go to BytePlus ModelArk (overflow and refusals to kie), every other model to kie",
				slog.Int("byteplus_max_inflight", router.MaxInflight))
		} else {
			logger.Info("BYTEPLUS_ROUTE=0: no new renders go to BytePlus; tasks already there are still polled")
		}
	}

	deps := loop.Deps{
		Store:  st,
		Config: cfg,
		Logger: logger,
		Media:  mediaRunner,
		Kie:    router,
		// One gate for the process, shared by every dispatch tick — `deps`
		// is captured by value in the loop closures below, so this has to be
		// a pointer or each tick would get a fresh, always-open copy.
		Balance: &loop.BalanceGate{},
	}
	if !cfg.AssembleEnabled {
		logger.Info("ASSEMBLE_ENABLED is off: delivering raw clips, not an assembled final video")
	}

	go loop.Every(ctx, 30*time.Second, "dispatch", func(ctx context.Context) error {
		return loop.Dispatch(ctx, deps)
	})
	// Was 2m, paired with reconcile.go's old 3m staleAfter. Measured against
	// the live database, submit-to-clip was taking 232-299s for every
	// render, but runs.latency_ms values clustered within milliseconds of
	// each other across independently-generated scenes in the same batch —
	// that can only be this loop's own detection cadence, not vendor work
	// (a real completed render's own reported inference time came back
	// ~80s). 30s keeps this in step with staleAfter's new 45s floor: a lost
	// webhook is now caught within roughly one tick of becoming stale
	// instead of sitting for however much of the old 2m window remained.
	go loop.Every(ctx, 30*time.Second, "reconcile", func(ctx context.Context) error {
		return loop.Reconcile(ctx, deps)
	})
	go loop.Every(ctx, 30*time.Second, "assemble", func(ctx context.Context) error {
		return loop.Assemble(ctx, deps)
	})
	// shortcut: notices can arrive up to five minutes late; switch to a managed scheduler when available.
	if !cfg.IsDev() {
		manila, err := time.LoadLocation("Asia/Manila")
		if err != nil {
			return fmt.Errorf("startup: load Manila time zone: %w", err)
		}
		notifyWeeklyCreditRenewal := func(ctx context.Context) error {
			if time.Now().In(manila).Weekday() != time.Monday {
				return nil
			}
			return st.NotifyWeeklyCreditRenewal(ctx)
		}
		if err := notifyWeeklyCreditRenewal(ctx); err != nil {
			logger.Warn("initial weekly credit notification check failed", slog.String("error", err.Error()))
		}
		go loop.Every(ctx, 5*time.Minute, "weekly-credit-renewal", notifyWeeklyCreditRenewal)
	}

	srv := whttp.New(fmt.Sprintf(":%d", cfg.Port), st, cfg, kieClient, mediaRunner, logger)

	serveErr := make(chan error, 1)
	go func() {
		logger.Info("http server listening", slog.Int("port", cfg.Port))
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		logger.Info("shutdown signal received")
	case err := <-serveErr:
		if err != nil {
			logger.Error("http server error", slog.String("error", err.Error()))
		}
		stop()
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("http server shutdown error", slog.String("error", err.Error()))
	}

	logger.Info("worker stopped")
	return nil
}
