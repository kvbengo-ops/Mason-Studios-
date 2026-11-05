package store

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// This file extends rls_test.go's methodology (see that file's header for
// runAsUser/projectOwner and why every write policy must ALSO be asserted
// with an unqualified statement) to the four tables the prior RLS sweeps
// (rls_test.go, rls_allowance_runs_assets_test.go,
// rls_storage_profiles_grants_test.go) did not touch:
//
//   - characters (0020_characters.sql)
//   - kie_topups (0036_fal_topups.sql)
//   - prompt_templates (0008_prompt_templates_rls.sql)
//   - deleted_project_cost_history (0038_preserve_cost_history_on_delete.sql)
//
// Same rule as every prior file in this package: a policy is only "covered"
// once both directions are proven — the party it is meant to admit genuinely
// CAN do the thing, and everyone else genuinely cannot. The prior sweep found
// 0005's four media_* policies denied EVERYONE, including the row's own
// owner, because a test suite that only checks denial cannot tell "correctly
// closed" from "closed to everyone by a bug." pg_policies confirms all four
// policies here match their migrations verbatim (no stray edit), so unlike
// media_*, none of these are expected to turn up broken — but they are
// checked in both directions anyway, not assumed.

// seedCharacter inserts a characters row via the superuser pool — the row an
// RLS test needs to already exist, same shape as every other seed helper in
// this package.
func seedCharacter(ctx context.Context, t *testing.T, s *Store, createdBy string) (id string) {
	t.Helper()
	if err := s.pool.QueryRow(ctx, `
INSERT INTO characters (name, storage_key, created_by)
VALUES ('rls-test-character', 'characters/rls-test/photo.png', $1)
RETURNING id`, createdBy).Scan(&id); err != nil {
		t.Fatalf("seed character: %v", err)
	}
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(), `DELETE FROM characters WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup character %s: %v", id, err)
		}
	})
	return id
}

// =============================================================================
// characters (0020_characters.sql) — select is `using (true)` with no `to
// authenticated` (deliberate: anon is held out by grants, not the policy —
// see rls_anon_test.go); insert/update/delete are admin-only, one policy per
// verb.
// =============================================================================
func TestRLSCharacters(t *testing.T) {
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
	adminUser := seedUser(ctx, t, s)
	makeAdmin(ctx, t, s, adminUser)

	charByAdmin := seedCharacter(ctx, t, s, adminUser)

	// Positive direction for characters_select: this is the whole point of a
	// SHARED library — a non-admin, authenticated editor must be able to
	// browse an entry an admin created, not merely be denied everything.
	t.Run("non_admin_can_select_library_entry", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from characters where id = $1`, charByAdmin).Scan(&count); err != nil {
				t.Fatalf("select character as non-admin: %v", err)
			}
			if count != 1 {
				t.Errorf("non-admin visible rows for shared character = %d, want 1 (characters_select "+
					"`using (true)` is meant to admit every authenticated reader, not just admins)", count)
			}
		})
	})

	t.Run("admin_can_select_library_entry", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from characters where id = $1`, charByAdmin).Scan(&count); err != nil {
				t.Fatalf("select character as admin: %v", err)
			}
			if count != 1 {
				t.Errorf("admin visible rows = %d, want 1", count)
			}
		})
	})

	// Negative + positive for characters_insert_admin.
	t.Run("non_admin_cannot_insert_character", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into characters (name, storage_key, created_by) values ('pwned', 'characters/pwned/x.png', $1)`,
				userA,
			)
			if err == nil {
				t.Errorf("non-admin insert of a character succeeded, want RLS denial")
			}
		})
	})

	t.Run("admin_can_insert_character", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`insert into characters (name, storage_key, created_by) values ('admin-made', 'characters/admin/x.png', $1)`,
				adminUser,
			)
			if err != nil {
				t.Fatalf("admin insert of a character denied: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("admin insert affected %d rows, want 1 (characters_insert_admin is being denied "+
					"uselessly strict)", tag.RowsAffected())
			}
		})
	})

	// Negative + positive for characters_update_admin. Targeted first (the
	// row IS select-visible to everyone via characters_select `using (true)`,
	// so a 0-row result here is solely the UPDATE policy, not a SELECT-policy
	// proxy). Literal value, never a self-reference.
	t.Run("non_admin_cannot_update_character_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update characters set name = 'pwned' where id = $1`, charByAdmin)
			if err != nil {
				t.Fatalf("update character as non-admin: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("non-admin update of a character affected %d rows, want 0", tag.RowsAffected())
			}
		})
	})

	t.Run("non_admin_cannot_update_character_unqualified", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update characters set name = 'pwned'`)
			if err != nil {
				t.Fatalf("unqualified update characters as non-admin: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified update as non-admin affected %d characters, want 0 (characters_update_admin "+
					"should reject every non-admin row, not just the ones a WHERE happens to name)", tag.RowsAffected())
			}
		})
	})

	t.Run("admin_can_update_character_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update characters set name = 'renamed-by-admin' where id = $1`, charByAdmin)
			if err != nil {
				t.Fatalf("admin update of a character denied: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("admin update affected %d rows, want 1 (characters_update_admin is being denied "+
					"uselessly strict)", tag.RowsAffected())
			}
		})
	})

	// Negative + positive for characters_delete_admin. Non-admin delete
	// attempted first so the row still exists for the admin subtest below.
	t.Run("non_admin_cannot_delete_character_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from characters where id = $1`, charByAdmin)
			if err != nil {
				t.Fatalf("delete character as non-admin: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("non-admin delete of a character affected %d rows, want 0", tag.RowsAffected())
			}
		})
	})

	t.Run("non_admin_cannot_delete_character_unqualified", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from characters`)
			if err != nil {
				t.Fatalf("unqualified delete characters as non-admin: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified delete as non-admin affected %d characters, want 0", tag.RowsAffected())
			}
		})
	})

	t.Run("admin_can_delete_character_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from characters where id = $1`, charByAdmin)
			if err != nil {
				t.Fatalf("admin delete of a character denied: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("admin delete affected %d rows, want 1 (characters_delete_admin is being denied "+
					"uselessly strict)", tag.RowsAffected())
			}
		})
	})
}

// seedKieTopup inserts a kie_topups row via the superuser pool.
func seedKieTopup(ctx context.Context, t *testing.T, s *Store, recordedBy string) (id string) {
	t.Helper()
	if err := s.pool.QueryRow(ctx, `
INSERT INTO kie_topups (amount_usd, recorded_by)
VALUES (10, $1)
RETURNING id`, recordedBy).Scan(&id); err != nil {
		t.Fatalf("seed fal_topup: %v", err)
	}
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(), `DELETE FROM kie_topups WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup fal_topup %s: %v", id, err)
		}
	})
	return id
}

// =============================================================================
// kie_topups (0036_fal_topups.sql) — admin-only select AND insert; no
// update/delete policy at all (a ledger, per this table's own comment).
// =============================================================================
func TestRLSKieTopups(t *testing.T) {
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
	adminUser := seedUser(ctx, t, s)
	makeAdmin(ctx, t, s, adminUser)

	topup := seedKieTopup(ctx, t, s, adminUser)

	// Negative + positive for kie_topups_select_admin.
	t.Run("non_admin_cannot_select_topup", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from kie_topups where id = $1`, topup).Scan(&count); err != nil {
				t.Fatalf("select topup as non-admin: %v", err)
			}
			if count != 0 {
				t.Errorf("non-admin visible rows for a kie_topups row = %d, want 0", count)
			}
		})
	})

	t.Run("admin_can_select_topup", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from kie_topups where id = $1`, topup).Scan(&count); err != nil {
				t.Fatalf("select topup as admin: %v", err)
			}
			if count != 1 {
				t.Errorf("admin visible rows = %d, want 1 (kie_topups_select_admin is being denied uselessly "+
					"strict)", count)
			}
		})
	})

	// Negative + positive for kie_topups_insert_admin, which pins BOTH
	// conjuncts of `is_admin() and recorded_by = auth.uid()`.
	t.Run("non_admin_cannot_insert_topup", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into kie_topups (amount_usd, recorded_by) values (10, $1)`, userA,
			)
			if err == nil {
				t.Errorf("non-admin insert of a kie_topups row succeeded, want RLS denial")
			}
		})
	})

	// An admin cannot forge another admin's identity as recorded_by — pins
	// the `recorded_by = auth.uid()` conjunct specifically, not just
	// `is_admin()`.
	t.Run("admin_cannot_insert_topup_recorded_by_another_admin", func(t *testing.T) {
		otherAdmin := seedUser(ctx, t, s)
		makeAdmin(ctx, t, s, otherAdmin)
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into kie_topups (amount_usd, recorded_by) values (10, $1)`, otherAdmin,
			)
			if err == nil {
				t.Errorf("admin insert of a kie_topups row claiming ANOTHER admin as recorded_by succeeded, " +
					"want RLS denial (recorded_by = auth.uid() conjunct)")
			}
		})
	})

	t.Run("admin_can_insert_topup_recorded_by_self", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`insert into kie_topups (amount_usd, recorded_by) values (10, $1)`, adminUser,
			)
			if err != nil {
				t.Fatalf("admin insert of a kie_topups row denied: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("admin insert affected %d rows, want 1 (kie_topups_insert_admin is being denied "+
					"uselessly strict)", tag.RowsAffected())
			}
		})
	})

	// No update/delete policy at all — default-deny for both, admin
	// included. Targeted first (select-visible to the admin, so a 0-row
	// result isolates the missing write policy), then unqualified.
	t.Run("admin_cannot_update_topup_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update kie_topups set amount_usd = 999 where id = $1`, topup)
			if err != nil {
				t.Fatalf("admin update kie_topups: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("admin update of a kie_topups row affected %d rows, want 0 (no update policy exists "+
					"on kie_topups at all — a ledger, never rewritten)", tag.RowsAffected())
			}
		})
	})

	t.Run("admin_cannot_update_topup_unqualified", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update kie_topups set amount_usd = 999`)
			if err != nil {
				t.Fatalf("unqualified admin update kie_topups: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified admin update affected %d kie_topups rows, want 0", tag.RowsAffected())
			}
		})
	})

	t.Run("admin_cannot_delete_topup_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from kie_topups where id = $1`, topup)
			if err != nil {
				t.Fatalf("admin delete kie_topups: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("admin delete of a kie_topups row affected %d rows, want 0 (no delete policy exists "+
					"on kie_topups at all)", tag.RowsAffected())
			}
		})
	})

	t.Run("admin_cannot_delete_topup_unqualified", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from kie_topups`)
			if err != nil {
				t.Fatalf("unqualified admin delete kie_topups: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified admin delete affected %d kie_topups rows, want 0", tag.RowsAffected())
			}
		})
	})
}

// =============================================================================
// prompt_templates (0008_prompt_templates_rls.sql) — a single select policy,
// `using (true)` `to authenticated`, no user_id to scope against. Seeded by
// migration (0003_seed_template.sql et al.), so at least one row already
// exists on any migrated database — no seed helper needed.
// =============================================================================
func TestRLSPromptTemplates(t *testing.T) {
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

	var seededCount int
	if err := s.pool.QueryRow(ctx, `select count(*) from prompt_templates`).Scan(&seededCount); err != nil {
		t.Fatalf("count prompt_templates via superuser: %v", err)
	}
	if seededCount == 0 {
		t.Fatal("no prompt_templates rows exist on this database — migrations 0003/0009/0011/... should have seeded one")
	}

	// Positive direction: an authenticated, non-admin user must actually see
	// the seeded templates, not merely be denied nothing by accident.
	t.Run("authenticated_user_can_select_templates", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from prompt_templates`).Scan(&count); err != nil {
				t.Fatalf("select prompt_templates as authenticated: %v", err)
			}
			if count != seededCount {
				t.Errorf("authenticated visible prompt_templates rows = %d, want %d (prompt_templates_select "+
					"`using (true)` should admit every row to every authenticated reader)", count, seededCount)
			}
		})
	})

	// No insert/update/delete policy at all — default-deny for every verb.
	t.Run("authenticated_user_cannot_insert_template", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into prompt_templates (name, version, body) values ('rls-test', 999999, 'pwned')`,
			)
			if err == nil {
				t.Errorf("insert of a prompt_templates row succeeded, want RLS denial (no insert policy exists)")
			}
		})
	})

	t.Run("authenticated_user_cannot_update_templates_unqualified", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update prompt_templates set body = 'pwned'`)
			if err != nil {
				t.Fatalf("unqualified update prompt_templates: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified update affected %d prompt_templates rows, want 0 (no update policy "+
					"exists — the SELECT policy being wide open must not leak into UPDATE)", tag.RowsAffected())
			}
		})
	})

	t.Run("authenticated_user_cannot_delete_templates_unqualified", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from prompt_templates`)
			if err != nil {
				t.Fatalf("unqualified delete prompt_templates: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified delete affected %d prompt_templates rows, want 0 (no delete policy exists)", tag.RowsAffected())
			}
		})
	})
}

// seedDeletedProjectCostHistory inserts a deleted_project_cost_history row
// directly via the superuser pool. In production only the archive triggers
// (0038_preserve_cost_history_on_delete.sql) ever write this table; a direct
// INSERT here just gets a row into place for the SELECT-only RLS policy to
// be tested against, same as seedAllowanceGrant does for allowance_grants.
func seedDeletedProjectCostHistory(ctx context.Context, t *testing.T, s *Store) (runID string) {
	t.Helper()
	if err := s.pool.QueryRow(ctx, `
INSERT INTO deleted_project_cost_history (run_id, vendor, model, cost_usd, project_title, owner_email)
VALUES (gen_random_uuid(), 'fal', 'rls-test-model', 1.23, 'rls-test-project', 'rls-test@example.test')
RETURNING run_id`).Scan(&runID); err != nil {
		t.Fatalf("seed deleted_project_cost_history: %v", err)
	}
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(), `DELETE FROM deleted_project_cost_history WHERE run_id = $1`, runID); err != nil {
			t.Errorf("cleanup deleted_project_cost_history %s: %v", runID, err)
		}
	})
	return runID
}

// =============================================================================
// deleted_project_cost_history (0038_preserve_cost_history_on_delete.sql) —
// admin-only select, no insert/update/delete policy at all (append-only via
// security-definer triggers, which bypass RLS as the table owner).
// =============================================================================
func TestRLSDeletedProjectCostHistory(t *testing.T) {
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
	adminUser := seedUser(ctx, t, s)
	makeAdmin(ctx, t, s, adminUser)

	row := seedDeletedProjectCostHistory(ctx, t, s)

	// Negative + positive for deleted_project_cost_history_select.
	t.Run("non_admin_cannot_select_archived_row", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from deleted_project_cost_history where run_id = $1`, row).Scan(&count); err != nil {
				t.Fatalf("select archived row as non-admin: %v", err)
			}
			if count != 0 {
				t.Errorf("non-admin visible rows for an archived cost row = %d, want 0", count)
			}
		})
	})

	t.Run("admin_can_select_archived_row", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from deleted_project_cost_history where run_id = $1`, row).Scan(&count); err != nil {
				t.Fatalf("select archived row as admin: %v", err)
			}
			if count != 1 {
				t.Errorf("admin visible rows = %d, want 1 (deleted_project_cost_history_select is being "+
					"denied uselessly strict)", count)
			}
		})
	})

	// No insert/update/delete policy at all — default-deny for every verb,
	// admin included, both targeted and unqualified.
	t.Run("admin_cannot_insert_archived_row", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into deleted_project_cost_history (run_id, vendor) values (gen_random_uuid(), 'pwned')`,
			)
			if err == nil {
				t.Errorf("admin insert into deleted_project_cost_history succeeded, want RLS denial " +
					"(no insert policy exists — only the security-definer archive triggers may write here)")
			}
		})
	})

	t.Run("admin_cannot_update_archived_row_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update deleted_project_cost_history set vendor = 'pwned' where run_id = $1`, row)
			if err != nil {
				t.Fatalf("admin update deleted_project_cost_history: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("admin update of an archived row affected %d rows, want 0 (no update policy exists)", tag.RowsAffected())
			}
		})
	})

	t.Run("admin_cannot_update_archived_row_unqualified", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update deleted_project_cost_history set vendor = 'pwned'`)
			if err != nil {
				t.Fatalf("unqualified admin update deleted_project_cost_history: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified admin update affected %d archived rows, want 0", tag.RowsAffected())
			}
		})
	})

	t.Run("admin_cannot_delete_archived_row_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from deleted_project_cost_history where run_id = $1`, row)
			if err != nil {
				t.Fatalf("admin delete deleted_project_cost_history: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("admin delete of an archived row affected %d rows, want 0 (no delete policy exists)", tag.RowsAffected())
			}
		})
	})

	t.Run("admin_cannot_delete_archived_row_unqualified", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from deleted_project_cost_history`)
			if err != nil {
				t.Fatalf("unqualified admin delete deleted_project_cost_history: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified admin delete affected %d archived rows, want 0", tag.RowsAffected())
			}
		})
	})
}
