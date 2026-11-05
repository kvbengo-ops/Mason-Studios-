package store

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// This file extends rls_test.go's methodology (see that file's header for
// the full rationale on runAsUser/projectOwner and why every write policy
// must ALSO be asserted with an unqualified statement, never only a
// targeted `where id = ...`) to three more tables:
//
//   - allowance_requests (0032_allowance_requests.sql, fixed by
//     0033_allowance_requests_rls_fix.sql)
//   - runs (0030_runs_project_id.sql)
//   - assets (0002_rls.sql)
//
// Same rules apply: seed via the superuser pool, act via runAsUser, roll
// every transaction back, and never trust a targeted UPDATE/DELETE to prove
// a write policy — only an unqualified one does that, because Postgres
// filters the WHERE-clause target row through the table's SELECT policy
// before the UPDATE/DELETE policy is ever consulted.

// seedUser creates a bare auth.users row (and, via handle_new_user, its
// profiles row) with no project attached — for allowance_requests tests and
// for seeding an admin, neither of which needs a project to exist at all.
func seedUser(ctx context.Context, t *testing.T, s *Store) (userID string) {
	t.Helper()

	var rawUUID string
	if err := s.pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&rawUUID); err != nil {
		t.Fatalf("seed unique id: %v", err)
	}
	rawID := strings.ReplaceAll(rawUUID, "-", "")
	username := ("r" + rawID)[:20]
	email := fmt.Sprintf("rls-test-%s@example.test", rawID)

	if err := s.pool.QueryRow(ctx, `
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES (gen_random_uuid(), $1, jsonb_build_object('username', $2::text))
RETURNING id`, email, username).Scan(&userID); err != nil {
		t.Fatalf("seed auth user: %v", err)
	}

	setProfileStatus(ctx, t, s, userID, "active")

	t.Cleanup(func() {
		for _, q := range []struct{ sql, arg string }{
			{`DELETE FROM profiles WHERE id = $1`, userID},
			{`DELETE FROM auth.users WHERE id = $1`, userID},
		} {
			if _, err := s.pool.Exec(context.Background(), q.sql, q.arg); err != nil {
				t.Errorf("cleanup %q: %v", q.sql, err)
			}
		}
	})

	return userID
}

// makeAdmin flips a seeded user's profiles.role to 'admin' via the
// superuser pool (bypassing RLS, same as every other seed helper) — the
// mechanism is_admin() (0002_rls.sql) actually checks.
func makeAdmin(ctx context.Context, t *testing.T, s *Store, userID string) {
	t.Helper()
	if _, err := s.pool.Exec(ctx, `UPDATE profiles SET role = 'admin' WHERE id = $1`, userID); err != nil {
		t.Fatalf("promote to admin: %v", err)
	}
}

// setProfileStatus flips a seeded user's profiles.status via the superuser
// pool (bypassing RLS, same as every other seed helper) — the mechanism
// is_active() (0052_account_approval.sql) actually checks.
//
// Every seed helper calls this with 'active' immediately after creating the
// auth.users row, and that call is load-bearing rather than tidiness:
// handle_new_user() leaves a brand-new profile 'pending' (0052 flips the
// column default once it has backfilled the accounts that already existed),
// and a pending account is denied by every write policy carrying
// is_active() — projects_insert_own (0052) plus the nine scenes/assets/runs
// write policies (0053_active_gate_on_child_writes.sql). Without it, the
// tenant-isolation tests in this package would pass for the wrong reason:
// the write denied because the account was never approved, not because the
// row belongs to somebody else. rls_account_status_test.go is where a
// non-active account is the thing under test.
func setProfileStatus(ctx context.Context, t *testing.T, s *Store, userID, status string) {
	t.Helper()
	if _, err := s.pool.Exec(ctx, `UPDATE profiles SET status = $2 WHERE id = $1`, userID, status); err != nil {
		t.Fatalf("set profile status %q: %v", status, err)
	}
}

// seedAllowanceRequest inserts a request row for userID with the given
// status. For a non-'pending' status, decided_by/decided_at are populated
// (as decideAllowanceRequest would leave them) so the row looks like a
// genuinely decided request, not a pending one with a stray status value.
func seedAllowanceRequest(ctx context.Context, t *testing.T, s *Store, userID, status string, decidedBy *string) (id string) {
	t.Helper()

	if status == "pending" {
		if err := s.pool.QueryRow(ctx, `
INSERT INTO allowance_requests (user_id, requested_usd, status)
VALUES ($1, 5, 'pending')
RETURNING id`, userID).Scan(&id); err != nil {
			t.Fatalf("seed pending allowance_request: %v", err)
		}
	} else {
		if err := s.pool.QueryRow(ctx, `
INSERT INTO allowance_requests (user_id, requested_usd, status, decided_by, decided_at)
VALUES ($1, 5, $2, $3, now())
RETURNING id`, userID, status, decidedBy).Scan(&id); err != nil {
			t.Fatalf("seed decided allowance_request: %v", err)
		}
	}

	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(), `DELETE FROM allowance_requests WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup allowance_request %s: %v", id, err)
		}
	})

	return id
}

// seedRun inserts a runs row attributed to projectID/sceneID — see
// 0030_runs_project_id.sql for why project_id (not just scene_id) is what
// the runs_* policies now key off.
func seedRun(ctx context.Context, t *testing.T, s *Store, projectID, sceneID string) (id string) {
	t.Helper()
	if err := s.pool.QueryRow(ctx, `
INSERT INTO runs (project_id, scene_id, vendor, model, cost_usd)
VALUES ($1, $2, 'fal', 'rls-test-model', 0.01)
RETURNING id`, projectID, sceneID).Scan(&id); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(), `DELETE FROM runs WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup run %s: %v", id, err)
		}
	})
	return id
}

// seedAsset inserts an assets row for projectID/sceneID.
func seedAsset(ctx context.Context, t *testing.T, s *Store, projectID, sceneID string) (id string) {
	t.Helper()
	if err := s.pool.QueryRow(ctx, `
INSERT INTO assets (project_id, scene_id, kind, storage_key)
VALUES ($1, $2, 'clip', 'media/rls-test.mp4')
RETURNING id`, projectID, sceneID).Scan(&id); err != nil {
		t.Fatalf("seed asset: %v", err)
	}
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(), `DELETE FROM assets WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup asset %s: %v", id, err)
		}
	})
	return id
}

// =============================================================================
// allowance_requests (0032, fixed by 0033)
// =============================================================================
//
// Users:
//   - userA: owns reqAPending ('pending') and reqAApproved ('approved',
//     decided by adminUser) — one user can hold both at once since the
//     one-pending-per-user unique index is partial on status='pending'.
//     reqAApproved exists specifically to reproduce the bug 0033 fixed: a
//     non-admin rewriting their OWN already-decided request.
//   - userA2: a clean user with no requests at all, used only for the
//     insert-policy subtests, so they never collide with the partial
//     unique index on userA's pending row.
//   - userB: owns reqBPending, the cross-user target.
//   - adminUser: profiles.role = 'admin'.
func TestRLSAllowanceRequestsTenantIsolation(t *testing.T) {
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

	userA := seedUser(ctx, t, s)
	userA2 := seedUser(ctx, t, s)
	userB := seedUser(ctx, t, s)
	// userB2 has NO seeded allowance_requests row at all, unlike userB —
	// used only as the insert-for-another-user target below. userB already
	// has a committed pending row, so an insert of a second pending row for
	// userB would be rejected by allowance_requests_one_pending_per_user
	// regardless of what the INSERT policy's with check says, which would
	// make that subtest pass for the wrong reason even with the policy
	// broken. userB2 has no such row, so the unique index can never be the
	// thing blocking that insert — only the RLS with check can be.
	userB2 := seedUser(ctx, t, s)
	adminUser := seedUser(ctx, t, s)
	makeAdmin(ctx, t, s, adminUser)

	reqAPending := seedAllowanceRequest(ctx, t, s, userA, "pending", nil)
	reqAApproved := seedAllowanceRequest(ctx, t, s, userA, "approved", &adminUser)
	reqBPending := seedAllowanceRequest(ctx, t, s, userB, "pending", nil)

	t.Run("select_own_rows", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx,
				`select count(*) from allowance_requests where id = $1`, reqAPending,
			).Scan(&count); err != nil {
				t.Fatalf("select own request: %v", err)
			}
			if count != 1 {
				t.Errorf("own request visible rows = %d, want 1", count)
			}
		})
	})

	t.Run("select_other_users_pending_request_returns_zero", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx,
				`select count(*) from allowance_requests where id = $1`, reqBPending,
			).Scan(&count); err != nil {
				t.Fatalf("select other user's request: %v", err)
			}
			if count != 0 {
				t.Errorf("other user's request visible rows = %d, want 0", count)
			}
		})
	})

	t.Run("admin_can_select_other_users_request", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx,
				`select count(*) from allowance_requests where id = $1`, reqBPending,
			).Scan(&count); err != nil {
				t.Fatalf("admin select other user's request: %v", err)
			}
			if count != 1 {
				t.Errorf("admin visible rows for other user's request = %d, want 1 (admin read access is being denied uselessly strict)", count)
			}
		})
	})

	t.Run("insert_own_pending_succeeds", func(t *testing.T) {
		runAsUser(ctx, t, s, userA2, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`insert into allowance_requests (user_id, requested_usd, status) values ($1, 5, 'pending')`, userA2,
			)
			if err != nil {
				t.Fatalf("insert own pending request: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("insert own pending request affected %d rows, want 1", tag.RowsAffected())
			}
		})
	})

	t.Run("insert_for_other_user_denied", func(t *testing.T) {
		runAsUser(ctx, t, s, userA2, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into allowance_requests (user_id, requested_usd, status) values ($1, 5, 'pending')`, userB2,
			)
			if err == nil {
				t.Errorf("insert of a request for another user succeeded, want RLS denial")
			}
		})
	})

	t.Run("insert_non_pending_status_denied", func(t *testing.T) {
		runAsUser(ctx, t, s, userA2, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into allowance_requests (user_id, requested_usd, status) values ($1, 5, 'approved')`, userA2,
			)
			if err == nil {
				t.Errorf("insert with status='approved' succeeded, want RLS denial (with check forces status='pending')")
			}
		})
	})

	t.Run("update_own_pending_to_cancelled_succeeds", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`update allowance_requests set status = 'cancelled' where id = $1`, reqAPending,
			)
			if err != nil {
				t.Fatalf("cancel own pending request: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("cancel own pending request affected %d rows, want 1", tag.RowsAffected())
			}
		})
	})

	t.Run("update_other_users_pending_request_denied_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`update allowance_requests set status = 'cancelled' where id = $1`, reqBPending,
			)
			if err != nil {
				t.Fatalf("update other user's request: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("update other user's request affected %d rows, want 0", tag.RowsAffected())
			}
		})
	})

	// The 0033 regression, reproduced directly: a non-admin rewriting their
	// OWN already-'approved' request. This is a valid TARGETED test (not
	// merely a SELECT-policy proxy) because the row belongs to userA and is
	// therefore visible under allowance_requests_select regardless of its
	// status — only the UPDATE policy's own `using` clause (status =
	// 'pending', added by 0033) can reject it. Before 0033, `using` had no
	// status predicate at all, so this same statement affected 1 row.
	t.Run("update_own_already_decided_request_denied", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`update allowance_requests set status = 'cancelled' where id = $1`, reqAApproved,
			)
			if err != nil {
				t.Fatalf("update own decided request: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("update own already-decided request affected %d rows, want 0 "+
					"(this is the exact hole 0033_allowance_requests_rls_fix.sql closed)", tag.RowsAffected())
			}
		})
	})

	t.Run("admin_can_update_other_users_pending_request", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`update allowance_requests set status = 'denied', decided_by = $2, decided_at = now() where id = $1`,
				reqBPending, adminUser,
			)
			if err != nil {
				t.Fatalf("admin update other user's request: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("admin update other user's request affected %d rows, want 1 (admin write access is being denied uselessly strict)", tag.RowsAffected())
			}
		})
	})

	// Unqualified: no WHERE for a SELECT policy to filter, so the UPDATE
	// `using` clause alone decides which rows are touched. userA owns TWO
	// rows (reqAPending, reqAApproved) but only the pending one should be
	// reachable by a non-admin's own unqualified write — if `using` ever
	// loses its status predicate again, this affects 2 rows instead of 1.
	t.Run("unqualified_update_never_touches_other_users_or_non_pending_rows", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var ownPending int
			if err := tx.QueryRow(ctx,
				`select count(*) from allowance_requests where status = 'pending'`,
			).Scan(&ownPending); err != nil {
				t.Fatalf("count own pending requests: %v", err)
			}
			tag, err := tx.Exec(ctx, `update allowance_requests set status = 'cancelled'`)
			if err != nil {
				t.Fatalf("unqualified update allowance_requests: %v", err)
			}
			if tag.RowsAffected() != int64(ownPending) {
				t.Errorf("unqualified update affected %d requests, want %d (own PENDING rows only) — "+
					"a higher count means the UPDATE policy admits another user's row or a non-pending row of your own",
					tag.RowsAffected(), ownPending)
			}
		})
	})
}

// =============================================================================
// runs (0030_runs_project_id.sql)
// =============================================================================
func TestRLSRunsTenantIsolation(t *testing.T) {
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
	adminUser := seedUser(ctx, t, s)
	makeAdmin(ctx, t, s, adminUser)

	runA := seedRun(ctx, t, s, projectA, sceneA)
	runB := seedRun(ctx, t, s, projectB, sceneB)

	t.Run("select_own_rows", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from runs where id = $1`, runA).Scan(&count); err != nil {
				t.Fatalf("select own run: %v", err)
			}
			if count != 1 {
				t.Errorf("own run visible rows = %d, want 1", count)
			}
		})
	})

	t.Run("select_other_users_run_returns_zero", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from runs where id = $1`, runB).Scan(&count); err != nil {
				t.Fatalf("select other user's run: %v", err)
			}
			if count != 0 {
				t.Errorf("other user's run visible rows = %d, want 0", count)
			}
		})
	})

	t.Run("admin_can_select_other_users_run", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from runs where id = $1`, runB).Scan(&count); err != nil {
				t.Fatalf("admin select other user's run: %v", err)
			}
			if count != 1 {
				t.Errorf("admin visible rows for other user's run = %d, want 1 (admin read access is being denied uselessly strict)", count)
			}
		})
	})

	t.Run("insert_own_run_succeeds", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`insert into runs (project_id, scene_id, vendor, model, cost_usd) values ($1, $2, 'fal', 'm', 0.01)`,
				projectA, sceneA,
			)
			if err != nil {
				t.Fatalf("insert own run: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("insert own run affected %d rows, want 1", tag.RowsAffected())
			}
		})
	})

	t.Run("insert_for_other_users_project_denied", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into runs (project_id, scene_id, vendor, model, cost_usd) values ($1, $2, 'fal', 'm', 0.01)`,
				projectB, sceneB,
			)
			if err == nil {
				t.Errorf("insert of a run for another user's project succeeded, want RLS denial")
			}
		})
	})

	t.Run("update_other_users_run_denied_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update runs set cost_usd = 999 where id = $1`, runB)
			if err != nil {
				t.Fatalf("update other user's run: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("update other user's run affected %d rows, want 0", tag.RowsAffected())
			}
		})
	})

	t.Run("unqualified_update_never_touches_other_users_runs", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var ownRuns int
			if err := tx.QueryRow(ctx, `select count(*) from runs`).Scan(&ownRuns); err != nil {
				t.Fatalf("count visible runs: %v", err)
			}
			tag, err := tx.Exec(ctx, `update runs set cost_usd = 0.02`)
			if err != nil {
				t.Fatalf("unqualified update runs: %v", err)
			}
			if tag.RowsAffected() != int64(ownRuns) {
				t.Errorf("unqualified update affected %d runs, want %d (own rows only) — "+
					"a higher count means the UPDATE policy admits another user's row",
					tag.RowsAffected(), ownRuns)
			}
		})
	})

	t.Run("unqualified_delete_never_touches_other_users_runs", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var ownRuns int
			if err := tx.QueryRow(ctx, `select count(*) from runs`).Scan(&ownRuns); err != nil {
				t.Fatalf("count visible runs: %v", err)
			}
			tag, err := tx.Exec(ctx, `delete from runs`)
			if err != nil {
				t.Fatalf("unqualified delete runs: %v", err)
			}
			if tag.RowsAffected() != int64(ownRuns) {
				t.Errorf("unqualified delete affected %d runs, want %d (own rows only) — "+
					"a higher count means the DELETE policy admits another user's row",
					tag.RowsAffected(), ownRuns)
			}
		})
	})
}

// =============================================================================
// assets (0002_rls.sql)
// =============================================================================
func TestRLSAssetsTenantIsolation(t *testing.T) {
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
	adminUser := seedUser(ctx, t, s)
	makeAdmin(ctx, t, s, adminUser)

	assetA := seedAsset(ctx, t, s, projectA, sceneA)
	assetB := seedAsset(ctx, t, s, projectB, sceneB)

	t.Run("select_own_rows", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from assets where id = $1`, assetA).Scan(&count); err != nil {
				t.Fatalf("select own asset: %v", err)
			}
			if count != 1 {
				t.Errorf("own asset visible rows = %d, want 1", count)
			}
		})
	})

	t.Run("select_other_users_asset_returns_zero", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from assets where id = $1`, assetB).Scan(&count); err != nil {
				t.Fatalf("select other user's asset: %v", err)
			}
			if count != 0 {
				t.Errorf("other user's asset visible rows = %d, want 0", count)
			}
		})
	})

	t.Run("admin_can_select_other_users_asset", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from assets where id = $1`, assetB).Scan(&count); err != nil {
				t.Fatalf("admin select other user's asset: %v", err)
			}
			if count != 1 {
				t.Errorf("admin visible rows for other user's asset = %d, want 1 (admin read access is being denied uselessly strict)", count)
			}
		})
	})

	t.Run("insert_own_asset_succeeds", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`insert into assets (project_id, scene_id, kind, storage_key) values ($1, $2, 'clip', 'media/x.mp4')`,
				projectA, sceneA,
			)
			if err != nil {
				t.Fatalf("insert own asset: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("insert own asset affected %d rows, want 1", tag.RowsAffected())
			}
		})
	})

	t.Run("insert_for_other_users_project_denied", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into assets (project_id, scene_id, kind, storage_key) values ($1, $2, 'clip', 'media/x.mp4')`,
				projectB, sceneB,
			)
			if err == nil {
				t.Errorf("insert of an asset for another user's project succeeded, want RLS denial")
			}
		})
	})

	// 0085 gave assets an owner column and widened assets_insert to
	//
	//	assets.user_id = auth.uid()
	//	or exists (select 1 from projects p where p.id = assets.project_id and p.user_id = auth.uid())
	//
	// The branches are independent and assets_owner_present_check permits BOTH
	// columns being set, so naming my own user_id was enough to insert into
	// somebody else's project — the second branch was never consulted. That is
	// the shape 0048 had in storage: a permissive branch that is too wide
	// cannot be narrowed by the branch beside it.
	//
	// The three cases below are the whole fix. The first is the hole; the two
	// after it are the reason a narrower policy is not just an outage, because
	// a rule that also refuses the legitimate inserts would pass a test that
	// only checked the first one.
	//
	// Verified by reverting 0086's clause: the first subtest admits the row
	// again and the other two are unaffected.
	t.Run("insert_naming_own_user_id_into_other_users_project_denied", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into assets (user_id, project_id, kind, storage_key)
				 values ($1, $2, 'generated_image', 'users/a/cross-owner.png')`,
				userA, projectB,
			)
			if err == nil {
				t.Errorf("an asset carrying my user_id landed in another user's project, want RLS denial")
			}
		})
	})

	t.Run("insert_own_personal_asset_succeeds", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`insert into assets (user_id, project_id, kind, storage_key)
				 values ($1, null, 'generated_image', 'users/a/mine.png')`,
				userA,
			)
			if err != nil {
				t.Fatalf("insert own project-less asset: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("insert own project-less asset affected %d rows, want 1", tag.RowsAffected())
			}
		})
	})

	t.Run("insert_personal_asset_for_another_user_denied", func(t *testing.T) {
		// The other half of the same rule: naming somebody else as the owner.
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into assets (user_id, project_id, kind, storage_key)
				 values ($1, null, 'generated_image', 'users/b/not-mine.png')`,
				projectOwner(ctx, t, s, projectB),
			)
			if err == nil {
				t.Errorf("inserted a personal asset owned by another user, want RLS denial")
			}
		})
	})

	t.Run("update_other_users_asset_denied_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update assets set storage_key = 'pwned' where id = $1`, assetB)
			if err != nil {
				t.Fatalf("update other user's asset: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("update other user's asset affected %d rows, want 0", tag.RowsAffected())
			}
		})
	})

	t.Run("unqualified_update_never_touches_other_users_assets", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var ownAssets int
			if err := tx.QueryRow(ctx, `select count(*) from assets`).Scan(&ownAssets); err != nil {
				t.Fatalf("count visible assets: %v", err)
			}
			tag, err := tx.Exec(ctx, `update assets set storage_key = 'pwned'`)
			if err != nil {
				t.Fatalf("unqualified update assets: %v", err)
			}
			if tag.RowsAffected() != int64(ownAssets) {
				t.Errorf("unqualified update affected %d assets, want %d (own rows only) — "+
					"a higher count means the UPDATE policy admits another user's row",
					tag.RowsAffected(), ownAssets)
			}
		})
	})

	t.Run("unqualified_delete_never_touches_other_users_assets", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var ownAssets int
			if err := tx.QueryRow(ctx, `select count(*) from assets`).Scan(&ownAssets); err != nil {
				t.Fatalf("count visible assets: %v", err)
			}
			tag, err := tx.Exec(ctx, `delete from assets`)
			if err != nil {
				t.Fatalf("unqualified delete assets: %v", err)
			}
			if tag.RowsAffected() != int64(ownAssets) {
				t.Errorf("unqualified delete affected %d assets, want %d (own rows only) — "+
					"a higher count means the DELETE policy admits another user's row",
					tag.RowsAffected(), ownAssets)
			}
		})
	})
}
