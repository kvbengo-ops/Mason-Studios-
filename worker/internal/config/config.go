// Package config loads worker configuration from the environment.
//
// Load fails fast: any missing required variable aborts startup with a
// message naming exactly which variable is missing. The worker must never
// start half-configured — a partially-configured process that starts
// dispatching against a wrong or empty config is worse than one that never
// starts.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all worker configuration, loaded once at startup from the
// environment (see worker/.env.example for the full list of variables).
type Config struct {
	// DatabaseURL is the Postgres connection string (pgx). Required.
	DatabaseURL string
	// SupabaseURL is the Supabase project URL, used for storage uploads.
	// Required.
	SupabaseURL string
	// SupabaseServiceRoleKey authenticates storage/API calls to Supabase.
	// Required — this is a secret, never log it.
	SupabaseServiceRoleKey string
	// KieAPIKey authenticates requests to kie.ai, the only video vendor
	// this worker speaks to since fal.ai was decommissioned. Required —
	// the same bar FalKey used to hold: a worker that cannot authenticate
	// to its one vendor can never render anything, so it must never start
	// half-configured (see this package's own doc comment).
	KieAPIKey string
	// KieWebhookSecret verifies inbound kie.ai webhook signatures — see
	// internal/http/webhook_kie.go's handler, which rejects every request
	// outright when this is empty rather than treating an unset secret as
	// "accept everything". Optional, unlike KieAPIKey: kie's webhook
	// signing is opt-in on THEIR side (a webhookHmacKey generated in kie's
	// own settings), so a deployment with no secret is a legitimate state
	// — degraded (see Warnings below), not a misconfiguration to refuse to
	// boot on.
	KieWebhookSecret string
	// BytePlusAPIKey (BYTEPLUS_API_KEY) sends Seedance 2.5 renders to BytePlus
	// ModelArk instead of kie — see internal/byteplus. Optional: unset keeps
	// every render on kie, which is today's behaviour. Ignored in
	// MODE=development, where every render is mocked through kie's client.
	BytePlusAPIKey string
	// BytePlusModel (BYTEPLUS_MODEL) is the model or endpoint id sent to
	// BytePlus. Empty = dreamina-seedance-2-5-260628; set an "ep-..." endpoint
	// id when the account refuses model-id access.
	BytePlusModel string
	// BytePlusRoute (BYTEPLUS_ROUTE, on unless "0") sends NEW Seedance 2.5
	// renders to BytePlus. "0" stops new submissions while the key stays set,
	// so renders already running there are still polled to the end.
	BytePlusRoute bool
	// BytePlusMaxInflight (BYTEPLUS_MAX_INFLIGHT, default 3 — an Individual
	// account's limit; Enterprise is 10) caps BytePlus tasks running at once.
	// Over it, BytePlus scenes stay queued for a later tick — never kie.
	BytePlusMaxInflight int
	// AppBaseURL is this worker's own publicly-reachable base URL (e.g.
	// https://worker.example.com), used to build the webhook callback
	// URL ({AppBaseURL}/webhooks/kie) passed on every render submission.
	// Required — kie cannot call back a worker that doesn't know its own
	// address.
	AppBaseURL string

	// RenderConcurrency caps how many scenes may be in status='rendering'
	// at once. Defaults to 10.
	RenderConcurrency int
	// FFmpegConcurrency caps concurrent ffmpeg processes. Defaults to 2.
	//
	// THIS IS THE ONLY THING BOUNDING THE WORKER'S MEMORY, and 2 is not a
	// round number picked for tidiness. Measured 2026-09-03: one Normalize
	// of a 5s 1080x1920 clip — the invocation in internal/media, x264
	// veryfast crf 20 — peaks at ~554 MB RSS. Two at once plus the Go
	// process is ~1.17 GB against ugc-worker's 2 GB, which matches the one
	// 1512 MB spike in Render's metrics for 2026-08-31 (everything else that
	// week sat at 10-59 MB).
	//
	// So raising this to 4 is ~2.2 GB and an OOM kill, not a speed-up. It
	// would also buy nothing: normalize costs ~2.8s of CPU per clip against
	// a kie render measured in minutes. RENDER_CONCURRENCY can be 10 and
	// stay safe precisely because ten arriving clips still queue two-at-a-
	// time behind this semaphore.
	FFmpegConcurrency int
	// Port is the HTTP listen port. Defaults to 8080.
	Port int
	// Mode is MODE — "development" or "production", defaulting to
	// "development" for anything else (unset, a typo, "prod"). Read once
	// here, at startup, and passed down through Deps/Store from then on —
	// nothing in this process re-reads the environment mid-run.
	//
	// This replaced MockFalVideo (MOCK_FAL_VIDEO) and its ugc-web twin
	// MOCK_FAL_IMAGE — two independent per-process mock flags that could
	// each be set without the other, which is exactly the shape of the
	// incident this field exists to prevent: a render mocked by setting
	// MOCK_FAL_VIDEO=1 on a LOCAL worker was claimed and billed by the
	// DEPLOYED worker instead, because both poll the same scenes table and
	// a flag set on one process has no say in which process claims a row
	// first. See web/lib/mode.ts's header for the full incident.
	//
	// In development, no vendor is ever called — see main.go's
	// kie.NewClient construction (fal is decommissioned; kie is the only
	// vendor client left to gate). The fix that actually closes
	// the race is scenes.dev, not this field alone: every Store method that
	// claims or reconciles rendering work (ClaimQueuedScenes — candidate set
	// and ceiling count both — and StaleRendering, internal/store/store.go)
	// filters on scenes.dev built
	// from THIS value, so a development-mode worker can never claim,
	// dispatch, or bill a row a production-mode process queued, and a
	// production-mode worker can never touch a development one — regardless
	// of how many worker processes are polling the table at once.
	Mode string
	// Warnings are configuration facts that are not errors but that an
	// operator has to be TOLD, because their symptom is silence.
	//
	// The one that forced this to exist: no KIE_WEBHOOK_SECRET set.
	// Nothing fails, nothing crashes, and every render still completes —
	// just 45-90 seconds after it actually finished, because the only
	// thing that notices is the reconcile poll. It ran that way for six
	// days and the sole trace was a "webhook never arrived" line on the
	// far side, which reads as "the vendor never called" and is the wrong
	// conclusion. A config that degrades quietly has to say so out loud at
	// the one moment somebody is watching: startup.
	Warnings []string

	// AssembleEnabled, when true (ASSEMBLE_ENABLED=1), turns on the
	// assemble loop's ffmpeg-concat-into-a-final-mp4 behavior. Defaults to
	// false: whether the client wants an assembled mp4 at all vs. raw clips
	// is an open question (see docs/roadmap.md), and the loop must be
	// silent — not merely inactive — when this is off (see loop.Assemble).
	AssembleEnabled bool
	// AudioEnabled, when true (AUDIO_ENABLED=1), does two things in
	// kie.PickModel (internal/kie/models.go):
	//
	//  1. Lets scenes with is_talking_head=true route to Kling 3.0 Pro,
	//     kie's only native-audio (lip-synced) model — but only if the
	//     project has explicitly selected it (see PickModel's own doc
	//     comment: settings.Model is authoritative, is_talking_head alone
	//     never routes there). A project that never selected it, or a
	//     scene that isn't eligible, renders on the project's own
	//     non-native-audio default instead (Seedance 2.5 unless the
	//     project chose otherwise).
	//  2. Turns on generate_audio for whatever descriptor PickModel
	//     actually returns that supports it (Seedance only — Hailuo has no
	//     audio input at all). This is NOT gated on is_talking_head:
	//     Seedance has no per-scene "should this one speak" input beyond
	//     its prompt, so every scene routed to it gets generate_audio set
	//     to this flag's value. dispatch.go's promptForScene is what
	//     decides whether there's anything for that audio to say, by
	//     appending script_line to the submitted prompt whenever the
	//     resolved model actually has audio on.
	//
	// So this flag does change something today even on a project that has
	// never selected Kling: it turns Seedance's own generate_audio on or
	// off. web/lib/models.ts's pickModel and web/lib/estimate.ts's
	// estimateCost still resolve the same routing logic for
	// pricing/estimate purposes, and kie's own rate table has no separate
	// price for generate_audio=true on Seedance (only Kling's sound-on
	// tier costs more — see kie.Rates), so the quoted price still agrees
	// with what actually renders either way.
	// Defaults to false regardless: during this testing phase there is no
	// reason to pay for audio by default — Kling's sound-on rate is 1.5x
	// its silent one, and this flag is meant to be flipped on
	// deliberately, per render, not left on. Web's own AUDIO_ENABLED
	// (web/lib/models.ts isAudioEnabled) must still be set the same as
	// this one on both services — see docs/architecture.md § "Known gaps".
	AudioEnabled bool

	// ReconcileGiveUpAfter is how long a scene may sit in 'rendering' with
	// reconcile repeatedly failing to make progress on it — ingest
	// (download/normalize/upload), the fal status check, the fal result
	// fetch, or the scene re-fetch done just before ingest — before the
	// reconcile loop gives up and marks it 'failed' outright, so a
	// permanently-broken render (corrupt asset, storage outage, disk full,
	// an expired/rejected fal request ID) doesn't retry every reconcile
	// tick forever, invisible to the operator and unreachable by retryScene
	// (which only handles status='failed'). One shared timeout rather than
	// a separate knob per failure mode, since they're all the same shape:
	// reconcile can't move this scene forward.
	// Measured from submitted_at, the same claim-time timestamp
	// StaleRendering already uses. Defaults to 30 minutes, overridable via
	// RECONCILE_GIVE_UP_AFTER_MINUTES.
	ReconcileGiveUpAfter time.Duration
}

// IsDev reports whether this process is running MODE=development — see
// Mode's own doc comment. Every call site that used to read MockFalVideo
// reads this instead.
func (c *Config) IsDev() bool {
	return c.Mode == "development"
}

// parseMode parses MODE, defaulting to "development" for anything other
// than exactly "production" — unset, a typo, "Prod", "PRODUCTION". The
// unsafe direction is landing on "production" by accident with a live key;
// the safe one is staying mocked, so garbage falls the safe way rather than
// being guessed toward the dangerous one. Mirrors web/lib/mode.ts's
// parseMode exactly — both halves of this contract must agree on what
// counts as production.
func parseMode(raw string) string {
	if raw == "production" {
		return "production"
	}
	return "development"
}

// requiredVar reads name from the environment, returning an error naming
// the variable if it is unset or empty.
func requiredVar(env map[string]string, name string) (string, error) {
	v, ok := env[name]
	if !ok || v == "" {
		return "", fmt.Errorf("config: required environment variable %s is not set", name)
	}
	return v, nil
}

// positiveIntVar reads name as an integer that must be greater than zero.
// Every integer this config carries is a capacity, a port, or a timeout, and
// none of them mean anything at zero or below: a zero semaphore capacity
// deadlocks all media work with no error, and a non-positive PORT fails only
// later, at Listen. Bounding here rather than at each call site means one
// guard covers all four.
func positiveIntVar(env map[string]string, name string, def int) (int, error) {
	v, ok := env[name]
	if !ok || v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("config: environment variable %s must be an integer, got %q: %w", name, v, err)
	}
	if n <= 0 {
		return 0, fmt.Errorf("config: environment variable %s must be greater than zero, got %d", name, n)
	}
	return n, nil
}

// Load reads configuration from the process environment. It does not read
// a .env file itself — callers that want dotenv support (local dev) should
// load one with godotenv before calling Load, e.g. in cmd/worker/main.go.
func Load() (*Config, error) {
	return load(osEnv())
}

// load builds a Config from an in-memory environment map. Split out from
// Load so tests can exercise validation without touching process env vars.
func load(env map[string]string) (*Config, error) {
	var errs []error

	get := func(name string) string {
		v, err := requiredVar(env, name)
		if err != nil {
			errs = append(errs, err)
		}
		return v
	}

	// Reads MODE the same way Config.IsDev does, but before the Config exists
	// — the mode has to be known to decide which variables are required.
	dev := env["MODE"] != "production"
	requiredInProduction := func(name string) string {
		if dev {
			return env[name]
		}
		return get(name)
	}

	cfg := &Config{
		DatabaseURL:            get("DATABASE_URL"),
		SupabaseURL:            get("SUPABASE_URL"),
		SupabaseServiceRoleKey: get("SUPABASE_SERVICE_ROLE_KEY"),
		// Required in production, optional in development — and that
		// asymmetry is a safety feature, not a convenience.
		//
		// A development worker never reaches kie: the render is mocked before
		// any client is constructed. Demanding the key anyway does not make
		// anything safer; it makes the worker refuse to boot until somebody
		// pastes a REAL production key into a local config, which is how a
		// live credential ends up in a file whose whole purpose is that it
		// touches nothing. This project has already lost money twice to a
		// local run that turned out not to be local.
		//
		// Production still refuses to start without it, which is the case
		// that matters: a production worker with no key would claim rows,
		// fail every submission, and burn the retry budget on scenes it was
		// never able to render.
		KieAPIKey:  requiredInProduction("KIE_API_KEY"),
		AppBaseURL: get("APP_BASE_URL"),
		// Optional — not read through get(). See KieWebhookSecret's own doc
		// comment for why an unset secret is a legitimate (if degraded)
		// state rather than a reason to refuse to boot.
		KieWebhookSecret: env["KIE_WEBHOOK_SECRET"],
		// Optional; see BytePlusAPIKey's doc comment.
		BytePlusAPIKey: strings.TrimSpace(env["BYTEPLUS_API_KEY"]),
		BytePlusModel:  strings.TrimSpace(env["BYTEPLUS_MODEL"]),
		BytePlusRoute:  strings.TrimSpace(env["BYTEPLUS_ROUTE"]) != "0",
	}

	if v, err := positiveIntVar(env, "BYTEPLUS_MAX_INFLIGHT", 3); err != nil {
		errs = append(errs, err)
	} else {
		cfg.BytePlusMaxInflight = v
	}

	if cfg.KieWebhookSecret == "" {
		// See Warnings' doc comment. Says the consequence, not just the
		// missing variable — "KIE_WEBHOOK_SECRET is unset" tells an
		// operator nothing about what it costs them.
		cfg.Warnings = append(cfg.Warnings,
			"KIE_WEBHOOK_SECRET is unset: /webhooks/kie rejects every callback, "+
				"so a finished kie render is noticed only by the reconcile poll, 45-90s late. "+
				"Generate a webhookHmacKey in kie's settings and set it here to turn the fast path on.")
	}

	// Every flag above is "1" or nothing. That is fine until someone writes
	// the word — ASSEMBLE_ENABLED=true reads as on to a human and parses as
	// off here, and the only evidence is a feature quietly not happening.
	// worker/.env shipped with ASSEMBLE_ENABLED=false, one edit away from
	// exactly that. Warn rather than fail: the value is unambiguous about
	// INTENT, so refusing to boot over it would be the worse trade.
	for _, name := range []string{
		"ASSEMBLE_ENABLED", "AUDIO_ENABLED",
	} {
		switch strings.ToLower(env[name]) {
		case "true", "yes", "on", "enabled":
			cfg.Warnings = append(cfg.Warnings, fmt.Sprintf(
				"%s=%q is being read as OFF: this flag is on only when it is exactly \"1\". "+
					"Set %s=1 if you meant to turn it on.", name, env[name], name))
		}
	}

	if v, err := positiveIntVar(env, "RENDER_CONCURRENCY", 10); err != nil {
		errs = append(errs, err)
	} else {
		cfg.RenderConcurrency = v
	}

	if v, err := positiveIntVar(env, "FFMPEG_CONCURRENCY", 2); err != nil {
		errs = append(errs, err)
	} else {
		cfg.FFmpegConcurrency = v
	}

	if v, err := positiveIntVar(env, "PORT", 8080); err != nil {
		errs = append(errs, err)
	} else if v > 65535 {
		errs = append(errs, fmt.Errorf("config: environment variable PORT must be at most 65535, got %d", v))
	} else {
		cfg.Port = v
	}

	cfg.Mode = parseMode(env["MODE"])
	cfg.AssembleEnabled = env["ASSEMBLE_ENABLED"] == "1"
	cfg.AudioEnabled = env["AUDIO_ENABLED"] == "1"

	if v, err := positiveIntVar(env, "RECONCILE_GIVE_UP_AFTER_MINUTES", 30); err != nil {
		errs = append(errs, err)
	} else {
		cfg.ReconcileGiveUpAfter = time.Duration(v) * time.Minute
	}

	if len(errs) > 0 {
		return nil, joinErrors(errs)
	}
	return cfg, nil
}

// joinErrors combines multiple config errors into one, reporting every
// missing/invalid variable at once rather than failing on the first.
func joinErrors(errs []error) error {
	msg := "config: invalid configuration:"
	for _, e := range errs {
		msg += "\n  - " + e.Error()
	}
	return fmt.Errorf("%s", msg)
}

func osEnv() map[string]string {
	env := make(map[string]string)
	for _, kv := range os.Environ() {
		for i := 0; i < len(kv); i++ {
			if kv[i] == '=' {
				env[kv[:i]] = kv[i+1:]
				break
			}
		}
	}
	return env
}
