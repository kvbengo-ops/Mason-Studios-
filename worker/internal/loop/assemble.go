package loop

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	"ugc-pipeline/worker/internal/store"
)

// downloadTimeout bounds fetching one already-normalized clip back out of
// Supabase Storage for the final concat.
const downloadTimeout = 120 * time.Second

// assembleBatchLimit is how many pending final versions one tick claims.
// One, deliberately: the builds below run serially in this goroutine
// anyway, so claiming five would not build them any sooner — it would only
// widen the window in which four claimed-but-unbuilt rows are still
// claimable by another instance (see ClaimPendingFinalVersions' note on
// what the claim can and cannot guarantee).
const assembleBatchLimit = 1

// Assemble runs every 30s: claims final_versions rows that are asking to be
// built, concatenates the clips their recipe names with ffmpeg, and uploads
// the result. See docs/architecture.md § "ffmpeg" — each clip was already
// normalized on arrival (webhook/reconcile via internal/ingest), so the
// concat here is a cheap `-c copy` stream copy.
//
// Since 0060_final_versions.sql the trigger is a ROW, not an absence. This
// used to ask "does this project lack a 'final' asset", which meant the only
// way to request a rebuild was to delete the previous final — so every
// re-assemble destroyed the cut before it. An operator now inserts a
// final_versions row and this loop claims it.
//
// Gated behind Config.AssembleEnabled (ASSEMBLE_ENABLED, default off):
// whether the client wants an assembled mp4 at all, vs. raw clips, is an
// open product question (see docs/roadmap.md). When disabled this must be
// silent — a disabled feature logging every 30s forever is just noise.
func Assemble(ctx context.Context, deps Deps) error {
	if !deps.Config.AssembleEnabled {
		return nil
	}

	versions, err := deps.Store.ClaimPendingFinalVersions(ctx, assembleBatchLimit)
	if err != nil {
		return fmt.Errorf("assemble: claim pending final versions: %w", err)
	}

	for _, version := range versions {
		assembleVersion(ctx, deps, version)
	}
	return nil
}

// assembleVersion builds one claimed final version: resolve its clips,
// concatenate them, upload under that version's own key, and record the
// outcome on the row. Errors are recorded and skipped rather than aborting
// the whole batch — one broken version must not block every other project's
// delivery.
//
// Every failure path here ends at failVersion rather than a bare return.
// A bare return is what the pre-0060 code did, and it was survivable only
// because the absence of a 'final' asset meant "try again next tick"
// forever; with a row as the request, the same silence would leave that row
// pending and re-attempted every 30s with nothing anywhere saying why.
func assembleVersion(ctx context.Context, deps Deps, version store.PendingFinalVersion) {
	projectID := version.ProjectID
	logger := deps.Logger.With(
		slog.String("project_id", projectID),
		slog.String("final_version_id", version.ID),
		slog.Int("final_version_n", version.N),
	)

	clips, cutOrderUpdatedAt, err := clipsForVersion(ctx, deps, logger, version)
	if err != nil {
		failVersion(ctx, deps, logger, version, "list clips failed", err)
		return
	}
	if len(clips) == 0 {
		// Not "try again later": the readiness rule already established every
		// scene is terminal, so no clip is ever going to appear for this
		// recipe. Recording it is what keeps the row from being re-claimed
		// every 30s forever with nothing saying why it never produced a file.
		failVersion(ctx, deps, logger, version, "no clips to assemble", errNoClips)
		return
	}
	if n := len(version.Recipe); n > 0 && len(clips) < n {
		// Expected, not broken: the readiness rule admits 'failed' scenes,
		// and a scene version whose render failed has no clip to contribute.
		// Logged loudly all the same, because it is also what a recipe
		// naming a pruned or foreign scene version looks like, and the two
		// are indistinguishable from here.
		logger.Warn("assemble: recipe names more scene versions than there are clips, cutting the ones that resolved",
			slog.Int("recipe_len", n), slog.Int("clip_count", len(clips)))
	}

	localPaths, cleanup, err := downloadClips(ctx, deps, clips)
	defer cleanup()
	if err != nil {
		failVersion(ctx, deps, logger, version, "download clips failed", err)
		return
	}

	outFile, err := os.CreateTemp("", "ugc-final-*.mp4")
	if err != nil {
		failVersion(ctx, deps, logger, version, "create output temp file failed", err)
		return
	}
	outPath := outFile.Name()
	outFile.Close()
	defer os.Remove(outPath)

	if err := deps.Media.Concat(ctx, localPaths, outPath); err != nil {
		failVersion(ctx, deps, logger, version, "ffmpeg concat failed", err)
		return
	}

	// Captions required fal-ai/whisper transcription
	// (fal-ai/whisper), deleted when fal was
	// decommissioned — see that package's own doc comment. There is no
	// replacement transcription vendor, so this step is skipped entirely
	// rather than kept as a permanently-disabled flag: CAPTIONS_ENABLED has
	// never been true in production (config.Config.CaptionsEnabled's doc
	// comment), so nothing observable changes for any deployment. The
	// chunk/measure/ass-rendering machinery this used to drive
	// (the chunk/measure/ASS machinery,
	// media.Runner.BurnCaptions) has no fal dependency and is left in
	// place, dormant, for whenever a replacement transcription vendor
	// supplies word timings from somewhere else.
	uploadPath := outPath

	f, err := os.Open(uploadPath)
	if err != nil {
		failVersion(ctx, deps, logger, version, "open concatenated file failed", err)
		return
	}
	defer f.Close()

	// Keyed by version id, not the old fixed final.mp4: UploadObject
	// upserts, so a fixed key would overwrite the object every OLDER
	// version's row still points at, and v1 would silently start playing
	// v3. See StorageKeyForFinal.
	storageKey := store.StorageKeyForFinal(projectID, version.ID, "mp4")
	if err := store.UploadObject(ctx, deps.Config, "media", storageKey, f, "video/mp4"); err != nil {
		failVersion(ctx, deps, logger, version, "upload final asset failed", err)
		return
	}

	info, statErr := os.Stat(uploadPath)
	var bytesOut *int64
	if statErr == nil {
		n := info.Size()
		bytesOut = &n
	}

	finalAssetID, err := deps.Store.InsertFinalAsset(ctx, finalAssetFor(projectID, storageKey, bytesOut, cutOrderUpdatedAt))
	if err != nil {
		failVersion(ctx, deps, logger, version, "record final asset failed", err)
		return
	}

	// Poster extraction happens after the final asset commits, and its
	// failures are swallowed rather than propagated: the assembled video is
	// durably recorded and delivered at this point regardless of what
	// happens next — see internal/ingest's identical treatment of a clip's
	// poster and media.Runner.ExtractPoster's doc comment. uploadPath is
	// still on disk — its cleanup is deferred above (or, when captioning
	// never ran, outPath's own cleanup covers it, since they're the same
	// file). A nil poster id is therefore an ordinary outcome, not an error.
	posterAssetID := extractAndStoreFinalPoster(ctx, deps, logger, projectID, version.ID, uploadPath)

	// Marking built is what takes the row off the queue, and it also makes
	// this version the project's active one — see MarkFinalVersionBuilt for
	// why the worker moves that pointer rather than leaving it to whoever
	// asked. Failing here is NOT failVersion: the video is built, uploaded
	// and recorded as an asset, so calling the version failed would be a
	// lie. Leave it pending and loud; the next tick re-claims it, and the
	// worst case is one wasted rebuild that lands on the same storage key.
	if err := deps.Store.MarkFinalVersionBuilt(ctx, version.ID, projectID, finalAssetID, posterAssetID); err != nil {
		logger.Error("assemble: record final version outcome failed, version stays pending",
			slog.String("error", err.Error()))
		return
	}

	logger.Info("assemble: assembled final video", slog.Int("clip_count", len(clips)))
}

// errNoClips names the one failure above that has no underlying error to
// quote — it is a conclusion this function reached, not something that was
// returned to it — so that failVersion's message format stays uniform.
var errNoClips = errors.New("every scene in this cut is terminal and none produced a clip")

// clipsForVersion resolves the clips this version's cut is made of.
//
// The RECIPE is the source of truth, not the project's current state: that
// is the entire point of versioning. SceneClipsForProject answers "what
// would this project cut to right now", so rebuilding v1 through it would
// produce whatever the project looks like today — a v1 that changes every
// time a scene is re-rendered is not a version, it is a live view.
//
// The fallback is only for an EMPTY recipe, which 0060's backfill can
// legitimately produce (it reconstructs the recipe from the current scene
// order, and a project with no scenes rows gets '[]'). For those rows there
// is nothing to rebuild from, so today's project-state read is the best
// available answer — and strictly better than refusing to build at all,
// which would strand an already-delivered final.
func clipsForVersion(ctx context.Context, deps Deps, logger *slog.Logger, version store.PendingFinalVersion) ([]store.Asset, *time.Time, error) {
	if len(version.Recipe) == 0 {
		logger.Warn("assemble: final version has an empty recipe, falling back to the project's current cut")
		return deps.Store.SceneClipsForProject(ctx, version.ProjectID)
	}
	return deps.Store.ClipsForRecipe(ctx, version.ProjectID, version.Recipe)
}

// failVersion is assemble's give-up, the counterpart to reconcile.go's
// giveUp and worded the same way: reasonPrefix names the step that failed
// and cause's own text is appended verbatim, so the operator sees the real
// error rather than just "failed".
//
// Unlike giveUp there is no grace period before it fires. A stuck scene had
// a paid render behind it and a retry that costs nothing, so reconcile
// waits; a final version has neither. Nothing is destroyed by failing one —
// the row, the recipe and every clip survive — and re-requesting is a
// single INSERT, which is exactly the shape 0060 gave this. Retrying
// silently forever is the failure this avoids: a row that never builds and
// never says why, re-attempted every 30s.
func failVersion(ctx context.Context, deps Deps, logger *slog.Logger, version store.PendingFinalVersion, reasonPrefix string, cause error) {
	reason := fmt.Sprintf("%s: %s", reasonPrefix, cause.Error())
	logger.Error("assemble: "+reasonPrefix, slog.String("error", cause.Error()))

	if err := deps.Store.MarkFinalVersionFailed(ctx, version.ID, reason); err != nil {
		// The row stays pending and will be re-attempted. Logged rather than
		// escalated: the build already failed, and failing to write down WHY
		// it failed must not also take down the batch.
		logger.Error("assemble: recording final version failure failed",
			slog.String("error", err.Error()))
	}
}

// finalAssetFor builds the store.Asset InsertFinalAsset receives, carrying
// cutOrderUpdatedAt — the cut order timestamp SceneClipsForProject read in
// the SAME query as clips (COALESCE(cut_order_updated_at, now()), so it's
// the clip-read time itself when the project had never been reordered, or
// the reorder's own timestamp otherwise — see that function's doc comment
// and 0043_built_from_cut_order_at_no_null_on_write.sql) — straight through
// onto BuiltFromCutOrderAt. Split out purely so this plumbing is testable
// without a live *store.Store, mirroring internal/store's own
// sceneStatusesReadyToAssemble split (same file, same reasoning: this
// package has no local Postgres to run the real query/insert against).
//
// Deliberately does not touch cutOrderUpdatedAt beyond passing it through:
// this function has no way to tell "clip-read fallback" from "an actual
// reorder" apart, nor does it need to — SceneClipsForProject already
// resolved that. The one case finalAssetFor accepts nil for is a caller
// passing it directly (e.g. a future no-clips guard); it is not a value
// SceneClipsForProject itself produces when clips exist.
func finalAssetFor(projectID, storageKey string, bytesOut *int64, cutOrderUpdatedAt *time.Time) store.Asset {
	return store.Asset{
		ProjectID:           projectID,
		Kind:                "final",
		StorageKey:          storageKey,
		Bytes:               bytesOut,
		BuiltFromCutOrderAt: cutOrderUpdatedAt,
	}
}

// extractAndStoreFinalPoster is assemble's counterpart to internal/ingest's
// per-clip poster extraction: same ffmpeg call, same best-effort handling
// (ffmpeg, upload, or DB failures are logged and swallowed, never
// returned), applied to the assembled final instead of one scene's clip.
//
// Returns the poster asset's id, or nil if any step failed — nil is an
// ordinary outcome that the caller stores as final_versions.poster_asset_id
// unchanged, which is the "built, no poster" state 0060 allows for.
func extractAndStoreFinalPoster(ctx context.Context, deps Deps, logger *slog.Logger, projectID, finalVersionID, finalPath string) *string {
	posterFile, err := os.CreateTemp("", "ugc-poster-*.jpg")
	if err != nil {
		logger.Warn("assemble: create poster temp file failed", slog.String("error", err.Error()))
		return nil
	}
	posterPath := posterFile.Name()
	posterFile.Close()
	defer os.Remove(posterPath)

	if err := deps.Media.ExtractPoster(ctx, finalPath, posterPath); err != nil {
		logger.Warn("assemble: extract poster failed", slog.String("error", err.Error()))
		return nil
	}

	f, err := os.Open(posterPath)
	if err != nil {
		logger.Warn("assemble: open poster failed", slog.String("error", err.Error()))
		return nil
	}
	defer f.Close()

	storageKey := store.StorageKeyForFinalPoster(projectID, finalVersionID, "jpg")
	if err := store.UploadObject(ctx, deps.Config, "media", storageKey, f, "image/jpeg"); err != nil {
		logger.Warn("assemble: upload poster failed", slog.String("error", err.Error()))
		return nil
	}

	info, statErr := os.Stat(posterPath)
	var bytesOut *int64
	if statErr == nil {
		n := info.Size()
		bytesOut = &n
	}

	posterAssetID, err := deps.Store.InsertAsset(ctx, store.Asset{
		ProjectID:  projectID,
		Kind:       "poster",
		StorageKey: storageKey,
		Bytes:      bytesOut,
	})
	if err != nil {
		logger.Warn("assemble: record poster asset failed", slog.String("error", err.Error()))
		return nil
	}
	return &posterAssetID
}

// downloadClips fetches every clip asset's storage object to a local temp
// file, in the order given (already scene-idx order from
// SceneClipsForProject), so Concat's input list matches final playback
// order. The returned cleanup func removes every temp file created so far
// and must be called (via defer) on every path, including partial failure.
func downloadClips(ctx context.Context, deps Deps, clips []store.Asset) ([]string, func(), error) {
	var paths []string
	cleanup := func() {
		for _, p := range paths {
			os.Remove(p)
		}
	}

	for _, clip := range clips {
		signedURL, err := store.SignedURL(ctx, nil, deps.Config.SupabaseURL, deps.Config.SupabaseServiceRoleKey, clip.StorageKey, signedURLExpiry)
		if err != nil {
			return paths, cleanup, fmt.Errorf("sign %s: %w", clip.StorageKey, err)
		}

		path, err := downloadToTemp(ctx, signedURL)
		if err != nil {
			return paths, cleanup, fmt.Errorf("download %s: %w", clip.StorageKey, err)
		}
		paths = append(paths, path)
	}
	return paths, cleanup, nil
}

// downloadToTemp copies url to a local temp file and returns its path.
// Deliberately separate from internal/ingest's copy of this logic: that
// one exists to satisfy the "copy fal's expiring URL immediately" webhook
// rule, this one just re-fetches our own already-durable storage object,
// so there is no shared-ness worth coupling the two packages over.
func downloadToTemp(ctx context.Context, url string) (string, error) {
	reqCtx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}

	httpClient := &http.Client{Timeout: downloadTimeout}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}

	f, err := os.CreateTemp("", "ugc-assemble-clip-*.mp4")
	if err != nil {
		return "", fmt.Errorf("create temp file: %w", err)
	}
	defer f.Close()

	if _, err := io.Copy(f, resp.Body); err != nil {
		os.Remove(f.Name())
		return "", fmt.Errorf("write temp file: %w", err)
	}
	return f.Name(), nil
}

// ---------------------------------------------------------------------------
// captions
// ---------------------------------------------------------------------------
//
// captionOrFallback, buildCaptionTrack, and recordCaptionRun used to live
// here: transcribe every eligible scene via fal-ai/whisper
// (internal/captions.TranscribeScene), align the result onto script_line,
// chunk and burn it onto the assembled final with ffmpeg's ass/libass
// filter. All three are DELETED — not merely disabled — now that fal is
// decommissioned and there is no replacement transcription vendor; see
// this file's own captionOrFallback for the full
// accounting of what moved where. assembleProject's call site (above) now
// sets uploadPath := outPath directly instead of calling captionOrFallback.
//
// finalVideoWidth/finalVideoHeight (1080x1920, matching
// internal/media.Runner.Normalize's fixed scale target) went with them:
// they existed only to size captionOrFallback's ASS canvas.
//
// the chunk/measure/ass/align machinery
// (BuildChunks/NewMeasurer/GenerateASS/EnsureFontsDir, and
// media.Runner.BurnCaptions) has no fal dependency and needed no changes
// here — it is dormant infrastructure, not deleted code, for whenever a
// replacement transcription vendor supplies word timings again.
