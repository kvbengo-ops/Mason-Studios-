package loop

import (
	"context"
	"log/slog"
	"time"

	"ugc-pipeline/worker/internal/config"
	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/media"
	"ugc-pipeline/worker/internal/store"
)

// Store is the slice of *store.Store this package's dispatch/reconcile/
// assemble loops call — one interface, not one per loop, because Deps is
// genuinely shared across all three and a single seam is what lets a test
// hand any of them a fake *store.Store and assert exactly what it was
// asked to write, instead of needing a live Postgres to observe anything
// at all. *store.Store satisfies it below.
type Store interface {
	ClaimQueuedScenes(ctx context.Context, ceiling int) ([]store.Scene, error)
	MarkRendering(ctx context.Context, sceneID, kieTaskID string) error
	MarkDone(ctx context.Context, sceneID string, asset store.Asset, run store.Run) error
	MarkFailed(ctx context.Context, sceneID string, run store.Run) error
	InsertAsset(ctx context.Context, asset store.Asset) (string, error)
	InsertRun(ctx context.Context, run store.Run) error
	InsertFinalAsset(ctx context.Context, asset store.Asset) (string, error)
	StaleRendering(ctx context.Context, olderThan time.Duration) ([]store.Scene, error)
	SceneByKieTaskID(ctx context.Context, requestID string) (*store.Scene, error)
	SceneClipsForProject(ctx context.Context, projectID string) ([]store.Asset, *time.Time, error)
	ClaimPendingFinalVersions(ctx context.Context, limit int) ([]store.PendingFinalVersion, error)
	ClipsForRecipe(ctx context.Context, projectID string, recipe []store.FinalVersionRecipeEntry) ([]store.Asset, *time.Time, error)
	MarkFinalVersionBuilt(ctx context.Context, versionID, projectID, finalAssetID string, posterAssetID *string) error
	MarkFinalVersionFailed(ctx context.Context, versionID, reason string) error
	ReleaseStaleFinalVersionLeases(ctx context.Context, olderThan time.Duration) (int64, error)
	CaptionScenesForProject(ctx context.Context, projectID string) ([]store.CaptionScene, error)
	CaptionStyleForProject(ctx context.Context, projectID string) (store.CaptionStyle, error)
	RefFrameURL(ctx context.Context, sceneID string) (string, error)
	// ReferencesForScene returns every asset the scene submits, in vendor
	// order (0071's scene_references), falling back to the single
	// RefFrameURL above for scenes that predate that table — which is every
	// scripted-pipeline scene.
	ReferencesForScene(ctx context.Context, sceneID string) ([]store.SceneReference, error)
}

// _ pins that *store.Store still satisfies Store above. Without it, a
// signature drift in any one of the 19 methods above would surface as a
// confusing error at whatever call site constructs a Deps, rather than
// right here where the seam is declared.
var _ Store = (*store.Store)(nil)

// Deps bundles what every loop needs. Follow-up agents extend this with
// whatever else they need to hang off it rather than changing individual
// loop function signatures.
type Deps struct {
	Store  Store
	Config *config.Config
	Logger *slog.Logger

	// Balance closes the dispatch loop after kie refuses a submission for
	// lack of funds, and reopens it on a backoff so a top-up resumes
	// rendering without a restart. Optional: a nil gate never blocks, which
	// is what keeps every existing Deps literal valid. See balance_gate.go
	// for why this cannot instead be a balance check or an un-claim.
	Balance *BalanceGate

	// Media runs ffmpeg (normalize + concat), bounded by
	// Config.FFmpegConcurrency. Used by Reconcile (normalizing a render the
	// webhook never got to via internal/ingest) and Assemble (final
	// concat). The webhook handler (internal/http) holds its own
	// media.Runner directly rather than through Deps, since it isn't a
	// loop.Every-driven loop.
	Media *media.Runner

	// Kie submits/polls renders on kie.ai — the only video vendor this
	// worker speaks to; fal.ai is decommissioned. Always non-nil in a real
	// Deps (cmd/worker/main.go constructs it unconditionally, since
	// KieAPIKey is now a required config var — see config.Config.KieAPIKey).
	// Kept as the VideoVendor interface below, not *kie.Client, purely so
	// tests can hand dispatch/reconcile a fake without a real kie.Client.
	Kie VideoVendor
}

// VideoVendor is the seam between loop's dispatch/reconcile and
// internal/kie's HTTP client: submit a render, poll its status, fetch its
// completed result. Expressed in terms of kie.SubmitRequest/kie.Status/
// kie.Result — types that live in package kie because kie is the only
// vendor this worker has ever needed to describe a render request to.
//
// This interface exists purely for tests: dispatch_test.go and
// reconcile_test.go hand it a fake VideoVendor instead of a real
// *kie.Client, the same reason Store above is an interface. There is only
// one real implementation — see the pin below.
type VideoVendor interface {
	Submit(ctx context.Context, req kie.SubmitRequest) (string, error)
	Status(ctx context.Context, requestID string) (kie.Status, error)
	Result(ctx context.Context, requestID string) (kie.Result, error)
	BilledUSD(ctx context.Context, requestID string) (*float64, error)
}

// _ pins that *kie.Client satisfies VideoVendor — Deps.Kie is passed to
// dispatch.go/reconcile.go exactly as it is, with no wrapper type, so a
// signature drift on kie.Client's Submit/Status/Result would otherwise only
// surface as a confusing error at whatever call site uses deps.Kie rather
// than here.
var _ VideoVendor = (*kie.Client)(nil)
