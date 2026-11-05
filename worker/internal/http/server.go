// Package http provides the worker's single public-facing surface: a
// health check and kie.ai's webhook callback. Nothing else calls the
// worker over HTTP — see docs/architecture.md § "The worker".
package http

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"ugc-pipeline/worker/internal/config"
	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/media"
	"ugc-pipeline/worker/internal/store"
)

// webhookWorkers bounds how many webhook deliveries are downloaded /
// normalized / uploaded concurrently. This is deliberately independent of
// Config.FFmpegConcurrency (media.Runner already serializes the ffmpeg step
// itself) — this cap exists so a burst of retried/duplicate deliveries
// can't pile up unbounded goroutines each holding an open download.
const webhookWorkers = 8

// Server wraps the worker's HTTP surface.
type Server struct {
	httpServer *http.Server
	store      *store.Store
	config     *config.Config
	// kie is always non-nil in a real Deps — cmd/worker/main.go constructs
	// it unconditionally, since KieAPIKey is a required config var (see
	// config.Config.KieAPIKey). A test may still build a Server with a nil
	// kie client; handleKieWebhook's own nil check covers that case.
	kie    *kie.Client
	media  *media.Runner
	logger *slog.Logger

	webhookSem chan struct{}
}

// New builds a Server listening on addr (e.g. ":8080"). cfg, kieClient and
// mediaRunner are all needed by the webhook handler: cfg for the webhook
// secret and Supabase Storage credentials, kieClient to fetch the
// authoritative result once a webhook says a render completed, mediaRunner
// to normalize the downloaded clip.
func New(addr string, st *store.Store, cfg *config.Config, kieClient *kie.Client, mediaRunner *media.Runner, logger *slog.Logger) *Server {
	if cfg.KieWebhookSecret == "" {
		// Not a Load() failure (see config.Config.KieWebhookSecret's own doc
		// comment — it's optional, with a startup Warning instead), so this
		// is a real, if degraded, deployment state rather than only a test
		// building a Server with an intentionally empty secret. Loud either
		// way, because the alternative is a webhook endpoint that silently
		// accepts anything.
		logger.Error("kie webhook secret is empty; all webhook deliveries will be rejected")
	}

	s := &Server{
		store:      st,
		config:     cfg,
		kie:        kieClient,
		media:      mediaRunner,
		logger:     logger,
		webhookSem: make(chan struct{}, webhookWorkers),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /webhooks/kie", s.handleKieWebhook)
	if cfg.IsDev() {
		// Only registered in MODE=development — a production worker must
		// never expose a route that hands out a synthetic "rendered" video.
		s.registerMockRoutes(mux)
	}

	s.httpServer = &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	return s
}

// ListenAndServe starts the HTTP server. It blocks until the server stops;
// returns nil on a clean shutdown (http.ErrServerClosed).
func (s *Server) ListenAndServe() error {
	err := s.httpServer.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Shutdown gracefully stops the HTTP server, waiting for in-flight
// requests to finish (bounded by ctx).
func (s *Server) Shutdown(ctx context.Context) error {
	return s.httpServer.Shutdown(ctx)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Ping(r.Context()); err != nil {
		s.logger.Error("health check: db ping failed", slog.String("error", err.Error()))
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "unhealthy"})
		return
	}
	w.WriteHeader(http.StatusOK)
	// mode is reported because the FILE is not the PROCESS.
	//
	// worker/.env carried MOCK_FAL_VIDEO=1 all day on 2026-08-31 while the
	// running worker had it false — godotenv.Load() does not override a
	// variable already set in the shell, so a stale export beat the file
	// silently. Three separate readings of that file said "local is mocked"
	// and a real $2.52 kie render proved otherwise. MODE (config.Config.Mode)
	// replaced that single MockFalVideo bool one-for-one as the thing
	// actually asked here.
	//
	// The startup log already says this, but a log line is only seen by
	// whoever was watching the terminal at the moment the process booted.
	// This is the same fact, askable at any time, by anything — including
	// the web app, which shares nothing with this service but Postgres and
	// therefore has no other way to find out. web's own GET /api/health
	// reports the same key ("mode") for its own process, for the same
	// reason — see that route's modeState doc comment.
	_ = json.NewEncoder(w).Encode(healthPayload(s.config))
}

// healthPayload is split out so it can be tested without a database.
// handleHealth pings the store first, which needs a real one; the part worth
// pinning is what the body SAYS, and that depends only on config.
func healthPayload(cfg *config.Config) map[string]any {
	return map[string]any{
		"status":        "ok",
		"mode":          cfg.Mode,
		"assembleReady": cfg.AssembleEnabled,
	}
}
