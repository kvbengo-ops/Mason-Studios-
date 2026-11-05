package store

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// RLS for `elements`, the @tag library /ugc resolves a prompt's "@name"
// against.
//
// Every other gated table in this schema has a file like this one, and the
// convention exists because the policies are the second line of defence:
// every live path into `elements` goes through a Server Action behind
// requireUser, so a hole here is invisible until the day someone forgets the
// TypeScript guard — which is precisely the day it matters.
//
// SHARED TO READ, OWNED OR ADMINISTERED TO WRITE, since
// 0091_shared_elements_library.sql. This file used to assert the opposite of the
// `characters` tests on purpose — 0065 made elements "the asymmetric opposite"
// of that table, owner-only in both directions. 0091 reversed the READ half for
// everyone and the WRITE half for admins only, so the assertions here split:
//
//   - stranger_reads_it / stranger_cannot_write are a PAIR, and neither means
//     anything without the other. A test that only proved the read would pass
//     just as happily against a table with no write policy at all. Together
//     they ARE the permission matrix for a non-owner: everything readable,
//     nothing writable.
//   - admin_can_update_anothers / admin_can_delete_anothers are the admin row
//     of that matrix. Both verbs, not delete alone.
//   - 0065 shipped the write policies WITHOUT is_active(), which 0068 added.
//     That gate is the reason a rejected account cannot keep writing, and it
//     is the assertion most likely to be quietly dropped by a future policy
//     rewrite, so it gets its own subtest in both directions.
//
// The forged-reference half lives in its own function below,
// TestRLSElementAssetProvenance.
func TestRLSElements(t *testing.T) {
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

	owner := seedUser(ctx, t, s)
	stranger := seedUser(ctx, t, s)
	adminUser := seedUser(ctx, t, s)
	makeAdmin(ctx, t, s, adminUser)

	// elements.asset_id is NOT NULL and references assets, so the fixture
	// needs a real project and asset behind it — which is itself worth having
	// in the test: it is what makes `on delete cascade` meaningful.
	var projectID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO projects (user_id, title) VALUES ($1, 'elements rls fixture')
RETURNING id`, owner).Scan(&projectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	var assetID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO assets (project_id, kind, storage_key)
VALUES ($1, 'ref_frame', 'projects/seed/ref_frame/elements-rls.png')
RETURNING id`, projectID).Scan(&assetID); err != nil {
		t.Fatalf("seed asset: %v", err)
	}

	var elementID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO elements (user_id, name, description, category, asset_id)
VALUES ($1, 'lena_ref', 'Late 20s, ash-blonde, cream linen', 'character', $2)
RETURNING id`, owner, assetID).Scan(&elementID); err != nil {
		t.Fatalf("seed element: %v", err)
	}

	// Registered BEFORE seedUser's own cleanup runs, so it happens after —
	// t.Cleanup is LIFO. Without it these rows hold a foreign key into
	// profiles and seedUser's teardown cannot delete the users it made,
	// leaving every later run to trip over the leftovers.
	t.Cleanup(func() {
		ctx := context.Background()
		for _, id := range []string{owner, stranger} {
			if _, err := s.pool.Exec(ctx, `DELETE FROM elements WHERE user_id = $1`, id); err != nil {
				t.Logf("cleanup elements for %s: %v", id, err)
			}
		}
		if _, err := s.pool.Exec(ctx, `DELETE FROM assets WHERE project_id = $1`, projectID); err != nil {
			t.Logf("cleanup assets: %v", err)
		}
		if _, err := s.pool.Exec(ctx, `DELETE FROM projects WHERE id = $1`, projectID); err != nil {
			t.Logf("cleanup project: %v", err)
		}
	})

	t.Run("owner_sees_their_own", func(t *testing.T) {
		runAsUser(ctx, t, s, owner, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from elements where id = $1`, elementID).Scan(&count); err != nil {
				t.Fatalf("select own element: %v", err)
			}
			if count != 1 {
				t.Errorf("owner sees %d rows for their own element, want 1 — the policy is refusing the person it exists for", count)
			}
		})
	})

	// The shared half of 0091. Read as the inverse of what this subtest
	// asserted until then ("stranger_sees_nothing"): the library is browsable
	// by every signed-in account on purpose now, and this is what would catch a
	// revert to owner-scoped reads that nobody noticed because their own cards
	// still rendered.
	//
	// Only meaningful beside stranger_cannot_write below. Widening a SELECT is
	// exactly the change most likely to take the write policies with it by
	// accident — 0085 did that to six policies and needed 0086 to undo it.
	t.Run("stranger_reads_it", func(t *testing.T) {
		runAsUser(ctx, t, s, stranger, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from elements where id = $1`, elementID).Scan(&count); err != nil {
				t.Fatalf("select another user's element: %v", err)
			}
			if count != 1 {
				t.Errorf("a stranger sees %d rows of the shared element library, want 1 — elements_select is `using (true)` since 0091", count)
			}
		})
	})

	// The picture, not just the name. `elements.asset_id` POINTS at an assets
	// row rather than copying it (0065), so a shared grid renders nothing
	// unless assets_select admits the asset behind another operator's element —
	// which is the branch 0091 adds, and the one whose absence would fail
	// SILENTLY: lib/element-library.ts drops any element whose asset it cannot
	// read, so the page would look like nobody had saved anything.
	t.Run("stranger_reads_the_asset_behind_it", func(t *testing.T) {
		runAsUser(ctx, t, s, stranger, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from assets where id = $1`, assetID).Scan(&count); err != nil {
				t.Fatalf("select the asset behind another user's element: %v", err)
			}
			if count != 1 {
				t.Errorf("a stranger sees %d rows for the asset behind a shared element, want 1 — assets_select's `exists (select 1 from elements ...)` branch (0091) is missing, and the library would render empty cards", count)
			}
		})
	})

	// The narrowness of that branch, stated as a test rather than trusted. An
	// asset NO element points at must stay invisible: 0091 widened
	// assets_select for the library's sake, and the failure mode of a widening
	// is that it turns out to have been wider than advertised. Permissive
	// policies OR together, so this could not be narrowed back by any other
	// branch (0086's header).
	t.Run("stranger_still_cannot_read_an_unreferenced_asset", func(t *testing.T) {
		var loneAssetID string
		if err := s.pool.QueryRow(ctx, `
INSERT INTO assets (project_id, kind, storage_key)
VALUES ($1, 'ref_frame', 'projects/seed/ref_frame/elements-rls-unreferenced.png')
RETURNING id`, projectID).Scan(&loneAssetID); err != nil {
			t.Fatalf("seed unreferenced asset: %v", err)
		}

		runAsUser(ctx, t, s, stranger, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from assets where id = $1`, loneAssetID).Scan(&count); err != nil {
				t.Fatalf("select an unreferenced asset: %v", err)
			}
			if count != 0 {
				t.Errorf("a stranger sees %d rows for an asset in another account's project that no element points at, want 0 — 0091's assets_select branch is wider than the shared library needs", count)
			}
		})
	})

	t.Run("admin_sees_it", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from elements where id = $1`, elementID).Scan(&count); err != nil {
				t.Fatalf("select as admin: %v", err)
			}
			if count != 1 {
				t.Errorf("admin sees %d rows, want 1 — every signed-in account reads this table since 0091", count)
			}
		})
	})

	// Admins WRITE here, both verbs — the difference from `characters`, where
	// 0091 admits is_admin() on elements_update
	// as well as elements_delete, because correcting a bad description or a
	// misleading @name in a shared library is expected of an admin.
	//
	// What makes that safe is not in this file: updateElement follows a rename
	// through the OWNER's prompts (rewriteTagInOwnPrompts), never the caller's,
	// so an admin correcting a name repairs that account's scenes instead of
	// leaving them pointing at a name that no longer resolves.
	t.Run("admin_can_update_anothers", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`update elements set description = 'corrected by an admin' where id = $1`, elementID)
			if err != nil {
				t.Fatalf("update another user's element as admin: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("an admin updated %d rows of another operator's element, want 1 — elements_update admits is_admin() since 0091", tag.RowsAffected())
			}
		})
	})

	t.Run("admin_can_delete_anothers", func(t *testing.T) {
		// Its own row, not the shared fixture: the subtests after this one
		// still need elementID to exist.
		var moderatedID string
		if err := s.pool.QueryRow(ctx, `
INSERT INTO elements (user_id, name, category, asset_id)
VALUES ($1, 'needs_removing', 'character', $2)
RETURNING id`, owner, assetID).Scan(&moderatedID); err != nil {
			t.Fatalf("seed element for moderation: %v", err)
		}

		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from elements where id = $1`, moderatedID)
			if err != nil {
				t.Fatalf("delete another user's element as admin: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("an admin removed %d rows, want 1 — elements_delete's `or is_admin()` (0091) is the only in-app way to take down content whose owner is unavailable", tag.RowsAffected())
			}
		})

		// runAsUser's transaction is rolled back, so the row is still there for
		// the cleanup registered above to collect. Nothing to undo here.
	})

	// An UNQUALIFIED write is what actually pins a write policy. A targeted
	// `update ... where id = <someone else's row>` proves nothing: the SELECT
	// policy filters the WHERE lookup first, so it reports 0 rows even with
	// the update policy wide open. Same trap rls_test.go's own header
	// describes.
	t.Run("stranger_cannot_write", func(t *testing.T) {
		runAsUser(ctx, t, s, stranger, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update elements set description = 'stolen'`)
			if err != nil {
				t.Fatalf("unqualified update as stranger: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("a stranger's unqualified update touched %d rows, want 0", tag.RowsAffected())
			}

			tag, err = tx.Exec(ctx, `delete from elements`)
			if err != nil {
				t.Fatalf("unqualified delete as stranger: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("a stranger's unqualified delete removed %d rows, want 0", tag.RowsAffected())
			}
		})
	})

	// 0068's gate, both directions. The negative case is the one a policy
	// rewrite would silently drop, because nothing else in the app notices:
	// requireUser already redirects an unapproved account to /pending, so the
	// TypeScript layer hides the hole.
	t.Run("rejected_owner_cannot_write", func(t *testing.T) {
		setProfileStatus(ctx, t, s, owner, "rejected")
		t.Cleanup(func() { setProfileStatus(ctx, t, s, owner, "active") })

		runAsUser(ctx, t, s, owner, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`update elements set description = 'edited while rejected' where id = $1`, elementID)
			if err != nil {
				t.Fatalf("update while rejected: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("a rejected owner updated %d rows, want 0 — is_active() is missing from elements_update (0068)", tag.RowsAffected())
			}

			_, err = tx.Exec(ctx, `
INSERT INTO elements (user_id, name, description, category, asset_id)
VALUES ($1, 'while_rejected', 'x', 'product', $2)`, owner, assetID)
			if err == nil {
				t.Error("a rejected owner inserted an element — is_active() is missing from elements_insert (0068)")
			}
		})
	})

	t.Run("active_owner_can_write", func(t *testing.T) {
		// The other half, and not a formality: a gate that refuses everyone
		// passes the negative test above perfectly.
		runAsUser(ctx, t, s, owner, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`update elements set description = 'edited while active' where id = $1`, elementID)
			if err != nil {
				t.Fatalf("update while active: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("an active owner updated %d rows, want 1 — the gate is refusing the person it exists for", tag.RowsAffected())
			}
		})
	})

	// unique (user_id, name) is what makes "@lena_ref" resolvable to exactly
	// one element within one operator's set — and what lets two operators each
	// have their own @lena_ref without colliding.
	//
	// THE STRANGER NEEDS THEIR OWN ASSET since 0091. This subtest used to point
	// both elements at `assetID`, which belongs to the OWNER's project; the
	// provenance trigger now refuses an element whose asset its own account does
	// not own, so reusing it made this fail for a reason that has nothing to do
	// with the unique key it exists to test. Giving the stranger a real asset
	// keeps the subject of the test the subject of the test.
	t.Run("shared_tag_names_are_global_personal_ones_per_owner", func(t *testing.T) {
		var strangerProject string
		if err := s.pool.QueryRow(ctx, `
INSERT INTO projects (user_id, title) VALUES ($1, 'stranger tag-name fixture')
RETURNING id`, stranger).Scan(&strangerProject); err != nil {
			t.Fatalf("seed stranger project: %v", err)
		}
		var strangerAsset string
		if err := s.pool.QueryRow(ctx, `
INSERT INTO assets (project_id, kind, storage_key)
VALUES ($1, 'ref_frame', 'projects/seed/ref_frame/elements-rls-stranger.png')
RETURNING id`, strangerProject).Scan(&strangerAsset); err != nil {
			t.Fatalf("seed stranger asset: %v", err)
		}
		t.Cleanup(func() {
			ctx := context.Background()
			if _, err := s.pool.Exec(ctx, `DELETE FROM elements WHERE asset_id = $1`, strangerAsset); err != nil {
				t.Logf("cleanup stranger elements: %v", err)
			}
			if _, err := s.pool.Exec(ctx, `DELETE FROM assets WHERE id = $1`, strangerAsset); err != nil {
				t.Logf("cleanup stranger asset: %v", err)
			}
			if _, err := s.pool.Exec(ctx, `DELETE FROM projects WHERE id = $1`, strangerProject); err != nil {
				t.Logf("cleanup stranger project: %v", err)
			}
		})

		_, err := s.pool.Exec(ctx, `
INSERT INTO elements (user_id, name, category, asset_id)
VALUES ($1, 'lena_ref', 'character', $2)`, owner, assetID)
		if err == nil {
			t.Error("a second 'lena_ref' for the same owner was accepted — @lena_ref would resolve ambiguously")
		}

		// Since 0097, shared names are unique across owners: @lena_ref in the
		// shared library must resolve to one element for everyone.
		_, err = s.pool.Exec(ctx, `
INSERT INTO elements (user_id, name, category, asset_id)
VALUES ($1, 'lena_ref', 'character', $2)`, stranger, strangerAsset)
		if err == nil {
			t.Error("a different owner published a second shared 'lena_ref' — @lena_ref would resolve ambiguously in the shared library")
		}

		// A personal copy (is_shared = false) is outside that guard, so the
		// per-owner key is all it has to clear.
		var otherID string
		if err := s.pool.QueryRow(ctx, `
INSERT INTO elements (user_id, name, category, asset_id, is_shared)
VALUES ($1, 'lena_ref', 'character', $2, false)
RETURNING id`, stranger, strangerAsset).Scan(&otherID); err != nil {
			t.Errorf("a different owner could not keep a personal 'lena_ref': %v — personal names are meant to be unique per owner only", err)
		}
	})
}
