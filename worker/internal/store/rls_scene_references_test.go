package store

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// This file follows rls_test.go's methodology (see that file's header) for
// scene_references (0071_scene_references.sql, RLS added by
// 0098_scene_references_select_policy.sql).
//
// THE BUG 0098 FIXED: prod had RLS enabled on scene_references outside the
// repo, with zero policies. Every read through a user-scoped client
// (web/app/(app)/ugc/[id]/page.tsx) returned zero rows, silently — the
// References box showed "0/10" while the rows sat in the table. 0098 adds a
// single SELECT policy, mirroring scene_versions_select (0058): the owner of
// the scene's project, or an admin, can read.
//
// READ ONLY, ON PURPOSE. Every write to this table goes through the
// service-role client (attachSceneReferences, the restore path in
// actions/ugc.ts, and the worker) — there is deliberately no insert/update/
// delete policy for `authenticated`. This file proves both halves: the
// SELECT policy admits the right rows, and the absence of any write policy
// means `authenticated` can insert nothing and an unqualified UPDATE/DELETE
// touches nothing — the same unqualified-write pattern rls_test.go uses,
// for the same reason: a targeted `where id = ...` write is filtered by the
// SELECT policy before the UPDATE/DELETE policy (or its absence) is ever
// consulted, so only an unqualified statement genuinely exercises the write
// side.
func TestRLSSceneReferencesTenantIsolation(t *testing.T) {
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

	projectA, sceneA := seedRenderingScene(ctx, t, s)
	projectB, _ := seedRenderingScene(ctx, t, s)
	userA := projectOwner(ctx, t, s, projectA)
	userB := projectOwner(ctx, t, s, projectB)
	adminUser := seedUser(ctx, t, s)
	makeAdmin(ctx, t, s, adminUser)

	// scene_references.asset_id is NOT NULL with ON DELETE RESTRICT
	// (0071_scene_references.sql), so a reference row needs a real assets
	// row behind it — see deleted_scenes_test.go:160 for the same shape.
	assetA1 := seedSceneAsset(ctx, t, s, projectA, sceneA, "projects/rls-test/ref_frame/a1.png")
	assetA2 := seedSceneAsset(ctx, t, s, projectA, sceneA, "projects/rls-test/ref_frame/a2.png")

	refA1 := seedSceneReference(ctx, t, s, sceneA, assetA1, 1)
	refA2 := seedSceneReference(ctx, t, s, sceneA, assetA2, 2)

	t.Run("owner_reads_own_scenes_references", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx,
				`select count(*) from scene_references where scene_id = $1`, sceneA,
			).Scan(&count); err != nil {
				t.Fatalf("select own scene's references: %v", err)
			}
			if count != 2 {
				t.Errorf("own scene's visible scene_references rows = %d, want 2 (%s, %s)", count, refA1, refA2)
			}
		})
	})

	t.Run("other_user_reads_zero", func(t *testing.T) {
		runAsUser(ctx, t, s, userB, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx,
				`select count(*) from scene_references where scene_id = $1`, sceneA,
			).Scan(&count); err != nil {
				t.Fatalf("select other user's scene_references: %v", err)
			}
			if count != 0 {
				t.Errorf("other user's visible scene_references rows = %d, want 0 (RLS must filter, not error)", count)
			}
		})
	})

	t.Run("admin_reads_them", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx,
				`select count(*) from scene_references where scene_id = $1`, sceneA,
			).Scan(&count); err != nil {
				t.Fatalf("admin select scene_references: %v", err)
			}
			if count != 2 {
				t.Errorf("admin visible scene_references rows = %d, want 2 (admin read access is being denied uselessly strict)", count)
			}
		})
	})

	// No insert policy exists at all — attachSceneReferences and the
	// restore path write through the service-role client, which bypasses
	// RLS entirely. An `authenticated` owner, inserting a row for their OWN
	// scene and their OWN asset, must still be refused: with no policy
	// granting INSERT, Postgres denies by default.
	t.Run("owner_insert_denied", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into scene_references (scene_id, asset_id, kind, ordinal, category, description)
				 values ($1, $2, 'image', 3, 'character', 'attempted authenticated insert')`,
				sceneA, assetA1,
			)
			if err == nil {
				t.Errorf("authenticated insert into scene_references succeeded, want RLS denial (no insert policy exists)")
			}
		})
	})

	// Unqualified, exactly as rls_test.go and rls_allowance_runs_assets_test.go
	// require for a write assertion to mean anything: a targeted `where
	// scene_id = $1` would be filtered by the SELECT policy before an
	// UPDATE/DELETE policy (or its absence) is ever consulted, so it would
	// report 0 rows even if scene_references somehow had a wide-open write
	// policy. With no update/delete policy at all, the unqualified
	// statement below must affect zero rows regardless of how many rows
	// `authenticated` can SELECT.
	t.Run("unqualified_update_affects_zero_rows", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var visible int
			if err := tx.QueryRow(ctx, `select count(*) from scene_references`).Scan(&visible); err != nil {
				t.Fatalf("count visible scene_references: %v", err)
			}
			if visible == 0 {
				t.Fatalf("owner sees 0 scene_references rows before the write attempt — select_own_rows subtest should have caught this")
			}
			tag, err := tx.Exec(ctx, `update scene_references set description = 'pwned'`)
			if err != nil {
				t.Fatalf("unqualified update scene_references: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified update affected %d scene_references rows, want 0 (no update policy exists for authenticated)", tag.RowsAffected())
			}
		})
	})

	t.Run("unqualified_delete_affects_zero_rows", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var visible int
			if err := tx.QueryRow(ctx, `select count(*) from scene_references`).Scan(&visible); err != nil {
				t.Fatalf("count visible scene_references: %v", err)
			}
			if visible == 0 {
				t.Fatalf("owner sees 0 scene_references rows before the write attempt — select_own_rows subtest should have caught this")
			}
			tag, err := tx.Exec(ctx, `delete from scene_references`)
			if err != nil {
				t.Fatalf("unqualified delete scene_references: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified delete affected %d scene_references rows, want 0 (no delete policy exists for authenticated)", tag.RowsAffected())
			}
		})
	})
}

// seedSceneReference inserts a scene_references row for sceneID, pointing at
// assetID, as image kind at the given ordinal. Seeded via the superuser pool
// (bypassing RLS), same as every other seed helper in this package.
func seedSceneReference(ctx context.Context, t *testing.T, s *Store, sceneID, assetID string, ordinal int) (id string) {
	t.Helper()
	if err := s.pool.QueryRow(ctx, `
INSERT INTO scene_references (scene_id, asset_id, kind, ordinal, category, description)
VALUES ($1, $2, 'image', $3, 'character', 'rls-test reference')
RETURNING id`, sceneID, assetID, ordinal).Scan(&id); err != nil {
		t.Fatalf("seed scene_reference: %v", err)
	}
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(), `DELETE FROM scene_references WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup scene_reference %s: %v", id, err)
		}
	})
	return id
}
