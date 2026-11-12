package store

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// scene_comments (0142_scene_title_position_comments.sql), by rls_test.go's
// methodology. The project's owner and admins read a scene's thread; nobody
// else does. Every write goes through the service-role client
// (web/actions/scene-organize.ts), so `authenticated` has no insert, update
// or delete policy at all — proven here with unqualified writes, for the
// reason rls_scene_references_test.go gives.
func TestRLSSceneCommentsTenantIsolation(t *testing.T) {
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

	// One from the owner, one from the admin: the two authors the app admits.
	seedSceneComment(ctx, t, s, sceneA, userA)
	seedSceneComment(ctx, t, s, sceneA, adminUser)

	visible := func(t *testing.T, tx pgx.Tx) int {
		t.Helper()
		var count int
		if err := tx.QueryRow(ctx,
			`select count(*) from scene_comments where scene_id = $1`, sceneA,
		).Scan(&count); err != nil {
			t.Fatalf("select scene_comments: %v", err)
		}
		return count
	}

	t.Run("owner_reads_own_scenes_thread", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			if count := visible(t, tx); count != 2 {
				t.Errorf("owner's visible scene_comments rows = %d, want 2", count)
			}
		})
	})

	t.Run("other_user_reads_zero", func(t *testing.T) {
		runAsUser(ctx, t, s, userB, func(tx pgx.Tx) {
			if count := visible(t, tx); count != 0 {
				t.Errorf("other user's visible scene_comments rows = %d, want 0 (RLS must filter, not error)", count)
			}
		})
	})

	t.Run("admin_reads_them", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			if count := visible(t, tx); count != 2 {
				t.Errorf("admin visible scene_comments rows = %d, want 2", count)
			}
		})
	})

	t.Run("owner_insert_denied", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into scene_comments (scene_id, user_id, body) values ($1, $2, 'attempted authenticated insert')`,
				sceneA, userA,
			)
			if err == nil {
				t.Errorf("authenticated insert into scene_comments succeeded, want RLS denial (no insert policy exists)")
			}
		})
	})

	t.Run("unqualified_update_affects_zero_rows", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update scene_comments set body = 'pwned'`)
			if err != nil {
				t.Fatalf("unqualified update scene_comments: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified update affected %d scene_comments rows, want 0 (no update policy exists for authenticated)", tag.RowsAffected())
			}
		})
	})

	t.Run("unqualified_delete_affects_zero_rows", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from scene_comments`)
			if err != nil {
				t.Fatalf("unqualified delete scene_comments: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified delete affected %d scene_comments rows, want 0 (no delete policy exists for authenticated)", tag.RowsAffected())
			}
		})
	})
}

// seedSceneComment inserts a scene_comments row via the superuser pool
// (bypassing RLS), same as every other seed helper in this package.
func seedSceneComment(ctx context.Context, t *testing.T, s *Store, sceneID, userID string) (id string) {
	t.Helper()
	if err := s.pool.QueryRow(ctx, `
INSERT INTO scene_comments (scene_id, user_id, body)
VALUES ($1, $2, 'rls-test comment')
RETURNING id`, sceneID, userID).Scan(&id); err != nil {
		t.Fatalf("seed scene_comment: %v", err)
	}
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(), `DELETE FROM scene_comments WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup scene_comment %s: %v", id, err)
		}
	})
	return id
}
