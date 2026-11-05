package store

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// =============================================================================
// profiles.status as a write gate (0052_account_approval.sql, extended by
// 0053_active_gate_on_child_writes.sql)
//
// Every other RLS test in this package seeds an APPROVED account
// (setProfileStatus(..., "active") in each seed helper) so that a denied
// write proves tenant isolation and nothing else. This file is the
// complement: the owner is the right owner, and the write is still refused,
// because the account is no longer allowed to act.
//
// It exists because of what 0052 alone did not cover. That migration put
// is_active() on projects_insert_own only, reasoning that every
// scenes/assets/runs write policy authorises through
// `exists (select 1 from projects p where p.id = <table>.project_id and
// p.user_id = auth.uid())`, so an account that cannot own a project cannot
// reach the children either. True for 'pending', which owns nothing. Not
// true for 'rejected', which can already own projects from when it was
// active — and that subquery asks only "do you own the parent", never "is
// this account still allowed to act". Before 0053 a rejected account could
// still insert `runs`, the spend table, against its own project, using a
// token that stays valid for up to jwt_expiry (3600s) after the decision
// and addressing PostgREST directly, where requireUser()'s /pending
// redirect does not exist.
//
// Same rules as the rest of the file set: seed through the superuser pool,
// act through runAsUser, every transaction rolled back.
// =============================================================================
func TestRLSRejectedAccountCannotWriteProjectChildren(t *testing.T) {
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

	// An account that was active long enough to own a project, a scene, a
	// run and an asset — the state projects_insert_own on its own can never
	// reach, and the entire reason 0053 exists.
	projectID, sceneID := seedRenderingScene(ctx, t, s)
	owner := projectOwner(ctx, t, s, projectID)
	seedRun(ctx, t, s, projectID, sceneID)
	seedAsset(ctx, t, s, projectID, sceneID)

	setProfileStatus(ctx, t, s, owner, "rejected")

	t.Run("insert_scene_into_own_project_denied", func(t *testing.T) {
		runAsUser(ctx, t, s, owner, func(tx pgx.Tx) {
			if _, err := tx.Exec(ctx,
				`insert into scenes (project_id, idx, status) values ($1, 1, 'draft')`, projectID,
			); err == nil {
				t.Error("rejected account inserted a scene into its own project, want RLS denial")
			}
		})
	})

	// The one that costs money: a runs row IS the spend record, so this is
	// the subtest that fails if the gate is ever taken back off.
	t.Run("insert_run_into_own_project_denied", func(t *testing.T) {
		runAsUser(ctx, t, s, owner, func(tx pgx.Tx) {
			if _, err := tx.Exec(ctx,
				`insert into runs (project_id, scene_id, vendor, model, cost_usd) values ($1, $2, 'fal', 'm', 0.01)`,
				projectID, sceneID,
			); err == nil {
				t.Error("rejected account inserted a run against its own project, want RLS denial")
			}
		})
	})

	t.Run("insert_asset_into_own_project_denied", func(t *testing.T) {
		runAsUser(ctx, t, s, owner, func(tx pgx.Tx) {
			if _, err := tx.Exec(ctx,
				`insert into assets (project_id, scene_id, kind, storage_key) values ($1, $2, 'clip', 'media/rejected.mp4')`,
				projectID, sceneID,
			); err == nil {
				t.Error("rejected account inserted an asset into its own project, want RLS denial")
			}
		})
	})

	// Unqualified, for the reason rls_test.go's header spells out: a
	// targeted write is filtered by the SELECT policy before the
	// UPDATE/DELETE policy is consulted, so only an unqualified one
	// actually exercises the write policy. Reads are deliberately still
	// open here (see the last subtest), which makes these two the real
	// test — the rows ARE visible, and the write still has to affect none
	// of them.
	t.Run("unqualified_update_of_own_scenes_affects_nothing", func(t *testing.T) {
		runAsUser(ctx, t, s, owner, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update scenes set status = 'draft'`)
			if err != nil {
				t.Fatalf("unqualified update scenes: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified update affected %d scenes, want 0 — a rejected account is still able to write its own rows",
					tag.RowsAffected())
			}
		})
	})

	t.Run("unqualified_delete_of_own_runs_affects_nothing", func(t *testing.T) {
		runAsUser(ctx, t, s, owner, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from runs`)
			if err != nil {
				t.Fatalf("unqualified delete runs: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified delete affected %d runs, want 0 — a rejected account is still able to delete its own spend rows",
					tag.RowsAffected())
			}
		})
	})

	// The deliberate other half of 0053's scope: reads are NOT gated. A
	// rejected account keeps seeing its own rows, which is what lets
	// /pending read the profile row it needs to say why the account is
	// stuck there. If this ever starts failing, the write gate has been
	// widened into a read gate by accident.
	t.Run("reads_are_deliberately_still_allowed", func(t *testing.T) {
		runAsUser(ctx, t, s, owner, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from scenes where id = $1`, sceneID).Scan(&count); err != nil {
				t.Fatalf("select own scene: %v", err)
			}
			if count != 1 {
				t.Errorf("own scene visible rows = %d, want 1 (0053 gates writes only)", count)
			}
		})
	})
}

// Admins are trusted by role and do not need the separate profiles.status
// approval. This is the database-side twin of web/lib/account-approval.ts:
// without it, requireUser would admit the admin but RLS would still reject
// the first project write.
func TestRLSPendingAdminCanCreateProject(t *testing.T) {
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

	adminID := seedUser(ctx, t, s)
	makeAdmin(ctx, t, s, adminID)
	setProfileStatus(ctx, t, s, adminID, "pending")

	runAsUser(ctx, t, s, adminID, func(tx pgx.Tx) {
		if _, err := tx.Exec(ctx,
			`insert into projects (user_id, title) values ($1, 'pending admin project')`, adminID,
		); err != nil {
			t.Fatalf("pending admin project insert denied: %v", err)
		}
	})
}
