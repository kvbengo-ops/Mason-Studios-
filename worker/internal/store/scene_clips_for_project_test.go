package store

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestSceneClipsForProject_NeverReorderedStampsClipReadTimeNotNull pins the
// fix in 0043_built_from_cut_order_at_no_null_on_write.sql: a project whose
// cut order has never been touched (projects.cut_order_updated_at is null,
// 0039_cut_order.sql) must get back a real timestamp close to "now", not
// nil — see SceneClipsForProject's doc comment for why nil used to be
// written here and why that was the bug caught live on project
// 647739b6-f3ec-4910-96ce-bd9f1114a4ce.
//
// Gated on TEST_DATABASE_URL the same way markfailed_test.go's tests are —
// as of this writing these have never actually run in this environment,
// stated plainly rather than implied:
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/store -run SceneClipsForProject
func TestSceneClipsForProject_NeverReorderedStampsClipReadTimeNotNull(t *testing.T) {
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
	seedClipAsset(ctx, t, s, projectID, sceneID)

	before := time.Now()
	_, cutAt, err := s.SceneClipsForProject(ctx, projectID)
	after := time.Now()
	if err != nil {
		t.Fatalf("SceneClipsForProject: %v", err)
	}

	if cutAt == nil {
		t.Fatal("SceneClipsForProject cutOrderUpdatedAt = nil, want the clip-read time (never reordered must no longer stamp null)")
	}
	// The value comes from the database's own now(), not the test
	// process's clock, so this is a sanity window, not an exact match —
	// but it must land in the read window, not at some arbitrary or
	// zero-value instant.
	if cutAt.Before(before.Add(-time.Second)) || cutAt.After(after.Add(time.Second)) {
		t.Errorf("SceneClipsForProject cutOrderUpdatedAt = %v, want within [%v, %v] (the clip-read time)", cutAt, before, after)
	}
}

// TestSceneClipsForProject_ReorderedStampsTheReorderTime pins the other
// half: once a project HAS been reordered, SceneClipsForProject must return
// that reorder's own timestamp unchanged, not the read time — the
// COALESCE fallback in 0043 only fires when
// projects.cut_order_updated_at is null.
func TestSceneClipsForProject_ReorderedStampsTheReorderTime(t *testing.T) {
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
	seedClipAsset(ctx, t, s, projectID, sceneID)

	reorderedAt := time.Date(2026, 8, 14, 9, 58, 28, 0, time.UTC)
	if _, err := s.pool.Exec(ctx,
		`UPDATE projects SET cut_order_updated_at = $1 WHERE id = $2`, reorderedAt, projectID,
	); err != nil {
		t.Fatalf("seed reorder: %v", err)
	}

	_, cutAt, err := s.SceneClipsForProject(ctx, projectID)
	if err != nil {
		t.Fatalf("SceneClipsForProject: %v", err)
	}

	if cutAt == nil || !cutAt.Equal(reorderedAt) {
		t.Errorf("SceneClipsForProject cutOrderUpdatedAt = %v, want %v (the reorder's own timestamp, unchanged by the never-reordered fallback)", cutAt, reorderedAt)
	}
}

// seedClipAsset inserts a single kind='clip' asset for sceneID so
// SceneClipsForProject has a row to join against — without at least one
// clip, its query returns zero rows and a nil stamp regardless of
// cut_order_updated_at, which is not what either test above is pinning.
func seedClipAsset(ctx context.Context, t *testing.T, s *Store, projectID, sceneID string) {
	t.Helper()

	if _, err := s.pool.Exec(ctx, `
INSERT INTO assets (project_id, scene_id, kind, storage_key)
VALUES ($1, $2, 'clip', 'media/scene-clips-test.mp4')`, projectID, sceneID); err != nil {
		t.Fatalf("seed clip asset: %v", err)
	}
}

// insertClipAssetAt inserts a kind='clip' asset for sceneID stamped with an
// explicit created_at, so tests can control ordering/window logic precisely
// instead of relying on wall-clock spacing between inserts. Returns the
// asset id.
func insertClipAssetAt(ctx context.Context, t *testing.T, s *Store, projectID, sceneID string, createdAt time.Time) string {
	t.Helper()

	var assetID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO assets (project_id, scene_id, kind, storage_key, created_at)
VALUES ($1, $2, 'clip', 'media/scene-clips-versions-test.mp4', $3)
RETURNING id`, projectID, sceneID, createdAt).Scan(&assetID); err != nil {
		t.Fatalf("seed clip asset: %v", err)
	}
	return assetID
}

// insertSceneVersion inserts a scene_versions row with an explicit
// created_at and optional clip_asset_id, and returns its id. n is fixed at
// 1 since these tests only ever need one version per scene.
func insertSceneVersion(ctx context.Context, t *testing.T, s *Store, sceneID string, clipAssetID *string, createdAt time.Time) string {
	t.Helper()

	var versionID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO scene_versions (scene_id, n, clip_asset_id, created_at)
VALUES ($1, 1, $2, $3)
RETURNING id`, sceneID, clipAssetID, createdAt).Scan(&versionID); err != nil {
		t.Fatalf("seed scene version: %v", err)
	}
	return versionID
}

// setActiveVersion points sceneID at versionID, mirroring what a real
// render does via scenes.active_version_id.
func setActiveVersion(ctx context.Context, t *testing.T, s *Store, sceneID, versionID string) {
	t.Helper()

	if _, err := s.pool.Exec(ctx,
		`UPDATE scenes SET active_version_id = $1 WHERE id = $2`, versionID, sceneID,
	); err != nil {
		t.Fatalf("set active version: %v", err)
	}
}

// TestSceneClipsForProject_ActiveVersionClipAssetIDWins pins the whole
// point of the rewrite: when the scene's active version names its clip via
// clip_asset_id, that clip wins even though a strictly newer clip exists
// for the same scene (e.g. left behind by 0058's stop-deleting-on-rerender
// change, or a version opened and then abandoned mid-render). Asserted
// against the wrong answer, not just non-empty, per the task.
func TestSceneClipsForProject_ActiveVersionClipAssetIDWins(t *testing.T) {
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

	base := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	activeClipID := insertClipAssetAt(ctx, t, s, projectID, sceneID, base)
	versionID := insertSceneVersion(ctx, t, s, sceneID, &activeClipID, base)
	setActiveVersion(ctx, t, s, sceneID, versionID)

	// A newer clip for the same scene that the active version does NOT
	// name — e.g. left over from a re-render the operator never made
	// active.
	newerClipID := insertClipAssetAt(ctx, t, s, projectID, sceneID, base.Add(time.Hour))

	assets, _, err := s.SceneClipsForProject(ctx, projectID)
	if err != nil {
		t.Fatalf("SceneClipsForProject: %v", err)
	}
	if len(assets) != 1 {
		t.Fatalf("len(assets) = %d, want 1", len(assets))
	}
	if assets[0].ID != activeClipID {
		if assets[0].ID == newerClipID {
			t.Fatalf("SceneClipsForProject returned the newer, non-active clip %s instead of the active version's clip %s", newerClipID, activeClipID)
		}
		t.Fatalf("SceneClipsForProject returned clip %s, want the active version's clip %s", assets[0].ID, activeClipID)
	}
}

// TestSceneClipsForProject_BackfilledVersionNewerThanItsClip pins the exact
// regression the rewrite exists to avoid: 0058's backfill stamped v1 rows
// with created_at AFTER the clip they describe. Before clip_asset_id was
// allowed to win outright, the time-window fallback alone would exclude
// every backfilled clip and the assembled cut would come back empty for
// every pre-existing project.
func TestSceneClipsForProject_BackfilledVersionNewerThanItsClip(t *testing.T) {
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

	clipCreatedAt := time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC)
	versionCreatedAt := clipCreatedAt.Add(24 * time.Hour) // backfill shape: version is NEWER than its clip

	clipID := insertClipAssetAt(ctx, t, s, projectID, sceneID, clipCreatedAt)
	versionID := insertSceneVersion(ctx, t, s, sceneID, &clipID, versionCreatedAt)
	setActiveVersion(ctx, t, s, sceneID, versionID)

	assets, _, err := s.SceneClipsForProject(ctx, projectID)
	if err != nil {
		t.Fatalf("SceneClipsForProject: %v", err)
	}
	if len(assets) != 1 {
		t.Fatalf("len(assets) = %d, want 1 (backfilled version's clip must not be dropped)", len(assets))
	}
	if assets[0].ID != clipID {
		t.Errorf("SceneClipsForProject returned clip %s, want %s (the backfilled version's own clip, despite its created_at being older than the version's)", assets[0].ID, clipID)
	}
}

// TestSceneClipsForProject_OrdersBySceneIdx pins that results still come
// back ordered by scene idx, independent of insertion or clip creation
// order.
func TestSceneClipsForProject_OrdersBySceneIdx(t *testing.T) {
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

	// seedRenderingScene gives us a project plus one scene at idx 0.
	projectID, scene0 := seedRenderingScene(ctx, t, s)

	// Insert idx 2 before idx 1, so insertion order is not scene-idx order.
	var scene2, scene1 string
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO scenes (project_id, idx, status) VALUES ($1, 2, 'rendering') RETURNING id`,
		projectID,
	).Scan(&scene2); err != nil {
		t.Fatalf("seed scene idx 2: %v", err)
	}
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO scenes (project_id, idx, status) VALUES ($1, 1, 'rendering') RETURNING id`,
		projectID,
	).Scan(&scene1); err != nil {
		t.Fatalf("seed scene idx 1: %v", err)
	}

	base := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	// Also vary clip creation order relative to idx, so the ORDER BY
	// s.idx isn't accidentally riding along on a.created_at ordering.
	clip2 := insertClipAssetAt(ctx, t, s, projectID, scene2, base)
	clip0 := insertClipAssetAt(ctx, t, s, projectID, scene0, base.Add(time.Hour))
	clip1 := insertClipAssetAt(ctx, t, s, projectID, scene1, base.Add(2*time.Hour))

	assets, _, err := s.SceneClipsForProject(ctx, projectID)
	if err != nil {
		t.Fatalf("SceneClipsForProject: %v", err)
	}

	wantOrder := []string{clip0, clip1, clip2}
	if len(assets) != len(wantOrder) {
		t.Fatalf("len(assets) = %d, want %d", len(assets), len(wantOrder))
	}
	for i, want := range wantOrder {
		if assets[i].ID != want {
			t.Errorf("assets[%d].ID = %s, want %s (scene idx order)", i, assets[i].ID, want)
		}
	}
}

// TestSceneClipsForProject_SceneWithNoClipIsAbsent pins the current
// behaviour for a scene with no clip asset at all: it is simply missing
// from the result, not represented by a zero-value row.
func TestSceneClipsForProject_SceneWithNoClipIsAbsent(t *testing.T) {
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

	// idx 0 gets a clip, idx 1 gets none.
	projectID, scene0 := seedRenderingScene(ctx, t, s)
	var scene1 string
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO scenes (project_id, idx, status) VALUES ($1, 1, 'rendering') RETURNING id`,
		projectID,
	).Scan(&scene1); err != nil {
		t.Fatalf("seed scene idx 1: %v", err)
	}

	clip0 := insertClipAssetAt(ctx, t, s, projectID, scene0, time.Now())

	assets, _, err := s.SceneClipsForProject(ctx, projectID)
	if err != nil {
		t.Fatalf("SceneClipsForProject: %v", err)
	}
	if len(assets) != 1 {
		t.Fatalf("len(assets) = %d, want 1 (scene1 has no clip and must be absent, not a zero-value row)", len(assets))
	}
	if assets[0].ID != clip0 {
		t.Errorf("assets[0].ID = %s, want %s", assets[0].ID, clip0)
	}
	if assets[0].SceneID == nil || *assets[0].SceneID != scene0 {
		t.Errorf("assets[0].SceneID = %v, want %s", assets[0].SceneID, scene0)
	}
	_ = scene1
}
