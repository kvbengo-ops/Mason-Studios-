// Package ingest is the one place a completed kie render turns into a
// stored asset and a 'done' scene. Both the webhook handler (the fast
// path) and the reconcile loop (the correct path — see
// docs/architecture.md § "Reconcile — webhooks get lost") end up here, so
// this is the function that must not drift between the two: whichever one
// resolves a render first runs the exact same download -> normalize ->
// upload -> MarkDone sequence.
package ingest

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	"ugc-pipeline/worker/internal/config"
	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/media"
	"ugc-pipeline/worker/internal/store"
)

// downloadTimeout bounds fetching the clip from kie's (expiring) result
// URL. Clips are ~8s of 1080p video, a few MB — generous, not tight.
const downloadTimeout = 120 * time.Second

// Store is the slice of *store.Store this package actually calls —
// MarkDone on FromResult's critical path, InsertAsset on the best-effort
// poster tail. It exists so tests can hand FromResult a fake and assert
// exactly what it wrote (which scene, which cost, which storage key)
// instead of needing a live Postgres to observe anything at all; see
// fromresult_test.go. *store.Store satisfies it below.
type Store interface {
	MarkDone(ctx context.Context, sceneID string, asset store.Asset, run store.Run) error
	InsertAsset(ctx context.Context, asset store.Asset) (string, error)
}

// _ pins that *store.Store still satisfies Store above. Without it, a
// signature drift in store.MarkDone/InsertAsset would surface as a
// confusing error at whatever call site constructs a Deps, rather than
// right here where the seam is declared.
var _ Store = (*store.Store)(nil)

// Deps bundles what Ingest needs, independent of loop.Deps / the http
// package's Server, so it can be called from either without either
// importing the other.
type Deps struct {
	Store  Store
	Config *config.Config
	Media  *media.Runner
	// Logger is used only for the best-effort poster extraction tail step
	// (see extractAndStorePoster) — everything on FromResult's critical path
	// returns errors to its caller instead of logging directly, per the rest
	// of this file. Both call sites (internal/http's webhook handler and
	// internal/loop/reconcile) already hold a *slog.Logger, so this is
	// never nil in practice.
	Logger *slog.Logger
}

// FromResult ingests a completed kie render for scene: downloads
// result.VideoURL immediately (kie result URLs expire — this is the only
// copy that will ever exist if we don't), normalizes it with ffmpeg,
// uploads the normalized clip to Supabase Storage, and records it with
// store.MarkDone (asset + run + scene -> 'done', all one transaction).
//
// Callers MUST check that scene.Status != "done" before calling this —
// idempotency is enforced at the call site (per store.MarkDone's doc
// comment), not here, so that a duplicate webhook delivery or a reconcile
// pass racing a webhook can skip the download/ffmpeg work entirely instead
// of doing it and then discovering MarkDone's backstop guard rejected the
// write.
//
// There is no vendor parameter here any more. Before fal.ai was
// decommissioned, this function took one (fal.Vendor) because it had no
// reliable way to know which of two vendors actually ran the render — the
// resolved Model carried only a compile-time DEFAULT vendor, and the
// caller (which knew structurally, from which webhook route fired, or from
// the routing decision it had already resolved) was the only trustworthy
// source. Today runs.vendor is read off the persisted task id itself
// (kie.VendorOf): kie, or BytePlus for a Seedance 2.5 render routed there —
// a fact the id carries, so no caller has to pass it. See internal/http/webhook_kie.go and
// internal/loop/reconcile.go's ingest call sites, neither of which passes
// anything here any more.
func FromResult(ctx context.Context, deps Deps, scene store.Scene, result kie.Result) error {
	// Billing must use the resolution the clip was actually rendered at —
	// a 1080P Seedance render costs ~4x its 480P tier, and `runs.cost_usd`
	// is the only record of where a month's budget went (docs/architecture.md
	// § "Schema").
	settings, err := kie.ParseRenderSettings(scene.RenderSettings)
	if err != nil {
		return err
	}
	model, err := kie.PickModel(scene.IsTalkingHead, deps.Config.AudioEnabled, settings)
	if err != nil {
		return err
	}

	durationSeconds := result.DurationSeconds
	if durationSeconds <= 0 {
		durationSeconds = scene.DurationS
	}
	cost, costKnown := kie.EstimateCost(model, durationSeconds)
	// A vendor-reported charge beats our own estimate whenever one exists —
	// see kie.Result.ActualCostUSD's doc comment (types.go). kie.Client.Result
	// sets this from recordInfo's creditsConsumed whenever the response
	// carries one.
	if result.ActualCostUSD != nil {
		cost = *result.ActualCostUSD
		costKnown = true
	}
	// A mocked render reached no vendor and was billed nothing, so the
	// ledger must say nothing — not the estimate it would have cost.
	//
	// Recording the estimate made every local test session spend real
	// budget on paper: the spend caps sum runs.cost_usd, so a morning of
	// clicking through a mocked pipeline hit the team-wide daily ceiling and
	// refused the very flow being tested, while /spend reported dollars
	// nobody was charged. The caps and the ledger both read this column;
	// both were being told the same untruth.
	if deps.Config.IsDev() {
		cost = 0
		costKnown = true
	}
	if !costKnown {
		// Should be unreachable — see kie.EstimateCost's own doc comment.
		// Logged loudly and left costPtr nil below rather than writing a
		// fabricated number: unknown must never become zero or a guess
		// outside of the deliberate MODE=development override above.
		deps.Logger.Error("ingest: cost estimate unavailable; no rate for this model at this audio tier",
			slog.String("scene_id", scene.ID),
			slog.Bool("has_audio", model.HasAudio),
			slog.String("reason", kie.MissingRateReason(model)))
	}
	var costPtr *float64
	if costKnown {
		costPtr = &cost
	}

	var latencyMS int
	if scene.SubmittedAt != nil {
		latencyMS = int(time.Since(*scene.SubmittedAt).Milliseconds())
	}

	inPath, err := downloadToTemp(ctx, result.VideoURL)
	if err != nil {
		return fmt.Errorf("ingest: scene %s: %w", scene.ID, err)
	}
	defer os.Remove(inPath)

	outFile, err := os.CreateTemp("", "ugc-normalized-*.mp4")
	if err != nil {
		return fmt.Errorf("ingest: scene %s: create output temp file: %w", scene.ID, err)
	}
	outPath := outFile.Name()
	outFile.Close()
	defer os.Remove(outPath)

	if err := deps.Media.Normalize(ctx, inPath, outPath, model.AspectRatio); err != nil {
		return fmt.Errorf("ingest: scene %s: %w", scene.ID, err)
	}

	f, err := os.Open(outPath)
	if err != nil {
		return fmt.Errorf("ingest: scene %s: open normalized clip: %w", scene.ID, err)
	}
	defer f.Close()

	// The attempt id is required, not optional. Both paths into ingest resolve
	// the scene BY its kie task id, so an empty one here means something has
	// changed upstream — and the old behaviour on empty would be a key shared
	// with every other render of this scene, which is the bug this replaced.
	// Better to fail the ingest than to overwrite a clip somebody paid for.
	attemptID := ""
	if scene.KieTaskID != nil {
		attemptID = *scene.KieTaskID
	}
	if attemptID == "" {
		return fmt.Errorf("ingest: scene %s: no kie task id, refusing to write a clip key shared with every other attempt", scene.ID)
	}

	storageKey := store.StorageKeyForClip(scene.ProjectID, scene.ID, attemptID, "mp4")
	if err := store.UploadObject(ctx, deps.Config, "media", storageKey, f, "video/mp4"); err != nil {
		return fmt.Errorf("ingest: scene %s: %w", scene.ID, err)
	}

	info, err := os.Stat(outPath)
	var bytesOut *int64
	if err == nil {
		n := info.Size()
		bytesOut = &n
	}

	asset := store.Asset{
		ProjectID:  scene.ProjectID,
		Kind:       "clip",
		StorageKey: storageKey,
		DurationS:  &durationSeconds,
		Bytes:      bytesOut,
	}
	vendor := kie.Vendor
	if scene.KieTaskID != nil {
		// A Seedance 2.5 render may have run on BytePlus — the persisted id's
		// prefix says which (kie.VendorOf).
		vendor = kie.VendorOf(*scene.KieTaskID)
	}
	run := store.Run{
		// Both callers resolve this scene by the kie request whose result is
		// being ingested, so this is the immutable per-attempt id that belongs
		// beside the cost below, not a later lookup after a retry.
		KieTaskID: scene.KieTaskID,
		Vendor:    vendor,
		Model:     model.KieModelID,
		CostUSD:   costPtr,
		LatencyMS: &latencyMS,
		// InferenceMS is left nil on every kie render — see kie.Result's own
		// doc comment (types.go) for why kie has no equivalent of fal's
		// metrics.inference_time.
		InferenceMS: result.InferenceMS,
	}

	if err := deps.Store.MarkDone(ctx, scene.ID, asset, run); err != nil {
		return fmt.Errorf("ingest: scene %s: mark done: %w", scene.ID, err)
	}

	// Poster extraction happens after MarkDone commits, and its failures are
	// swallowed here rather than returned: the clip is durably recorded and
	// delivered at this point regardless of what happens next, and a missing
	// poster must never fail or retry an otherwise-successful render (see
	// media.Runner.ExtractPoster's doc comment). outPath is still on disk —
	// its cleanup is deferred to FromResult's return, not this point.
	extractAndStorePoster(ctx, deps, scene, outPath)

	return nil
}

// extractAndStorePoster produces a poster frame from clipPath (the
// already-normalized 1080x1920 clip at outPath in FromResult above) and
// stores it as a 'poster' asset tied to scene. Every failure — ffmpeg, the
// upload, or the asset insert — is logged and swallowed rather than
// returned; see FromResult's call site for why.
func extractAndStorePoster(ctx context.Context, deps Deps, scene store.Scene, clipPath string) {
	logger := deps.Logger.With(slog.String("scene_id", scene.ID))

	posterFile, err := os.CreateTemp("", "ugc-poster-*.jpg")
	if err != nil {
		logger.Warn("ingest: create poster temp file failed", slog.String("error", err.Error()))
		return
	}
	posterPath := posterFile.Name()
	posterFile.Close()
	defer os.Remove(posterPath)

	if err := deps.Media.ExtractPoster(ctx, clipPath, posterPath); err != nil {
		logger.Warn("ingest: extract poster failed", slog.String("error", err.Error()))
		return
	}

	f, err := os.Open(posterPath)
	if err != nil {
		logger.Warn("ingest: open poster failed", slog.String("error", err.Error()))
		return
	}
	defer f.Close()

	posterAttemptID := ""
	if scene.KieTaskID != nil {
		posterAttemptID = *scene.KieTaskID
	}
	if posterAttemptID == "" {
		// Warn and skip rather than fail: the poster is best-effort for the
		// whole of this function, and writing nothing is the safe outcome —
		// the alternative is a key shared with every other attempt at this
		// scene, which overwrites a frame somebody paid to produce.
		logger.Warn("ingest: no kie task id, skipping poster", slog.String("scene_id", scene.ID))
		return
	}

	storageKey := store.StorageKeyForPoster(scene.ProjectID, scene.ID, posterAttemptID, "jpg")
	if err := store.UploadObject(ctx, deps.Config, "media", storageKey, f, "image/jpeg"); err != nil {
		logger.Warn("ingest: upload poster failed", slog.String("error", err.Error()))
		return
	}

	info, statErr := os.Stat(posterPath)
	var bytesOut *int64
	if statErr == nil {
		n := info.Size()
		bytesOut = &n
	}

	sceneID := scene.ID
	if _, err := deps.Store.InsertAsset(ctx, store.Asset{
		ProjectID:  scene.ProjectID,
		SceneID:    &sceneID,
		Kind:       "poster",
		StorageKey: storageKey,
		Bytes:      bytesOut,
	}); err != nil {
		logger.Warn("ingest: record poster asset failed", slog.String("error", err.Error()))
	}
}

// downloadToTemp copies url to a local temp file and returns its path. The
// caller owns cleanup. This is the "copy the file immediately" step from
// docs/architecture.md § "Webhook rules": fal's result URL expires, so
// this is the only chance to persist the bytes anywhere durable.
func downloadToTemp(ctx context.Context, url string) (string, error) {
	if url == "" {
		return "", fmt.Errorf("download: empty video url")
	}

	reqCtx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("download %s: build request: %w", url, err)
	}

	httpClient := &http.Client{Timeout: downloadTimeout}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("download %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("download %s: status %d", url, resp.StatusCode)
	}

	f, err := os.CreateTemp("", "ugc-clip-*.mp4")
	if err != nil {
		return "", fmt.Errorf("download %s: create temp file: %w", url, err)
	}
	defer f.Close()

	if _, err := io.Copy(f, resp.Body); err != nil {
		os.Remove(f.Name())
		return "", fmt.Errorf("download %s: write temp file: %w", url, err)
	}
	return f.Name(), nil
}
