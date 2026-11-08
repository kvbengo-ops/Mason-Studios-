package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// This file is the RLS counterpart to the ordinary store tests: those all
// connect as `postgres` (a superuser) and never touch a policy's `using`/
// `with check` clause at all — RLS is bypassed outright for a superuser, so
// nothing here proves a policy admits or denies the right rows. That needs
// a non-superuser role plus a real auth.uid(), which is what runAsUser
// below sets up: per-transaction `set local role authenticated` plus a
// `request.jwt.claims` GUC carrying the user's id, exactly the two things
// PostgREST sets on every request before running a query. See
// scripts/ci/test-db-bootstrap.sql for the matching auth.uid() definition
// (it reads that same GUC) — without it this file would only ever see
// auth.uid() return NULL and every policy would deny everything, passing
// for the wrong reason.
//
// Scope is deliberately narrow: the core tenant-isolation policies on
// projects and scenes (supabase/migrations/0002_rls.sql), not all ~43
// `create policy` statements across supabase/migrations/. The question
// this answers is the one that matters most — can one user read or mutate
// another user's rows — not full policy coverage.
//
// Gated on TEST_DATABASE_URL exactly like the other store tests:
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/store -run RLS

// runAsUser runs fn inside a fresh transaction acting as the `authenticated`
// role with auth.uid() bound to userID — the same two GUCs PostgREST sets
// per-request. The transaction is always rolled back: these tests only need
// to observe what RLS admits, never to leave writes behind (and a write
// that DOES get through would otherwise need its own cleanup).
func runAsUser(ctx context.Context, t *testing.T, s *Store, userID string, fn func(tx pgx.Tx)) {
	t.Helper()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() {
		if err := tx.Rollback(ctx); err != nil && err != pgx.ErrTxClosed {
			t.Errorf("rollback: %v", err)
		}
	}()

	if _, err := tx.Exec(ctx, `set local role authenticated`); err != nil {
		t.Fatalf("set local role authenticated: %v", err)
	}
	claims := fmt.Sprintf(`{"sub":"%s"}`, userID)
	if _, err := tx.Exec(ctx,
		`select set_config('request.jwt.claims', $1, true)`, claims,
	); err != nil {
		t.Fatalf("set request.jwt.claims: %v", err)
	}

	fn(tx)
}

// projectOwner reads a project's user_id via the superuser pool — used to
// recover the id a seeded project belongs to so it can be passed to
// runAsUser, since seedRenderingScene only returns project/scene ids.
func projectOwner(ctx context.Context, t *testing.T, s *Store, projectID string) string {
	t.Helper()
	var userID string
	if err := s.pool.QueryRow(ctx,
		`select user_id from projects where id = $1`, projectID,
	).Scan(&userID); err != nil {
		t.Fatalf("lookup project owner: %v", err)
	}
	return userID
}

// TestRLSProjectsAndScenesTenantIsolation seeds two independent users (via
// seedRenderingScene, same as every other store test — each call creates
// its own auth.users/projects/scenes chain), then, acting as user A through
// runAsUser, asserts:
//
//   - user A can select their own project and scene
//   - user A gets ZERO rows for user B's project and scene — RLS filters
//     silently, it does not raise an error
//   - user A's UPDATE and DELETE against user B's rows affect ZERO rows
//
// If projects_select/scenes_select ever regress to something that admits
// other users' rows (e.g. widened to `using (true)`), the zero-rows
// assertions below fail.
//
// The unqualified-write subtests matter more than they look. A targeted
// `update ... where id = <other user's row>` is NOT a test of the UPDATE
// policy: Postgres applies SELECT policies to the WHERE lookup first, so
// the row is filtered out before the UPDATE policy is ever consulted, and
// the statement reports 0 rows even when the UPDATE policy is wide open.
// Measured directly against this schema, with projects_update_own widened
// to `using (true)`:
//
//	update projects set title='pwned' where id=<B>  -> UPDATE 0  (looks safe)
//	update projects set title='pwned'               -> UPDATE 2  (both users' rows)
//
// So the write policies are only genuinely exercised by an UNqualified
// write, where no WHERE clause exists for a SELECT policy to filter and
// the UPDATE/DELETE `using` clause alone decides the target rows. Both
// forms are asserted below: the targeted one pins the read boundary, the
// unqualified one pins the write boundary.
func TestRLSProjectsAndScenesTenantIsolation(t *testing.T) {
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
	projectB, sceneB := seedRenderingScene(ctx, t, s)
	userA := projectOwner(ctx, t, s, projectA)

	t.Run("select_own_rows", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx,
				`select count(*) from projects where id = $1`, projectA,
			).Scan(&count); err != nil {
				t.Fatalf("select own project: %v", err)
			}
			if count != 1 {
				t.Errorf("own project visible rows = %d, want 1", count)
			}

			if err := tx.QueryRow(ctx,
				`select count(*) from scenes where id = $1`, sceneA,
			).Scan(&count); err != nil {
				t.Fatalf("select own scene: %v", err)
			}
			if count != 1 {
				t.Errorf("own scene visible rows = %d, want 1", count)
			}
		})
	})

	t.Run("select_other_users_rows_returns_zero_not_error", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx,
				`select count(*) from projects where id = $1`, projectB,
			).Scan(&count); err != nil {
				t.Fatalf("select other user's project: %v", err)
			}
			if count != 0 {
				t.Errorf("other user's project visible rows = %d, want 0 (RLS must filter, not error)", count)
			}

			if err := tx.QueryRow(ctx,
				`select count(*) from scenes where id = $1`, sceneB,
			).Scan(&count); err != nil {
				t.Fatalf("select other user's scene: %v", err)
			}
			if count != 0 {
				t.Errorf("other user's scene visible rows = %d, want 0 (RLS must filter, not error)", count)
			}
		})
	})

	t.Run("update_other_users_rows_affects_zero", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`update projects set title = 'pwned' where id = $1`, projectB,
			)
			if err != nil {
				t.Fatalf("update other user's project: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("update other user's project affected %d rows, want 0", tag.RowsAffected())
			}

			tag, err = tx.Exec(ctx,
				`update scenes set status = 'failed' where id = $1`, sceneB,
			)
			if err != nil {
				t.Fatalf("update other user's scene: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("update other user's scene affected %d rows, want 0", tag.RowsAffected())
			}
		})
	})

	t.Run("delete_other_users_rows_affects_zero", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from scenes where id = $1`, sceneB)
			if err != nil {
				t.Fatalf("delete other user's scene: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("delete other user's scene affected %d rows, want 0", tag.RowsAffected())
			}

			tag, err = tx.Exec(ctx, `delete from projects where id = $1`, projectB)
			if err != nil {
				t.Fatalf("delete other user's project: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("delete other user's project affected %d rows, want 0", tag.RowsAffected())
			}
		})
	})

	// The subtests that actually pin the WRITE policies — see this test's
	// doc comment. No WHERE clause, so there is nothing for a SELECT policy
	// to filter and the UPDATE/DELETE `using` clause alone chooses the rows.
	// Acting as user A, an unqualified write must reach A's own row and
	// NEVER B's, so the affected count is exactly the number of A's own
	// rows. Rolled back like every other runAsUser body.
	t.Run("unqualified_update_never_touches_other_users_rows", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var ownProjects int
			if err := tx.QueryRow(ctx, `select count(*) from projects`).Scan(&ownProjects); err != nil {
				t.Fatalf("count visible projects: %v", err)
			}

			tag, err := tx.Exec(ctx, `update projects set title = 'pwned'`)
			if err != nil {
				t.Fatalf("unqualified update projects: %v", err)
			}
			if tag.RowsAffected() != int64(ownProjects) {
				t.Errorf("unqualified update affected %d projects, want %d (own rows only) — "+
					"a higher count means the UPDATE policy admits another user's rows",
					tag.RowsAffected(), ownProjects)
			}

			var ownScenes int
			if err := tx.QueryRow(ctx, `select count(*) from scenes`).Scan(&ownScenes); err != nil {
				t.Fatalf("count visible scenes: %v", err)
			}
			tag, err = tx.Exec(ctx, `update scenes set status = 'failed'`)
			if err != nil {
				t.Fatalf("unqualified update scenes: %v", err)
			}
			if tag.RowsAffected() != int64(ownScenes) {
				t.Errorf("unqualified update affected %d scenes, want %d (own rows only)",
					tag.RowsAffected(), ownScenes)
			}
		})
	})

	t.Run("unqualified_delete_never_touches_other_users_rows", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var ownScenes int
			if err := tx.QueryRow(ctx, `select count(*) from scenes`).Scan(&ownScenes); err != nil {
				t.Fatalf("count visible scenes: %v", err)
			}
			tag, err := tx.Exec(ctx, `delete from scenes`)
			if err != nil {
				t.Fatalf("unqualified delete scenes: %v", err)
			}
			if tag.RowsAffected() != int64(ownScenes) {
				t.Errorf("unqualified delete affected %d scenes, want %d (own rows only) — "+
					"a higher count means the DELETE policy admits another user's rows",
					tag.RowsAffected(), ownScenes)
			}
		})
	})

	// Belt-and-suspenders: confirm none of the update/delete attempts above
	// actually leaked through despite every transaction being rolled back —
	// catches a mistake in runAsUser itself (e.g. a missing rollback) rather
	// than trusting the rollback silently.
	var title, status string
	if err := s.pool.QueryRow(ctx,
		`select title from projects where id = $1`, projectB,
	).Scan(&title); err != nil {
		t.Fatalf("post-check project B: %v", err)
	}
	if title != "markfailed race test" {
		t.Errorf("project B title = %q, want unchanged (a rolled-back update leaked)", title)
	}
	if err := s.pool.QueryRow(ctx,
		`select status from scenes where id = $1`, sceneB,
	).Scan(&status); err != nil {
		t.Fatalf("post-check scene B: %v", err)
	}
	if status != "rendering" {
		t.Errorf("scene B status = %q, want unchanged (a rolled-back update leaked)", status)
	}
}

// TestRLSApiTokensAndSecurityDefinerRPCs pins the column-level GRANTs and RLS
// on api_tokens, and verifies that the SECURITY DEFINER RPCs introduced in
// 0127_api_tokens.sql cannot be executed by anon or authenticated roles, and
// reject spoofed ownership / non-positive estimates when called by service_role.
func TestRLSApiTokensAndSecurityDefinerRPCs(t *testing.T) {
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

	projectA, _ := seedRenderingScene(ctx, t, s)
	projectB, _ := seedRenderingScene(ctx, t, s)
	userA := projectOwner(ctx, t, s, projectA)
	userB := projectOwner(ctx, t, s, projectB)

	var tokenA, tokenB string
	if err := s.pool.QueryRow(ctx,
		`insert into api_tokens (user_id, name, token_hash, token_prefix)
		 values ($1, 'token-a', repeat('a', 64), 'ms_live_aaaa')
		 returning id`, userA,
	).Scan(&tokenA); err != nil {
		t.Fatalf("seed token A: %v", err)
	}
	if err := s.pool.QueryRow(ctx,
		`insert into api_tokens (user_id, name, token_hash, token_prefix)
		 values ($1, 'token-b', repeat('b', 64), 'ms_live_bbbb')
		 returning id`, userB,
	).Scan(&tokenB); err != nil {
		t.Fatalf("seed token B: %v", err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `delete from api_tokens where id in ($1, $2)`, tokenA, tokenB)
	})

	t.Run("authenticated_selects_own_metadata_not_other_users_and_not_token_hash", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx,
				`select count(id) from api_tokens where id = $1`, tokenA,
			).Scan(&count); err != nil {
				t.Fatalf("select own token metadata: %v", err)
			}
			if count != 1 {
				t.Errorf("own token visible rows = %d, want 1", count)
			}

			if err := tx.QueryRow(ctx,
				`select count(id) from api_tokens where id = $1`, tokenB,
			).Scan(&count); err != nil {
				t.Fatalf("select other user's token metadata: %v", err)
			}
			if count != 0 {
				t.Errorf("other user's token visible rows = %d, want 0", count)
			}

			var hash string
			if err := tx.QueryRow(ctx,
				`select token_hash from api_tokens where id = $1`, tokenA,
			).Scan(&hash); err == nil {
				t.Errorf("authenticated read token_hash = %q, want permission denied (42501)", hash)
			}

			if _, err := tx.Exec(ctx,
				`insert into api_tokens (user_id, name, token_hash, token_prefix) values ($1, 'x', repeat('c', 64), 'ms_live_cccc')`,
				userA,
			); err == nil {
				t.Errorf("authenticated insert into api_tokens succeeded, want permission denied")
			}

			if _, err := tx.Exec(ctx,
				`update api_tokens set name = 'pwned' where id = $1`, tokenA,
			); err == nil {
				t.Errorf("authenticated update api_tokens succeeded, want permission denied")
			}

			if _, err := tx.Exec(ctx,
				`delete from api_tokens where id = $1`, tokenA,
			); err == nil {
				t.Errorf("authenticated delete api_tokens succeeded, want permission denied")
			}
		})
	})

	t.Run("security_definer_rpcs_revoked_from_anon_and_authenticated", func(t *testing.T) {
		rpcs := []struct {
			signature string
			query     string
		}{
			{"public.insert_frame_ready_scene(uuid, uuid, integer, boolean, text, text, jsonb, boolean, uuid, text, text, uuid)", `select * from public.insert_frame_ready_scene(NULL::uuid, NULL::uuid, NULL::integer, NULL::boolean, NULL::text, NULL::text, NULL::jsonb, NULL::boolean, NULL::uuid, NULL::text, NULL::text, NULL::uuid)`},
			{"public.attach_scene_references_fenced(uuid, uuid, uuid, jsonb)", `select public.attach_scene_references_fenced(NULL::uuid, NULL::uuid, NULL::uuid, NULL::jsonb)`},
			{"public.reclaim_stale_frame_ready_scene(uuid, uuid, uuid, uuid)", `select * from public.reclaim_stale_frame_ready_scene(NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid)`},
			{"public.delete_abandoned_api_scene(uuid, uuid)", `select * from public.delete_abandoned_api_scene(NULL::uuid, NULL::uuid)`},
			{"public.queue_scenes_if_within_caps(uuid, uuid, uuid[], numeric[], uuid, uuid, boolean, jsonb, timestamp with time zone, timestamp with time zone, timestamp with time zone, timestamp with time zone, timestamp with time zone, boolean, numeric, text, numeric, numeric, boolean, numeric)", `select * from public.queue_scenes_if_within_caps(NULL::uuid, NULL::uuid, NULL::uuid[], NULL::numeric[], NULL::uuid, NULL::uuid, NULL::boolean, NULL::jsonb, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, NULL::boolean, NULL::numeric, NULL::text, NULL::numeric, NULL::numeric, NULL::boolean, NULL::numeric)`},
		}
		for _, rpc := range rpcs {
			for _, role := range []string{"anon", "authenticated"} {
				var has bool
				if err := s.pool.QueryRow(ctx,
					`select has_function_privilege($1, $2, 'EXECUTE')`, role, rpc.signature,
				).Scan(&has); err != nil {
					t.Fatalf("check %s EXECUTE on %s: %v", role, rpc.signature, err)
				}
				if has {
					t.Errorf("role %s holds EXECUTE on %s, want false", role, rpc.signature)
				}

				tx, err := s.pool.Begin(ctx)
				if err != nil {
					t.Fatalf("begin %s RPC check: %v", role, err)
				}
				if _, err := tx.Exec(ctx, "set local role "+role); err != nil {
					_ = tx.Rollback(ctx)
					t.Fatalf("set local role %s: %v", role, err)
				}
				_, callErr := tx.Exec(ctx, rpc.query)
				_ = tx.Rollback(ctx)
				var pgErr *pgconn.PgError
				if !errors.As(callErr, &pgErr) || pgErr.Code != "42501" {
					t.Errorf("role %s call %s error = %v, want SQLSTATE 42501", role, rpc.signature, callErr)
				}
			}
		}
	})

	t.Run("queue_scenes_if_within_caps_verifies_ownership_and_estimates", func(t *testing.T) {
		var frameSceneID string
		if err := s.pool.QueryRow(ctx,
			`select scene_id from public.insert_frame_ready_scene(
				$1, $2, 4, false, 'test', null, '{}'::jsonb, true, $3, null, null, $4
			)`, projectA, userA, tokenA, "00000000-0000-7000-8000-000000000127",
		).Scan(&frameSceneID); err != nil {
			t.Fatalf("insert_frame_ready_scene: %v", err)
		}
		prepareToken := "00000000-0000-7000-8000-000000000127"
		queueSQL := `select * from public.queue_scenes_if_within_caps(
			$1::uuid, $2::uuid, array[$3::uuid], array[$4::numeric], $5::uuid, $6::uuid,
			true, null::jsonb, now(), now(), now(), now(), now(), true, 100, 'daily', 100, 100, false, null
		)`

		// Mismatched expected_user_id must raise an exception.
		if _, err := s.pool.Exec(ctx,
			queueSQL, projectA, userB, frameSceneID, 0.56, prepareToken, tokenA,
		); err == nil {
			t.Errorf("queue_scenes_if_within_caps with wrong expected_user_id succeeded, want exception")
		}

		// Cross-user token B on user A's scene must raise an exception.
		if _, err := s.pool.Exec(ctx,
			queueSQL, projectA, userA, frameSceneID, 0.56, prepareToken, tokenB,
		); err == nil {
			t.Errorf("queue_scenes_if_within_caps with cross-user api_token_id succeeded, want exception")
		}

		// Non-positive estimate must raise an exception.
		if _, err := s.pool.Exec(ctx,
			queueSQL, projectA, userA, frameSceneID, 0, prepareToken, tokenA,
		); err == nil {
			t.Errorf("queue_scenes_if_within_caps with 0 estimate succeeded, want exception")
		}
	})
}
