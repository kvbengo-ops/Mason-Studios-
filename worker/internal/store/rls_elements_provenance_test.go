package store

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Forged references — 0091_shared_elements_library.sql.
//
// THE ATTACK SHARING OPENS. `elements.asset_id` POINTS at an `assets` row
// rather than copying it (0065's column comment), so a shared library has to
// admit the assets behind other people's elements or the grid renders nothing.
// Nothing in 0065 tied an element to an asset its own owner owns:
// elements_insert checks `user_id = auth.uid()` and says nothing about
// asset_id. So an account could insert an element naming SOMEBODY ELSE's asset
// id and have the library page sign that object for them — an arbitrary-file
// read wearing the shape of an ordinary card.
//
// Two independent answers, and this file proves both, because they fail
// differently:
//
//  1. elements_guard_asset_ownership() refuses the forged row at WRITE time,
//     from every client including the service role that makes every write in
//     this app.
//  2. assets_select's fourth branch re-proves ownership at READ time, so a row
//     that predates the trigger — never checked by anything — still exposes
//     nothing. That one is tested by planting a forged row with the trigger
//     disabled, which is the only way to produce a row the current schema
//     would not accept.
//
// AT THE DATABASE BOUNDARY, as real `authenticated` sessions. A mocked Server
// Action test would prove nothing here: the guard is a trigger and a policy,
// and neither is reachable through a mock.
func TestRLSElementAssetProvenance(t *testing.T) {
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

	victim := seedUser(ctx, t, s)
	attacker := seedUser(ctx, t, s)

	// The victim's private project and the asset inside it — the object the
	// attacker wants and has no business reading.
	var victimProject string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO projects (user_id, title) VALUES ($1, 'victim private project')
RETURNING id`, victim).Scan(&victimProject); err != nil {
		t.Fatalf("seed victim project: %v", err)
	}
	var victimAsset string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO assets (project_id, kind, storage_key)
VALUES ($1, 'ref_frame', 'projects/victim/ref_frame/private.png')
RETURNING id`, victimProject).Scan(&victimAsset); err != nil {
		t.Fatalf("seed victim asset: %v", err)
	}

	// The attacker's own project and asset, so they have a legitimate element
	// to mutate.
	var attackerProject string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO projects (user_id, title) VALUES ($1, 'attacker project')
RETURNING id`, attacker).Scan(&attackerProject); err != nil {
		t.Fatalf("seed attacker project: %v", err)
	}
	var attackerAsset string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO assets (project_id, kind, storage_key)
VALUES ($1, 'ref_frame', 'projects/attacker/ref_frame/mine.png')
RETURNING id`, attackerProject).Scan(&attackerAsset); err != nil {
		t.Fatalf("seed attacker asset: %v", err)
	}
	var attackerElement string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO elements (user_id, name, category, asset_id)
VALUES ($1, 'mine', 'image', $2)
RETURNING id`, attacker, attackerAsset).Scan(&attackerElement); err != nil {
		t.Fatalf("seed attacker element: %v", err)
	}

	t.Cleanup(func() {
		ctx := context.Background()
		for _, q := range []struct {
			sql string
			arg string
		}{
			{`DELETE FROM elements WHERE user_id = $1`, attacker},
			{`DELETE FROM elements WHERE user_id = $1`, victim},
			{`DELETE FROM assets WHERE project_id = $1`, attackerProject},
			{`DELETE FROM assets WHERE project_id = $1`, victimProject},
			{`DELETE FROM projects WHERE id = $1`, attackerProject},
			{`DELETE FROM projects WHERE id = $1`, victimProject},
		} {
			if _, err := s.pool.Exec(ctx, q.sql, q.arg); err != nil {
				t.Logf("cleanup: %v", err)
			}
		}
	})

	// Baseline. Without it the refusals below could be passing because the
	// attacker cannot see the victim's project at all, rather than because the
	// provenance guard works — and the whole point is that projects stay
	// private while the library is shared.
	t.Run("victims_project_asset_is_invisible_to_start_with", func(t *testing.T) {
		runAsUser(ctx, t, s, attacker, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from assets where id = $1`, victimAsset).Scan(&count); err != nil {
				t.Fatalf("select victim asset: %v", err)
			}
			if count != 0 {
				t.Errorf("the attacker can already read the victim's project asset (%d rows) before forging anything — projects are supposed to stay private", count)
			}
		})
	})

	// Step 1 of the attack: publish an element of your own that points at
	// somebody else's asset. Everything elements_insert checks is honest — the
	// attacker is active and names themselves as owner — so the trigger is the
	// only thing standing here.
	t.Run("forged_insert_naming_another_accounts_asset", func(t *testing.T) {
		runAsUser(ctx, t, s, attacker, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into elements (user_id, name, category, asset_id) values ($1, 'stolen', 'image', $2)`,
				attacker, victimAsset,
			)
			if err == nil {
				t.Error("an approved account inserted an element pointing at ANOTHER account's asset, want refusal — " +
					"the shared library would then sign that object for them, which is an arbitrary-file read")
			}
		})
	})

	// The same attack by UPDATE, against a row the attacker legitimately owns.
	// elements_update admits it — it is their row — so again only the trigger
	// refuses.
	t.Run("forged_update_repointing_at_another_accounts_asset", func(t *testing.T) {
		runAsUser(ctx, t, s, attacker, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`update elements set asset_id = $1 where id = $2`, victimAsset, attackerElement)
			if err == nil {
				t.Error("an approved account repointed its OWN element at another account's asset, want refusal")
			}
		})
	})

	// user_id is what elements_update and elements_delete authorise against, so
	// a row that could change hands would defeat both.
	t.Run("user_id_is_immutable", func(t *testing.T) {
		runAsUser(ctx, t, s, attacker, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`update elements set user_id = $1 where id = $2`, victim, attackerElement)
			if err == nil {
				t.Error("an element was handed to another account by rewriting user_id, want refusal")
			}
		})
	})

	// The consequence, asserted rather than inferred from the refusals above.
	t.Run("victims_asset_is_still_invisible_after_the_attempts", func(t *testing.T) {
		runAsUser(ctx, t, s, attacker, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from assets where id = $1`, victimAsset).Scan(&count); err != nil {
				t.Fatalf("select victim asset: %v", err)
			}
			if count != 0 {
				t.Errorf("the attacker can now read the victim's asset (%d rows) — a forged element leaked it", count)
			}
		})
	})

	// THE READ-TIME HALF, and the reason assets_select re-proves ownership
	// instead of trusting the trigger. Rows written before 0091 were never
	// checked by anything, so a forged one may already exist. Planted here with
	// session_replication_role = replica — the only way to write a row the
	// current schema refuses, i.e. to reproduce a genuinely pre-0091 row rather
	// than a lookalike.
	t.Run("a_pre_existing_forged_row_still_exposes_nothing", func(t *testing.T) {
		// TWO STATEMENTS, TWO ROUND TRIPS, one transaction. pgx sends a query
		// with arguments as a prepared statement, and Postgres refuses multiple
		// commands in one of those ("cannot insert multiple commands into a
		// prepared statement") — so the SET cannot ride along on the INSERT's
		// string. `set local` is scoped to the transaction, which is what we
		// want anyway: the trigger is disabled for exactly this one insert and
		// is back on for everything after the commit.
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin to plant a pre-0091 row: %v", err)
		}
		if _, err := tx.Exec(ctx, `set local session_replication_role = replica`); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("disable triggers to plant a pre-0091 row: %v", err)
		}
		var forgedID string
		if err := tx.QueryRow(ctx, `
INSERT INTO elements (user_id, name, category, asset_id)
VALUES ($1, 'planted', 'image', $2)
RETURNING id`, attacker, victimAsset).Scan(&forgedID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("plant a pre-0091 forged element: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit the planted row: %v", err)
		}
		t.Cleanup(func() {
			if _, err := s.pool.Exec(context.Background(), `DELETE FROM elements WHERE id = $1`, forgedID); err != nil {
				t.Logf("cleanup planted element %s: %v", forgedID, err)
			}
		})

		runAsUser(ctx, t, s, attacker, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from assets where id = $1`, victimAsset).Scan(&count); err != nil {
				t.Fatalf("select victim asset through a forged element: %v", err)
			}
			if count != 0 {
				t.Errorf("a forged element row exposed the victim's asset (%d rows), want 0 — assets_select's "+
					"branch must RE-PROVE that the element's owner owns the asset, not merely that some element points at it", count)
			}
		})
	})

	// The positive direction, without which every assertion above is satisfied
	// by a guard that refuses everything.
	t.Run("an_honest_element_still_publishes_and_renders", func(t *testing.T) {
		runAsUser(ctx, t, s, attacker, func(tx pgx.Tx) {
			if _, err := tx.Exec(ctx,
				`insert into elements (user_id, name, category, asset_id) values ($1, 'honest', 'image', $2)`,
				attacker, attackerAsset,
			); err != nil {
				t.Fatalf("an approved account could not publish an element pointing at its OWN asset: %v — 0091 is refusing the person it exists for", err)
			}
		})

		// And the other account can read the asset behind it, which is the
		// feature this whole migration is for.
		runAsUser(ctx, t, s, victim, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from assets where id = $1`, attackerAsset).Scan(&count); err != nil {
				t.Fatalf("select the asset behind a legitimately shared element: %v", err)
			}
			if count != 1 {
				t.Errorf("another account sees %d rows for the asset behind a legitimately shared element, want 1 — the shared grid would render an empty card", count)
			}
		})
	})
}
