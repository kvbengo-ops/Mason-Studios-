package store

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// This file pins 0092_deleted_scene_versions.sql's trigger: deleting a
// scene_versions row ON ITS OWN (the scene stays alive) must copy that
// version and its clip asset into deleted_scene_versions one step ahead of
// the delete, so restoreClipVersion (web/actions/ugc.ts) has something to
// restore from. It is the one-level-down sibling of deleted_scenes_test.go,
// which pins 0088's whole-scene archive — this one pins a single version,
// and the deliberate case where it must NOT fire a second time: a version
// torn down by its OWN SCENE's cascade, which 0088 already archived inside
// deleted_scenes.versions.
//
// Same TEST_DATABASE_URL gate and reasoning as every other file in this
// package: what is under test is server-side trigger behaviour fired by a
// BEFORE DELETE, which no fake reproduces.
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/store -run DeletedSceneVersion

// TestArchiveDeletedSceneVersionWritesRow covers the base case: deleting a
// scene_versions row on its own (the scene stays alive) writes exactly one
// deleted_scene_versions row. Unlike a scene torn down by its own PROJECT's
// cascade (deleted_scenes_test.go's
// TestArchiveDeletedSceneOnProjectCascadeWritesOnePerScene, which archives
// with user_id NULL), there is no missing-parent timing problem here: the
// scene this version belongs to is still alive when the trigger fires, so
// project_id and user_id are BOTH readable — and clip_asset must hold the
// real assets row, not merely a non-empty value, which would also pass if
// the trigger's WHERE clause quietly matched the wrong asset.
func TestArchiveDeletedSceneVersionWritesRow(t *testing.T) {
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
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(),
			`DELETE FROM deleted_scene_versions WHERE scene_id = $1`, sceneID,
		); err != nil {
			t.Errorf("cleanup deleted_scene_versions: %v", err)
		}
	})

	var clipAssetID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO assets (project_id, scene_id, kind, storage_key)
VALUES ($1, $2, 'clip', $3)
RETURNING id`, projectID, sceneID, "projects/seed/clip/deleted-scene-versions-fixture.mp4").Scan(&clipAssetID); err != nil {
		t.Fatalf("seed clip asset: %v", err)
	}

	var versionID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO scene_versions (scene_id, n, video_prompt, clip_asset_id)
VALUES ($1, 1, 'v1 archived prompt', $2)
RETURNING id`, sceneID, clipAssetID).Scan(&versionID); err != nil {
		t.Fatalf("seed scene_version: %v", err)
	}

	if _, err := s.pool.Exec(ctx, `DELETE FROM scene_versions WHERE id = $1`, versionID); err != nil {
		t.Fatalf("delete scene_version: %v", err)
	}

	var count int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM deleted_scene_versions WHERE version_id = $1`, versionID,
	).Scan(&count); err != nil {
		t.Fatalf("count archived rows: %v", err)
	}
	if count != 1 {
		t.Fatalf("archived rows for version = %d, want 1", count)
	}

	var (
		archivedProjectID string
		archivedUserID    string
		n                 int
		clipAssetJSON     []byte
	)
	if err := s.pool.QueryRow(ctx,
		`SELECT project_id, user_id, n, clip_asset FROM deleted_scene_versions WHERE version_id = $1`, versionID,
	).Scan(&archivedProjectID, &archivedUserID, &n, &clipAssetJSON); err != nil {
		t.Fatalf("read archived version: %v", err)
	}
	if archivedProjectID != projectID {
		t.Errorf("archived project_id = %q, want %q (a standalone delete must find its scene and read this)", archivedProjectID, projectID)
	}
	if archivedUserID != ownerID {
		t.Errorf("archived user_id = %q, want %q (a standalone delete must find its scene and read this)", archivedUserID, ownerID)
	}
	if n != 1 {
		t.Errorf("archived n = %d, want 1", n)
	}

	var clipAsset map[string]any
	if err := json.Unmarshal(clipAssetJSON, &clipAsset); err != nil {
		t.Fatalf("clip_asset jsonb did not decode: %v (%s)", err, clipAssetJSON)
	}
	if len(clipAsset) == 0 {
		t.Fatalf("archived clip_asset = %v, want the real assets row, not empty/null", clipAsset)
	}
	if got, _ := clipAsset["id"].(string); got != clipAssetID {
		t.Errorf("archived clip_asset id = %q, want %q", got, clipAssetID)
	}
	if got, _ := clipAsset["storage_key"].(string); got != "projects/seed/clip/deleted-scene-versions-fixture.mp4" {
		t.Errorf("archived clip_asset storage_key = %q, want the seeded asset's own key", got)
	}
}

// TestArchiveDeletedSceneVersionCascadeDoesNotArchive is 0092's central
// design decision (option A, see this migration's header): a version torn
// down by its OWN SCENE's cascade must NOT get a second archive row here.
// 0088's BEFORE DELETE trigger on scenes already read every one of this
// scene's scene_versions rows into deleted_scenes.versions one line before
// the cascade reached this table, and by the time THIS trigger fires the
// scenes row is already gone from a plain SELECT in this transaction, so
// there is no project_id/user_id left to archive it under anyway (see the
// migration header for why that would produce an unreadable, NULL-user_id
// row here even if double-storage were acceptable).
func TestArchiveDeletedSceneVersionCascadeDoesNotArchive(t *testing.T) {
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

	_, sceneID := seedRenderingScene(ctx, t, s)
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM deleted_scene_versions WHERE scene_id = $1`,
			`DELETE FROM deleted_scenes WHERE scene_id = $1`,
		} {
			if _, err := s.pool.Exec(context.Background(), q, sceneID); err != nil {
				t.Errorf("cleanup %q: %v", q, err)
			}
		}
	})

	if _, err := s.pool.Exec(ctx, `
INSERT INTO scene_versions (scene_id, n, video_prompt)
VALUES ($1, 1, 'cascade-should-not-land-here')`, sceneID); err != nil {
		t.Fatalf("seed scene_version: %v", err)
	}

	if _, err := s.pool.Exec(ctx, `DELETE FROM scenes WHERE id = $1`, sceneID); err != nil {
		t.Fatalf("delete scene: %v", err)
	}

	var leaked int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM deleted_scene_versions WHERE scene_id = $1`, sceneID,
	).Scan(&leaked); err != nil {
		t.Fatalf("count deleted_scene_versions rows: %v", err)
	}
	if leaked != 0 {
		t.Errorf("deleted_scene_versions rows for a cascade-deleted version = %d, want 0 "+
			"(option A: a cascaded version rides inside deleted_scenes.versions instead)", leaked)
	}

	var versionsJSON []byte
	if err := s.pool.QueryRow(ctx,
		`SELECT versions FROM deleted_scenes WHERE scene_id = $1`, sceneID,
	).Scan(&versionsJSON); err != nil {
		t.Fatalf("read deleted_scenes.versions: %v", err)
	}
	var versions []map[string]any
	if err := json.Unmarshal(versionsJSON, &versions); err != nil {
		t.Fatalf("versions jsonb did not decode: %v (%s)", err, versionsJSON)
	}
	if len(versions) != 1 {
		t.Fatalf("deleted_scenes.versions for this scene = %d, want 1 (the cascaded version, riding inside the scene's own snapshot)", len(versions))
	}
	if got, _ := versions[0]["video_prompt"].(string); got != "cascade-should-not-land-here" {
		t.Errorf("deleted_scenes.versions[0].video_prompt = %q, want %q", got, "cascade-should-not-land-here")
	}
}

// TestArchiveDeletedSceneVersionCascadeGuardIsLoadBearing is a NEGATIVE
// CONTROL: it removes the `if not exists (select 1 from scenes where id =
// OLD.scene_id) then return OLD; end if;` early return from
// archive_deleted_scene_version(), re-runs
// TestArchiveDeletedSceneVersionCascadeDoesNotArchive's scenario by hand, and
// asserts the row now DOES leak into deleted_scene_versions — proving the
// guard, not merely a passing test, is what keeps that scenario true. A test
// that cannot fail proves nothing — this repo's own commit history says so
// repeatedly.
//
// The original function body is captured with pg_get_functiondef before
// mutating it, and restored in a t.Cleanup registered immediately after
// capturing it, so a panic anywhere below cannot leave the scratch database
// poisoned for every test that runs after this one.
func TestArchiveDeletedSceneVersionCascadeGuardIsLoadBearing(t *testing.T) {
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

	var original string
	if err := s.pool.QueryRow(ctx,
		`SELECT pg_get_functiondef('public.archive_deleted_scene_version()'::regprocedure)`,
	).Scan(&original); err != nil {
		t.Fatalf("capture original function definition: %v", err)
	}
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(), original); err != nil {
			t.Fatalf("restore archive_deleted_scene_version() from captured definition: %v", err)
		}
	})

	// The same function, with only the early-return guard removed.
	if _, err := s.pool.Exec(ctx, `
create or replace function public.archive_deleted_scene_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id uuid;
  v_user_id    uuid;
  v_clip_asset jsonb;
begin
  select s.project_id into v_project_id
  from scenes s
  where s.id = OLD.scene_id;

  select p.user_id into v_user_id
  from projects p
  where p.id = v_project_id;

  select to_jsonb(a) into v_clip_asset
  from assets a
  where a.id = OLD.clip_asset_id;

  insert into deleted_scene_versions (
    version_id, scene_id, project_id, user_id, n, version, clip_asset
  )
  values (
    OLD.id, OLD.scene_id, v_project_id, v_user_id, OLD.n, to_jsonb(OLD), v_clip_asset
  )
  on conflict (version_id) do nothing;

  return OLD;
end;
$$;
`); err != nil {
		t.Fatalf("redefine archive_deleted_scene_version() without the guard: %v", err)
	}

	_, sceneID := seedRenderingScene(ctx, t, s)
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM deleted_scene_versions WHERE scene_id = $1`,
			`DELETE FROM deleted_scenes WHERE scene_id = $1`,
		} {
			if _, err := s.pool.Exec(context.Background(), q, sceneID); err != nil {
				t.Errorf("cleanup %q: %v", q, err)
			}
		}
	})

	if _, err := s.pool.Exec(ctx, `
INSERT INTO scene_versions (scene_id, n, video_prompt)
VALUES ($1, 1, 'leaked-without-the-guard')`, sceneID); err != nil {
		t.Fatalf("seed scene_version: %v", err)
	}

	if _, err := s.pool.Exec(ctx, `DELETE FROM scenes WHERE id = $1`, sceneID); err != nil {
		t.Fatalf("delete scene: %v", err)
	}

	var leaked int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM deleted_scene_versions WHERE scene_id = $1`, sceneID,
	).Scan(&leaked); err != nil {
		t.Fatalf("count deleted_scene_versions rows: %v", err)
	}
	if leaked == 0 {
		t.Fatalf("deleted_scene_versions rows for a cascade-deleted version with the guard removed = 0, want > 0 — " +
			"this negative control must fail without the guard, or it proves nothing about the guard being load-bearing")
	}
}

// TestArchiveDeletedSceneVersionLosslessRoundTrip populates a scene_versions
// row with edge values a naive jsonb round trip could still get wrong —
// quoting inside video_prompt, nested structure and a literal JSON null
// inside render_settings, and a deliberate NULL foreign key — archives it,
// reconstructs a row with jsonb_populate_record(null::scene_versions,
// version), and asserts every column of the reconstruction against the
// original with IS DISTINCT FROM (NULL-safe, unlike `<>`). The original row
// is gone by the time the archive is read back, so its own to_jsonb
// snapshot — taken immediately after insert, before the delete — stands in
// for it; that snapshot is exactly the shape to_jsonb(OLD) captures inside
// the trigger itself, so this is not a weaker comparison than the real
// thing.
//
// duration_s is a plain INTEGER (0059_scene_version_render_settings.sql's
// own comment explains why: it is a snapshot of a scene column that is
// itself an integer, not part of the settings jsonb), so this seeds a whole
// number rather than a fractional one.
func TestArchiveDeletedSceneVersionLosslessRoundTrip(t *testing.T) {
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

	_, sceneID := seedRenderingScene(ctx, t, s)
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(),
			`DELETE FROM deleted_scene_versions WHERE scene_id = $1`, sceneID,
		); err != nil {
			t.Errorf("cleanup deleted_scene_versions: %v", err)
		}
	})

	videoPrompt := "she said \"hi\" — it's a line\nwith a literal newline in it"
	renderSettings, err := json.Marshal(map[string]any{
		"resolution": "1080p",
		"model": map[string]any{
			"vendor":  "kie",
			"options": []any{"audio", "watermark_free"},
		},
		"seed": nil,
	})
	if err != nil {
		t.Fatalf("marshal render_settings fixture: %v", err)
	}

	var versionID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO scene_versions (scene_id, n, video_prompt, ref_frame_asset_id, render_settings, duration_s)
VALUES ($1, 1, $2, NULL, $3, 8)
RETURNING id`, sceneID, videoPrompt, renderSettings).Scan(&versionID); err != nil {
		t.Fatalf("seed scene_version: %v", err)
	}

	var originalJSON []byte
	if err := s.pool.QueryRow(ctx,
		`SELECT to_jsonb(sv) FROM scene_versions sv WHERE id = $1`, versionID,
	).Scan(&originalJSON); err != nil {
		t.Fatalf("capture original row: %v", err)
	}

	if _, err := s.pool.Exec(ctx, `DELETE FROM scene_versions WHERE id = $1`, versionID); err != nil {
		t.Fatalf("delete scene_version: %v", err)
	}

	var (
		idDiff, sceneIDDiff, nDiff, promptDiff       bool
		refFrameDiff, clipAssetIDDiff, createdAtDiff bool
		renderSettingsDiff, durationDiff             bool
	)
	if err := s.pool.QueryRow(ctx, `
SELECT
  v.id is distinct from o.id,
  v.scene_id is distinct from o.scene_id,
  v.n is distinct from o.n,
  v.video_prompt is distinct from o.video_prompt,
  v.ref_frame_asset_id is distinct from o.ref_frame_asset_id,
  v.clip_asset_id is distinct from o.clip_asset_id,
  v.created_at is distinct from o.created_at,
  v.render_settings is distinct from o.render_settings,
  v.duration_s is distinct from o.duration_s
FROM deleted_scene_versions dsv,
     jsonb_populate_record(null::scene_versions, dsv.version) AS v,
     jsonb_populate_record(null::scene_versions, $2::jsonb) AS o
WHERE dsv.version_id = $1`,
		versionID, originalJSON,
	).Scan(
		&idDiff, &sceneIDDiff, &nDiff, &promptDiff,
		&refFrameDiff, &clipAssetIDDiff, &createdAtDiff,
		&renderSettingsDiff, &durationDiff,
	); err != nil {
		t.Fatalf("compare reconstructed row: %v", err)
	}

	for name, diff := range map[string]bool{
		"id":                 idDiff,
		"scene_id":           sceneIDDiff,
		"n":                  nDiff,
		"video_prompt":       promptDiff,
		"ref_frame_asset_id": refFrameDiff,
		"clip_asset_id":      clipAssetIDDiff,
		"created_at":         createdAtDiff,
		"render_settings":    renderSettingsDiff,
		"duration_s":         durationDiff,
	} {
		if diff {
			t.Errorf("reconstructed scene_versions.%s does not match the original row — the archive is not lossless", name)
		}
	}
}

// TestRLSDeletedSceneVersions covers deleted_scene_versions_select
// (`user_id = auth.uid() or is_admin()`, identical shape to 0088's
// deleted_scenes_select) — owner-readable, for the same reason: the editor
// who deleted their own version is the one who restores it. Same
// runAsUser-by-hand methodology as rls_test.go and deleted_scenes_test.go's
// TestRLSDeletedScenes: act as a real `authenticated` role with a real
// auth.uid(), inside a rolled-back transaction, so RLS is genuinely
// exercised rather than bypassed by the superuser pool every other test in
// this package uses. anon's exclusion at the GRANT layer — before RLS is
// even consulted — is covered by rls_anon_test.go's hardcoded table list,
// which this change extends, rather than repeated here.
func TestRLSDeletedSceneVersions(t *testing.T) {
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
			`DELETE FROM deleted_scene_versions WHERE scene_id = $1`, sceneID,
		); err != nil {
			t.Errorf("cleanup deleted_scene_versions: %v", err)
		}
	})

	var versionID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO scene_versions (scene_id, n, video_prompt)
VALUES ($1, 1, 'rls fixture version')
RETURNING id`, sceneID).Scan(&versionID); err != nil {
		t.Fatalf("seed scene_version: %v", err)
	}

	if _, err := s.pool.Exec(ctx, `DELETE FROM scene_versions WHERE id = $1`, versionID); err != nil {
		t.Fatalf("delete scene_version: %v", err)
	}

	// Sanity: the row exists and really did snapshot the owner, so a zero
	// result below can only mean RLS filtered it, not that it was never
	// written or never attributed.
	var archivedUserID string
	if err := s.pool.QueryRow(ctx,
		`SELECT user_id FROM deleted_scene_versions WHERE version_id = $1`, versionID,
	).Scan(&archivedUserID); err != nil {
		t.Fatalf("read archived user_id: %v", err)
	}
	if archivedUserID != ownerID {
		t.Fatalf("archived user_id = %q, want %q (owner snapshot)", archivedUserID, ownerID)
	}

	t.Run("owner_can_read_own_archived_version", func(t *testing.T) {
		runAsUser(ctx, t, s, ownerID, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx,
				`SELECT count(*) FROM deleted_scene_versions WHERE version_id = $1`, versionID,
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
				`SELECT count(*) FROM deleted_scene_versions WHERE version_id = $1`, versionID,
			).Scan(&count); err != nil {
				t.Fatalf("stranger select: %v", err)
			}
			if count != 0 {
				t.Errorf("stranger-visible archived rows = %d, want 0 (RLS must filter, not error)", count)
			}
		})
	})
}
