package store

import (
	"context"
	"errors"
	"os"
	"testing"
)

// TestMarkDoneTwiceInsertsOneAssetAndRun and TestMarkDoneOnFailedSceneIsRejected
// mirror markfailed_test.go's TestMarkFailedTwiceInsertsOneRun for MarkDone —
// see this repo's history (commit 6ae720b, PR #3) for the original
// MarkFailed fix and MarkDone's own doc comment (store.go) for why the same
// tightening (`WHERE status != 'done'` -> `WHERE status = 'rendering'`) was
// applied here afterward, and why MarkDone's version of the hole was worse:
// a scene already 'failed' could still be flipped to 'done', double-writing
// both a `runs` row (billing the same render twice) and an `assets` row (a
// phantom clip for a scene the operator was already told had failed).
//
// Like markfailed_test.go's test, these have to hit a real Postgres — "the
// second call inserts nothing" is a statement about the transaction rolling
// back when the UPDATE matches no rows, which no fake reproduces — and are
// gated on TEST_DATABASE_URL the same way, so as of this writing THEY HAVE
// NEVER ACTUALLY RUN: nobody has set TEST_DATABASE_URL against a scratch
// database in this environment. That is stated plainly rather than implied,
// per this task's own instruction not to claim untested code is proven.
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/store -run MarkDone

// TestMarkDoneTwiceInsertsOneAssetAndRun pins the guard that keeps a doubly-
// observed completion from being billed and asset-recorded twice. The
// webhook handler and the reconcile loop can both reach MarkDone for the
// same scene as a matter of routine — a webhook landing just after
// reconcile independently ingests the same completed render — and under the
// old `WHERE status != 'done'` guard the second caller would still have
// passed on a scene the first caller had NOT yet moved to 'done' if it
// raced inside the same transaction window; the real-world case this
// guards is simpler still: two calls back-to-back, second one must find
// nothing left to complete.
func TestMarkDoneTwiceInsertsOneAssetAndRun(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping database-backed test")
	}

	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	if err := s.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}

	projectID, sceneID := seedRenderingScene(ctx, t, s)
	var versionID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO scene_versions (scene_id, n) VALUES ($1, 1) RETURNING id`, sceneID).Scan(&versionID); err != nil {
		t.Fatalf("seed scene version: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE scenes SET active_version_id = $2 WHERE id = $1`, sceneID, versionID); err != nil {
		t.Fatalf("activate scene version: %v", err)
	}

	duration := 8.0
	cost := 0.32
	latency := 90000
	requestID := "fal-markdone-request-1"
	asset := Asset{
		ProjectID:  projectID,
		Kind:       "clip",
		StorageKey: "media/markdone-test.mp4",
		DurationS:  &duration,
	}
	run := Run{
		ProjectID: projectID,
		KieTaskID: &requestID,
		Vendor:    "fal",
		Model:     "fal-ai/ltx-video-13b-distilled/image-to-video",
		CostUSD:   &cost,
		LatencyMS: &latency,
	}

	// First caller — the webhook, say — wins and records the clip.
	if err := s.MarkDone(ctx, sceneID, asset, run); err != nil {
		t.Fatalf("first MarkDone: unexpected error: %v", err)
	}

	// Second caller — reconcile racing the same webhook — must find
	// nothing left to complete.
	err = s.MarkDone(ctx, sceneID, asset, run)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("second MarkDone: got %v, want ErrNotFound", err)
	}

	var assetCount int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM assets WHERE scene_id = $1`, sceneID,
	).Scan(&assetCount); err != nil {
		t.Fatalf("count assets: %v", err)
	}
	if assetCount != 1 {
		t.Errorf("assets rows for scene = %d, want 1 (the second call's insert must roll back)", assetCount)
	}
	var linkedClipID, assetID string
	if err := s.pool.QueryRow(ctx, `SELECT clip_asset_id FROM scene_versions WHERE id = $1`, versionID).Scan(&linkedClipID); err != nil {
		t.Fatalf("read version clip: %v", err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT id FROM assets WHERE scene_id = $1 AND kind = 'clip'`, sceneID).Scan(&assetID); err != nil {
		t.Fatalf("read saved clip: %v", err)
	}
	if linkedClipID != assetID {
		t.Errorf("version clip_asset_id = %q, want saved clip %q", linkedClipID, assetID)
	}

	var runCount int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM runs WHERE scene_id = $1`, sceneID,
	).Scan(&runCount); err != nil {
		t.Fatalf("count runs: %v", err)
	}
	if runCount != 1 {
		t.Errorf("runs rows for scene = %d, want 1 (the second call's insert must roll back)", runCount)
	}

	var gotRequestID *string
	if err := s.pool.QueryRow(ctx,
		`SELECT kie_task_id FROM runs WHERE scene_id = $1`, sceneID,
	).Scan(&gotRequestID); err != nil {
		t.Fatalf("read run kie_task_id: %v", err)
	}
	if gotRequestID == nil || *gotRequestID != requestID {
		t.Errorf("runs.kie_task_id = %v, want %q", gotRequestID, requestID)
	}

	var status string
	if err := s.pool.QueryRow(ctx,
		`SELECT status FROM scenes WHERE id = $1`, sceneID,
	).Scan(&status); err != nil {
		t.Fatalf("read scene status: %v", err)
	}
	if status != "done" {
		t.Errorf("scene status = %q, want %q", status, "done")
	}

	// The inbox event is emitted from the same rendering -> done transaction.
	// A duplicate webhook/reconcile completion above must not create a second
	// notification even if a future caller reaches the source transition twice.
	var notificationCount int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM notifications WHERE scene_id = $1 AND kind = 'scene_completed'`, sceneID,
	).Scan(&notificationCount); err != nil {
		t.Fatalf("count scene-completed notifications: %v", err)
	}
	if notificationCount != 1 {
		t.Errorf("scene-completed notifications = %d, want 1", notificationCount)
	}

	var notificationBody, projectKind string
	if err := s.pool.QueryRow(ctx, `
SELECT body, metadata->>'project_kind'
FROM notifications
WHERE scene_id = $1 AND kind = 'scene_completed'`, sceneID).Scan(&notificationBody, &projectKind); err != nil {
		t.Fatalf("read scene-completed notification: %v", err)
	}
	if notificationBody != "Scene 1 is ready to review." || projectKind != "scripted" {
		t.Errorf("scene-completed notification = %q / %q, want scripted Scene 1", notificationBody, projectKind)
	}
}

// TestMarkDoneOnFailedSceneIsRejected is the actual bug this fix closes: a
// scene reconcile (or the webhook handler) already marked 'failed' must
// never be flippable to 'done' by a later-arriving signal for the same
// kie_task_id — a late webhook after reconcile gave up, or a delayed
// reconcile pass after the webhook already failed it. Before this fix,
// `WHERE status != 'done'` let this through: 'failed' satisfies `!= 'done'`
// exactly as well as 'rendering' does, so the second caller would insert a
// second `runs` row (double-billing the same render) AND a phantom `assets`
// row (a clip for a scene the operator was already told had failed).
func TestMarkDoneOnFailedSceneIsRejected(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping database-backed test")
	}

	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	if err := s.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}

	projectID, sceneID := seedRenderingScene(ctx, t, s)

	// First: the render fails (reconcile gives up on it, say).
	failReason := "fal reported status ERROR"
	failCost := 0.42
	failRun := Run{
		ProjectID: projectID,
		Vendor:    "fal",
		Model:     "fal-ai/ltx-video-13b-distilled/image-to-video",
		CostUSD:   &failCost,
		Error:     &failReason,
	}
	if err := s.MarkFailed(ctx, sceneID, failRun); err != nil {
		t.Fatalf("MarkFailed: unexpected error: %v", err)
	}

	// Then: a late-arriving webhook believes the same render actually
	// completed, and tries to mark it done. This must be rejected outright.
	duration := 8.0
	doneCost := 0.32
	asset := Asset{
		ProjectID:  projectID,
		Kind:       "clip",
		StorageKey: "media/markdone-late-webhook-test.mp4",
		DurationS:  &duration,
	}
	doneRun := Run{
		ProjectID: projectID,
		Vendor:    "fal",
		Model:     "fal-ai/ltx-video-13b-distilled/image-to-video",
		CostUSD:   &doneCost,
	}
	err = s.MarkDone(ctx, sceneID, asset, doneRun)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("MarkDone on a failed scene: got %v, want ErrNotFound", err)
	}

	var assetCount int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM assets WHERE scene_id = $1`, sceneID,
	).Scan(&assetCount); err != nil {
		t.Fatalf("count assets: %v", err)
	}
	if assetCount != 0 {
		t.Errorf("assets rows for scene = %d, want 0 (a failed scene must never get a phantom asset)", assetCount)
	}

	var runCount int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM runs WHERE scene_id = $1`, sceneID,
	).Scan(&runCount); err != nil {
		t.Fatalf("count runs: %v", err)
	}
	if runCount != 1 {
		t.Errorf("runs rows for scene = %d, want 1 (only the original failure, not a second billed row)", runCount)
	}

	var status string
	if err := s.pool.QueryRow(ctx,
		`SELECT status FROM scenes WHERE id = $1`, sceneID,
	).Scan(&status); err != nil {
		t.Fatalf("read scene status: %v", err)
	}
	if status != "failed" {
		t.Errorf("scene status = %q, want %q (must not regress to 'done')", status, "failed")
	}
}
