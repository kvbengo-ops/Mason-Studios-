package store

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// This file pins 0088_deleted_scenes.sql's trigger: deleting a scene (on its
// own, or via a project delete that cascades to it) must copy the scene and
// its children into deleted_scenes one step ahead of the cascade that is
// about to destroy them, so a later restore action has something to work
// from. It is the recovery counterpart to preserve_cost_history_test.go,
// which pins 0038/0054's MONEY-only archive — this one pins the whole row.
//
// Same TEST_DATABASE_URL gate and reasoning as every other file in this
// package: what is under test is server-side trigger behaviour fired by an
// ON DELETE CASCADE, which no fake reproduces.
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/store -run DeletedScene

// seedSceneAsset inserts one assets row hung off sceneID/projectID and
// returns its id.
func seedSceneAsset(ctx context.Context, t *testing.T, s *Store, projectID, sceneID, storageKey string) (assetID string) {
	t.Helper()
	if err := s.pool.QueryRow(ctx, `
INSERT INTO assets (project_id, scene_id, kind, storage_key)
VALUES ($1, $2, 'ref_frame', $3)
RETURNING id`, projectID, sceneID, storageKey).Scan(&assetID); err != nil {
		t.Fatalf("seed asset: %v", err)
	}
	return assetID
}

// TestArchiveDeletedSceneWritesRow covers the base case: deleting a
// standalone scene (its project is untouched) writes exactly one
// deleted_scenes row, and the scene's own columns are readable back out of
// the `scene` jsonb — proving the trigger's to_jsonb(OLD) actually ran
// before the cascade, not after.
func TestArchiveDeletedSceneWritesRow(t *testing.T) {
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

	projectID, sceneID := seedRenderingScene(ctx, t, s)
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(),
			`DELETE FROM deleted_scenes WHERE scene_id = $1`, sceneID,
		); err != nil {
			t.Errorf("cleanup deleted_scenes: %v", err)
		}
	})

	// Give the scene a distinctive, checkable value before it is deleted.
	if _, err := s.pool.Exec(ctx,
		`UPDATE scenes SET video_prompt = $2 WHERE id = $1`, sceneID, "archive-me prompt",
	); err != nil {
		t.Fatalf("set video_prompt: %v", err)
	}

	if _, err := s.pool.Exec(ctx, `DELETE FROM scenes WHERE id = $1`, sceneID); err != nil {
		t.Fatalf("delete scene: %v", err)
	}

	// The cascade must still have run — this is not a soft delete.
	var liveScenes int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM scenes WHERE id = $1`, sceneID,
	).Scan(&liveScenes); err != nil {
		t.Fatalf("count live scenes: %v", err)
	}
	if liveScenes != 0 {
		t.Errorf("live scenes for deleted id = %d, want 0 (the cascade must still delete)", liveScenes)
	}

	var count int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM deleted_scenes WHERE scene_id = $1`, sceneID,
	).Scan(&count); err != nil {
		t.Fatalf("count archived rows: %v", err)
	}
	if count != 1 {
		t.Fatalf("archived rows for scene = %d, want 1", count)
	}

	var (
		archivedProjectID string
		sceneJSON         []byte
	)
	if err := s.pool.QueryRow(ctx,
		`SELECT project_id, scene FROM deleted_scenes WHERE scene_id = $1`, sceneID,
	).Scan(&archivedProjectID, &sceneJSON); err != nil {
		t.Fatalf("read archived scene: %v", err)
	}
	if archivedProjectID != projectID {
		t.Errorf("archived project_id = %q, want %q", archivedProjectID, projectID)
	}

	var scene map[string]any
	if err := json.Unmarshal(sceneJSON, &scene); err != nil {
		t.Fatalf("scene jsonb did not decode: %v (%s)", err, sceneJSON)
	}
	if got, _ := scene["id"].(string); got != sceneID {
		t.Errorf("scene jsonb id = %q, want %q", got, sceneID)
	}
	if got, _ := scene["video_prompt"].(string); got != "archive-me prompt" {
		t.Errorf("scene jsonb video_prompt = %q, want %q", got, "archive-me prompt")
	}
	if got, _ := scene["project_id"].(string); got != projectID {
		t.Errorf("scene jsonb project_id = %q, want %q", got, projectID)
	}
}

// TestArchiveDeletedSceneCapturesChildren asserts the assets/versions/refs
// jsonb columns each carry the REAL child row that existed before the
// delete — not merely a non-empty array, which would also pass if the
// trigger's WHERE clause were quietly wrong (e.g. matching the wrong scene,
// or every scene in the project).
func TestArchiveDeletedSceneCapturesChildren(t *testing.T) {
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

	projectID, sceneID := seedRenderingScene(ctx, t, s)
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(),
			`DELETE FROM deleted_scenes WHERE scene_id = $1`, sceneID,
		); err != nil {
			t.Errorf("cleanup deleted_scenes: %v", err)
		}
	})

	assetID := seedSceneAsset(ctx, t, s, projectID, sceneID, "projects/seed/ref_frame/deleted-scenes-fixture.png")

	if _, err := s.pool.Exec(ctx, `
INSERT INTO scene_versions (scene_id, n, video_prompt)
VALUES ($1, 1, 'v1 archived prompt')`, sceneID); err != nil {
		t.Fatalf("seed scene_version: %v", err)
	}

	if _, err := s.pool.Exec(ctx, `
INSERT INTO scene_references (scene_id, asset_id, kind, ordinal, category, description)
VALUES ($1, $2, 'image', 1, 'character', 'archived reference description')`,
		sceneID, assetID); err != nil {
		t.Fatalf("seed scene_reference: %v", err)
	}

	if _, err := s.pool.Exec(ctx, `DELETE FROM scenes WHERE id = $1`, sceneID); err != nil {
		t.Fatalf("delete scene: %v", err)
	}

	var assetsJSON, versionsJSON, refsJSON []byte
	if err := s.pool.QueryRow(ctx,
		`SELECT assets, versions, refs FROM deleted_scenes WHERE scene_id = $1`, sceneID,
	).Scan(&assetsJSON, &versionsJSON, &refsJSON); err != nil {
		t.Fatalf("read archived children: %v", err)
	}

	var assets []map[string]any
	if err := json.Unmarshal(assetsJSON, &assets); err != nil {
		t.Fatalf("assets jsonb did not decode: %v (%s)", err, assetsJSON)
	}
	if len(assets) != 1 {
		t.Fatalf("archived assets = %d, want 1", len(assets))
	}
	if got, _ := assets[0]["storage_key"].(string); got != "projects/seed/ref_frame/deleted-scenes-fixture.png" {
		t.Errorf("archived asset storage_key = %q, want the seeded asset's own key", got)
	}
	if got, _ := assets[0]["id"].(string); got != assetID {
		t.Errorf("archived asset id = %q, want %q", got, assetID)
	}

	var versions []map[string]any
	if err := json.Unmarshal(versionsJSON, &versions); err != nil {
		t.Fatalf("versions jsonb did not decode: %v (%s)", err, versionsJSON)
	}
	if len(versions) != 1 {
		t.Fatalf("archived versions = %d, want 1", len(versions))
	}
	if got, _ := versions[0]["video_prompt"].(string); got != "v1 archived prompt" {
		t.Errorf("archived version video_prompt = %q, want %q", got, "v1 archived prompt")
	}

	var refs []map[string]any
	if err := json.Unmarshal(refsJSON, &refs); err != nil {
		t.Fatalf("refs jsonb did not decode: %v (%s)", err, refsJSON)
	}
	if len(refs) != 1 {
		t.Fatalf("archived refs = %d, want 1", len(refs))
	}
	if got, _ := refs[0]["description"].(string); got != "archived reference description" {
		t.Errorf("archived ref description = %q, want %q", got, "archived reference description")
	}
	if got, _ := refs[0]["asset_id"].(string); got != assetID {
		t.Errorf("archived ref asset_id = %q, want %q", got, assetID)
	}
}

// TestArchiveDeletedSceneOnProjectCascadeWritesOnePerScene is the
// double-fire path: deleting the PROJECT cascades down to every one of its
// scenes, and the same BEFORE DELETE trigger on scenes fires for each. This
// must not error, and must not produce more than one archived row per
// scene — deleted_scenes.scene_id is PRIMARY KEY with ON CONFLICT DO
// NOTHING for exactly this reason (mirrors 0038's run_id conflict guard,
// see this migration's header).
func TestArchiveDeletedSceneOnProjectCascadeWritesOnePerScene(t *testing.T) {
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

	projectID, sceneID := seedRenderingScene(ctx, t, s)

	var secondSceneID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO scenes (project_id, idx, status) VALUES ($1, 1, 'draft')
RETURNING id`, projectID).Scan(&secondSceneID); err != nil {
		t.Fatalf("seed second scene: %v", err)
	}

	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(),
			`DELETE FROM deleted_scenes WHERE project_id = $1`, projectID,
		); err != nil {
			t.Errorf("cleanup deleted_scenes: %v", err)
		}
	})

	// The delete under test: exactly what web/actions/project.ts's
	// deleteProject issues, with no archiving knowledge of its own.
	if _, err := s.pool.Exec(ctx, `DELETE FROM projects WHERE id = $1`, projectID); err != nil {
		t.Fatalf("delete project: %v", err)
	}

	var archivedRows int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM deleted_scenes WHERE project_id = $1`, projectID,
	).Scan(&archivedRows); err != nil {
		t.Fatalf("count archived rows: %v", err)
	}
	if archivedRows != 2 {
		t.Errorf("archived rows for a 2-scene project delete = %d, want 2 (one per scene, not per fire)", archivedRows)
	}

	for _, id := range []string{sceneID, secondSceneID} {
		var perScene int
		if err := s.pool.QueryRow(ctx,
			`SELECT count(*) FROM deleted_scenes WHERE scene_id = $1`, id,
		).Scan(&perScene); err != nil {
			t.Fatalf("count archived rows for scene %s: %v", id, err)
		}
		if perScene != 1 {
			t.Errorf("archived rows for scene %s = %d, want 1 (not two — the double-fire path must be a no-op)", id, perScene)
		}

		// A scene torn down by its own PROJECT's cascade archives with
		// user_id NULL — see archive_deleted_scene()'s own comment and this
		// migration's header: by the time this trigger fires as part of a
		// project-level cascade, the projects row is already gone from a
		// plain SELECT in this transaction, so there is no owner left to
		// read. Contrast TestRLSDeletedScenes, which seeds a STANDALONE
		// scene delete and asserts the opposite — user_id populated with
		// the real owner. This half is load-bearing for RLS: it is what
		// keeps a dead project's scenes out of a trash list scoped to a
		// still-live project id (web/app/(app)/ugc/[id]/page.tsx never
		// special-cases it, because a row like this one can never surface
		// there in the first place).
		var userID *string
		if err := s.pool.QueryRow(ctx,
			`SELECT user_id FROM deleted_scenes WHERE scene_id = $1`, id,
		).Scan(&userID); err != nil {
			t.Fatalf("read archived user_id for scene %s: %v", id, err)
		}
		if userID != nil {
			t.Errorf("archived user_id for scene %s (torn down by a PROJECT cascade) = %q, want NULL", id, *userID)
		}
	}
}

// TestArchiveDeletedSceneConflictIsANoOp pins the PRIMARY KEY +
// ON CONFLICT (scene_id) DO NOTHING guard directly, rather than only through
// the project-cascade test above. That test asserts "one row per scene" but,
// with only one trigger (BEFORE DELETE on scenes) in this migration — unlike
// 0038_preserve_cost_history_on_delete.sql, which has two independent
// triggers racing to archive the same run — a project-cascade delete never
// actually invokes archive_deleted_scene() twice for the same scene_id: each
// scenes row is deleted, and its trigger fires, exactly once regardless of
// whether the delete was direct or cascaded. So the cascade test alone would
// still pass even with ON CONFLICT deleted from the migration (verified by
// hand while writing this test — see this migration's own report).
//
// This test forces a genuine second archive attempt for one scene_id: the
// application never reuses a scenes.id (it is gen_random_uuid()'d, never
// supplied by a caller), but nothing stops a test from inserting a second
// scenes row that explicitly reuses an id already archived, then deleting
// it too — which fires the same trigger a second time for that scene_id and
// is exactly the case the primary key exists to make harmless.
func TestArchiveDeletedSceneConflictIsANoOp(t *testing.T) {
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

	projectID, sceneID := seedRenderingScene(ctx, t, s)
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(),
			`DELETE FROM deleted_scenes WHERE scene_id = $1`, sceneID,
		); err != nil {
			t.Errorf("cleanup deleted_scenes: %v", err)
		}
	})

	if _, err := s.pool.Exec(ctx, `DELETE FROM scenes WHERE id = $1`, sceneID); err != nil {
		t.Fatalf("delete scene (first archive): %v", err)
	}

	var firstDeletedAt string
	if err := s.pool.QueryRow(ctx,
		`SELECT deleted_at::text FROM deleted_scenes WHERE scene_id = $1`, sceneID,
	).Scan(&firstDeletedAt); err != nil {
		t.Fatalf("read first archived row: %v", err)
	}

	// Re-insert a scenes row that deliberately reuses sceneID, then delete
	// it — a second, genuine fire of the trigger for the same scene_id.
	if _, err := s.pool.Exec(ctx, `
INSERT INTO scenes (id, project_id, idx, status) VALUES ($1, $2, 5, 'draft')`,
		sceneID, projectID); err != nil {
		t.Fatalf("re-insert scene with reused id: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM scenes WHERE id = $1`, sceneID); err != nil {
		t.Fatalf("delete scene (second archive attempt): %v (ON CONFLICT (scene_id) DO NOTHING should have made this a no-op, not an error)", err)
	}

	var rows int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM deleted_scenes WHERE scene_id = $1`, sceneID,
	).Scan(&rows); err != nil {
		t.Fatalf("count archived rows: %v", err)
	}
	if rows != 1 {
		t.Errorf("archived rows for twice-fired scene_id = %d, want 1 (the second insert must be a no-op)", rows)
	}

	// The surviving row must be the FIRST archive, untouched by the second
	// attempt — ON CONFLICT DO NOTHING, not DO UPDATE.
	var deletedAtNow string
	if err := s.pool.QueryRow(ctx,
		`SELECT deleted_at::text FROM deleted_scenes WHERE scene_id = $1`, sceneID,
	).Scan(&deletedAtNow); err != nil {
		t.Fatalf("read archived row after second attempt: %v", err)
	}
	if deletedAtNow != firstDeletedAt {
		t.Errorf("deleted_at changed from %q to %q — the conflicting insert must be dropped, not merged", firstDeletedAt, deletedAtNow)
	}
}

// TestDeleteSceneDoesNotArchiveRuns_0054Regression is the guard this
// migration's header calls out explicitly: 0054_runs_survive_scene_delete.sql
// made runs.scene_id ON DELETE SET NULL specifically so a deleted scene's
// runs stay live (and singly-counted) in `runs`. If 0088's new trigger ever
// grew a join to `runs` — even just to read it, let alone archive it — that
// invariant breaks. This asserts both halves: the run survives with
// scene_id nulled out exactly as 0054 left it, and nothing about it shows up
// anywhere in deleted_scenes for the deleted scene.
func TestDeleteSceneDoesNotArchiveRuns_0054Regression(t *testing.T) {
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

	projectID, sceneID := seedRenderingScene(ctx, t, s)
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(),
			`DELETE FROM deleted_scenes WHERE scene_id = $1`, sceneID,
		); err != nil {
			t.Errorf("cleanup deleted_scenes: %v", err)
		}
	})

	cost := 0.4242
	reason := "seeded paid failure for the 0054 regression guard"
	if err := s.MarkFailed(ctx, sceneID, Run{
		ProjectID: projectID,
		Vendor:    "kie",
		Model:     "bytedance/seedance-2-5",
		CostUSD:   &cost,
		Error:     &reason,
	}); err != nil {
		t.Fatalf("seed run via MarkFailed: %v", err)
	}

	var runID string
	if err := s.pool.QueryRow(ctx,
		`SELECT id FROM runs WHERE scene_id = $1`, sceneID,
	).Scan(&runID); err != nil {
		t.Fatalf("read seeded run id: %v", err)
	}

	if _, err := s.pool.Exec(ctx, `DELETE FROM scenes WHERE id = $1`, sceneID); err != nil {
		t.Fatalf("delete scene: %v", err)
	}

	// Half one: runs.scene_id is ON DELETE SET NULL (0054), so the run is
	// still there, still charged to the project, only orphaned off its dead
	// scene.
	var (
		liveProjectID string
		liveSceneID   *string
	)
	if err := s.pool.QueryRow(ctx, `
SELECT project_id, scene_id FROM runs WHERE id = $1`, runID,
	).Scan(&liveProjectID, &liveSceneID); err != nil {
		t.Fatalf("read run %s after scene delete: %v (0088 must not touch runs.scene_id's ON DELETE SET NULL from 0054)", runID, err)
	}
	if liveProjectID != projectID {
		t.Errorf("run project_id after scene delete = %q, want %q", liveProjectID, projectID)
	}
	if liveSceneID != nil {
		t.Errorf("run scene_id after scene delete = %q, want NULL (0054's ON DELETE SET NULL)", *liveSceneID)
	}

	// Half two: nothing about the run appears in deleted_scenes. The
	// archived scene's assets/versions/refs are gathered only from
	// assets/scene_versions/scene_references, which never mention runs, but
	// this asserts the outcome rather than trusting the trigger's shape.
	var sceneJSON, assetsJSON, versionsJSON, refsJSON []byte
	if err := s.pool.QueryRow(ctx,
		`SELECT scene, assets, versions, refs FROM deleted_scenes WHERE scene_id = $1`, sceneID,
	).Scan(&sceneJSON, &assetsJSON, &versionsJSON, &refsJSON); err != nil {
		t.Fatalf("read archived scene: %v", err)
	}
	for name, blob := range map[string][]byte{
		"scene": sceneJSON, "assets": assetsJSON, "versions": versionsJSON, "refs": refsJSON,
	} {
		if containsRunID(blob, runID) {
			t.Errorf("deleted_scenes.%s mentions run id %s — 0088's trigger must never read or archive `runs` (see 0054's header)", name, runID)
		}
	}

	var archivedRuns int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM deleted_project_cost_history WHERE run_id = $1`, runID,
	).Scan(&archivedRuns); err != nil {
		t.Fatalf("count deleted_project_cost_history rows: %v", err)
	}
	if archivedRuns != 0 {
		t.Errorf("deleted_project_cost_history rows for run %s = %d, want 0 (0054 already dropped the scenes-level cost archive; 0088 must not resurrect it)", runID, archivedRuns)
	}
}

// containsRunID is a crude but honest byte search over a jsonb blob's raw
// bytes — deliberately not a structured walk, since the assertion is "this
// id appears nowhere in here at all", including nested inside a value this
// test did not anticipate.
func containsRunID(blob []byte, runID string) bool {
	return bytes.Contains(blob, []byte(runID))
}

// TestRLSDeletedScenes covers deleted_scenes_select
// (`user_id = auth.uid() or is_admin()`, mirroring elements_select) —
// owner-readable, unlike 0038's admin-only deleted_project_cost_history,
// because the editor who deleted their own scene is the one who restores
// it. Same runAsUser/runAsAdmin-by-hand methodology as rls_test.go: act as
// a real `authenticated` role with a real auth.uid(), inside a
// rolled-back transaction, so RLS is genuinely exercised rather than
// bypassed by the superuser pool every other test in this package uses.
func TestRLSDeletedScenes(t *testing.T) {
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

	projectID, sceneID := seedRenderingScene(ctx, t, s)
	ownerID := projectOwner(ctx, t, s, projectID)
	stranger := seedUser(ctx, t, s)

	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(),
			`DELETE FROM deleted_scenes WHERE scene_id = $1`, sceneID,
		); err != nil {
			t.Errorf("cleanup deleted_scenes: %v", err)
		}
	})

	if _, err := s.pool.Exec(ctx, `DELETE FROM scenes WHERE id = $1`, sceneID); err != nil {
		t.Fatalf("delete scene: %v", err)
	}

	// Sanity: the row exists and really did snapshot the owner, so a zero
	// result below can only mean RLS filtered it, not that it was never
	// written or never attributed.
	var archivedUserID string
	if err := s.pool.QueryRow(ctx,
		`SELECT user_id FROM deleted_scenes WHERE scene_id = $1`, sceneID,
	).Scan(&archivedUserID); err != nil {
		t.Fatalf("read archived user_id: %v", err)
	}
	if archivedUserID != ownerID {
		t.Fatalf("archived user_id = %q, want %q (owner snapshot)", archivedUserID, ownerID)
	}

	t.Run("owner_can_read_own_archived_scene", func(t *testing.T) {
		runAsUser(ctx, t, s, ownerID, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx,
				`SELECT count(*) FROM deleted_scenes WHERE scene_id = $1`, sceneID,
			).Scan(&count); err != nil {
				t.Fatalf("owner select: %v", err)
			}
			if count != 1 {
				t.Errorf("owner-visible archived rows = %d, want 1", count)
			}
		})
	})

	t.Run("a_different_user_gets_zero_rows", func(t *testing.T) {
		runAsUser(ctx, t, s, stranger, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx,
				`SELECT count(*) FROM deleted_scenes WHERE scene_id = $1`, sceneID,
			).Scan(&count); err != nil {
				t.Fatalf("stranger select: %v", err)
			}
			if count != 0 {
				t.Errorf("stranger-visible archived rows = %d, want 0 (RLS must filter, not error)", count)
			}
		})
	})
}
