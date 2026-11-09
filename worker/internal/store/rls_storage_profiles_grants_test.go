package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// This file extends rls_test.go's methodology (see that file's header for
// runAsUser/projectOwner and why every write policy must ALSO be asserted
// with an unqualified statement) to storage.objects (0005_storage_bucket.sql,
// 0034_profile_avatar.sql), profiles (0002_rls.sql), and allowance_grants
// (0032_allowance_requests.sql).
//
// storage.foldername(name) matters more here than in any other file in this
// package: every media_*/avatar_* policy below indexes into its result to
// pull out a project id or user id segment, and getting that stub wrong
// silently proves the opposite of production behavior (see
// scripts/ci/test-db-bootstrap.sql's header). TestStorageFoldernameSemantics
// pins the exact real-world contract directly, independent of any policy, so
// a future regression in the stub fails here first rather than showing up as
// an inexplicable failure three tests later.

// TestStorageFoldernameSemantics pins storage.foldername's real behavior —
// split on '/', DROP the trailing filename element — against the stub in
// scripts/ci/test-db-bootstrap.sql. Every media_*/avatar_* policy test below
// depends on this being right; if this test ever fails, every one of them is
// suspect too.
func TestStorageFoldernameSemantics(t *testing.T) {
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

	cases := []struct {
		name  string
		input string
		want  []string
	}{
		{"nested_path_drops_filename", "avatars/u1/pic.png", []string{"avatars", "u1"}},
		{"two_segments_drops_filename", "a/b", []string{"a"}},
		{"no_slash_yields_empty", "solo.png", []string{}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var got []string
			if err := s.pool.QueryRow(ctx, `select storage.foldername($1)`, c.input).Scan(&got); err != nil {
				t.Fatalf("storage.foldername(%q): %v", c.input, err)
			}
			if len(got) != len(c.want) {
				t.Fatalf("storage.foldername(%q) = %v, want %v", c.input, got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Errorf("storage.foldername(%q)[%d] = %q, want %q", c.input, i, got[i], c.want[i])
				}
			}
		})
	}
}

// seedStorageObject inserts a storage.objects row directly (this stand-in
// table has none of Supabase's own upload machinery, so a plain INSERT via
// the superuser pool is how every other seed helper in this package creates
// a row an RLS policy will later be asked to admit or deny).
func seedStorageObject(ctx context.Context, t *testing.T, s *Store, bucketID, name string) (id string) {
	t.Helper()
	if err := s.pool.QueryRow(ctx,
		`insert into storage.objects (bucket_id, name) values ($1, $2) returning id`, bucketID, name,
	).Scan(&id); err != nil {
		t.Fatalf("seed storage object %q: %v", name, err)
	}
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(), `delete from storage.objects where id = $1`, id); err != nil {
			t.Errorf("cleanup storage object %s: %v", id, err)
		}
	})
	return id
}

// =============================================================================
// storage.objects — media_* (0005_storage_bucket.sql, corrected by
// 0048_fix_media_policy_folder_index.sql)
// =============================================================================
//
// Path shape: projects/{projectId}/{kind}/{uuid}.{ext} — both
// lib/storage.ts's buildStorageKey (web) and worker/internal/store/storage.go's
// StorageKeyForClip/StorageKeyForFinal/StorageKeyForPoster (the Go worker)
// mint exactly this shape. storage.foldername(name) drops the trailing
// filename element (see scripts/ci/test-db-bootstrap.sql's header — this is
// its real, Supabase-matching behavior, not a stub artifact), leaving
// {'projects', '{projectId}', '{kind}'} for any real key this app ever
// writes. Element 1 (1-indexed) is therefore the literal string 'projects';
// element 2 is the project id.
//
// 0005_storage_bucket.sql originally compared
// `p.id::text = (storage.foldername(name))[1]` in all four media_*
// policies — a project uuid can never equal the literal 'projects', so
// that `exists (...)` was false for every real key, for every caller,
// including the row's own owner. 0048_fix_media_policy_folder_index.sql
// altered all four policies to index [2] instead, which is the project id.
//
// The tests below assert the CORRECT, post-0048 behavior: the owning user
// can select/insert/update/delete their own media objects, an admin can
// additionally select another user's media object via media_select's
// `or is_admin()` branch, and a non-owner (admin included, for
// insert/update/delete which have no admin escape hatch) still cannot
// touch another user's project.
func TestRLSStorageObjectsMedia(t *testing.T) {
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

	projectA, _ := seedRenderingScene(ctx, t, s)
	projectB, _ := seedRenderingScene(ctx, t, s)
	userA := projectOwner(ctx, t, s, projectA)
	adminUser := seedUser(ctx, t, s)
	makeAdmin(ctx, t, s, adminUser)

	keyA := fmt.Sprintf("projects/%s/clip/existing-a.mp4", projectA)
	keyB := fmt.Sprintf("projects/%s/clip/existing-b.mp4", projectB)
	objA := seedStorageObject(ctx, t, s, "media", keyA)
	objB := seedStorageObject(ctx, t, s, "media", keyB)

	// The row is the CALLER'S OWN object under their OWN project — with the
	// [2] index (0048), media_select's EXISTS matches and the owner sees it.
	t.Run("select_own_object_visible", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from storage.objects where id = $1`, objA).Scan(&count); err != nil {
				t.Fatalf("select own object: %v", err)
			}
			if count != 1 {
				t.Errorf("own object visible rows = %d, want 1 (media_select should admit the owner's own "+
					"object post-0048)", count)
			}
		})
	})

	t.Run("select_other_users_object_returns_zero", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from storage.objects where id = $1`, objB).Scan(&count); err != nil {
				t.Fatalf("select other user's object: %v", err)
			}
			if count != 0 {
				t.Errorf("other user's object visible rows = %d, want 0", count)
			}
		})
	})

	// Now that the EXISTS predicate's first conjunct
	// (`p.id::text = (storage.foldername(name))[2]`) can actually match, the
	// `p.user_id = auth.uid() or is_admin()` half is reached and its
	// `is_admin()` branch admits an admin to another user's object.
	t.Run("admin_select_other_users_object_allowed", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from storage.objects where id = $1`, objB).Scan(&count); err != nil {
				t.Fatalf("admin select other user's object: %v", err)
			}
			if count != 1 {
				t.Errorf("admin visible rows for other user's object = %d, want 1 (media_select's "+
					"`or is_admin()` branch should admit an admin post-0048)", count)
			}
		})
	})

	t.Run("insert_own_object_succeeds", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`insert into storage.objects (bucket_id, name) values ('media', $1)`,
				fmt.Sprintf("projects/%s/clip/new-a.mp4", projectA),
			)
			if err != nil {
				t.Fatalf("insert of the owner's OWN object under their OWN project denied: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("insert own object affected %d rows, want 1", tag.RowsAffected())
			}
		})
	})

	t.Run("insert_for_other_users_project_denied", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into storage.objects (bucket_id, name) values ('media', $1)`,
				fmt.Sprintf("projects/%s/clip/new-b.mp4", projectB),
			)
			if err == nil {
				t.Errorf("insert of an object under another user's project succeeded, want RLS denial")
			}
		})
	})

	t.Run("update_other_users_object_denied_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			// A literal new value, never `name = name`: a self-referencing
			// SET forces Postgres to READ the row's current `name` to
			// evaluate the assignment, which is gated by the SELECT policy
			// on top of whatever the UPDATE policy decides — that would
			// conflate "no SELECT policy admits this row" with "the UPDATE
			// policy denies it" (measured directly: a self-referencing SET
			// against an avatar row returns 0 rows even for the OWNER,
			// purely because of the missing SELECT policy; a literal SET on
			// the same row returns 1). A literal isolates the write policy.
			tag, err := tx.Exec(ctx, `update storage.objects set name = $2 where id = $1`, objB, keyB+"-touched")
			if err != nil {
				t.Fatalf("update other user's object: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("update other user's object affected %d rows, want 0", tag.RowsAffected())
			}
		})
	})

	// Unqualified: no WHERE for a SELECT policy to filter, so media_update's
	// own `using` clause alone decides which rows are touched. It should be
	// exactly ONE row (objA, userA's own) — post-0048 the owner's object
	// matches, and objB (another user's project) must not.
	// Literal SET value, not `name = name` — see the comment on the
	// targeted subtest above for why a self-reference would conflate this
	// with the (different) missing-SELECT-policy story.
	t.Run("unqualified_update_reaches_only_own_object", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update storage.objects set name = $1`, keyA+"-touched")
			if err != nil {
				t.Fatalf("unqualified update storage.objects: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("unqualified update affected %d objects, want 1 (media_update's `using` clause "+
					"should admit exactly the owner's own object post-0048 — 0 would mean it's still "+
					"denying the owner, 2+ would mean it ALSO leaks another user's object)", tag.RowsAffected())
			}
		})
	})

	t.Run("unqualified_delete_reaches_only_own_object", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from storage.objects`)
			if err != nil {
				t.Fatalf("unqualified delete storage.objects: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("unqualified delete affected %d objects, want 1 (media_delete's `using` clause "+
					"should admit exactly the owner's own object post-0048)", tag.RowsAffected())
			}
		})
	})
}

// =============================================================================
// storage.objects — avatar_* (0034_profile_avatar.sql)
// =============================================================================
//
// Path shape: avatars/{user_id}/{uuid}.{ext}. There is deliberately NO
// avatar_select policy (0034's own header) — media_select only matches a
// `projects/{projectId}/...` key via a projects join, so an avatars/ key
// never satisfies it either. That means NO session client, not even the
// avatar's own owner, can SELECT an avatar object — which in turn means a
// TARGETED update/delete (`where id = ...`) always affects zero rows
// regardless of whose avatar it is, because the row is never visible to
// filter a WHERE clause against in the first place. Only an UNQUALIFIED
// write (see rls_test.go's header) bypasses that SELECT-shaped dead end and
// actually exercises avatar_update/avatar_delete's own `using` clause.
func TestRLSStorageObjectsAvatar(t *testing.T) {
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
	userB := seedUser(ctx, t, s)

	avatarAKey := fmt.Sprintf("avatars/%s/existing.png", userA)
	avatarA := seedStorageObject(ctx, t, s, "media", avatarAKey)
	seedStorageObject(ctx, t, s, "media", fmt.Sprintf("avatars/%s/existing.png", userB))

	t.Run("insert_own_avatar_succeeds", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`insert into storage.objects (bucket_id, name) values ('media', $1)`,
				fmt.Sprintf("avatars/%s/new.png", userA),
			)
			if err != nil {
				t.Fatalf("insert own avatar: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("insert own avatar affected %d rows, want 1", tag.RowsAffected())
			}
		})
	})

	t.Run("insert_for_other_user_denied", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into storage.objects (bucket_id, name) values ('media', $1)`,
				fmt.Sprintf("avatars/%s/new.png", userB),
			)
			if err == nil {
				t.Errorf("insert of an avatar under another user's id succeeded, want RLS denial")
			}
		})
	})

	// Documents the no-avatar_select consequence above rather than a policy
	// bug: this is userA's OWN avatar object, yet a targeted update still
	// affects zero rows, because no SELECT policy ever admits it for the
	// WHERE lookup to find in the first place.
	t.Run("targeted_update_of_own_avatar_affects_zero_no_select_policy_exists", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update storage.objects set name = $2 where id = $1`, avatarA, avatarAKey+"-touched")
			if err != nil {
				t.Fatalf("targeted update own avatar: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("targeted update of own avatar affected %d rows, want 0 (no avatar_select policy "+
					"exists to admit ANY avatar row to a session client — see this test's comment)", tag.RowsAffected())
			}
		})
	})

	// Unqualified: avatar_update's `using` clause is the ONLY thing deciding
	// which rows are touched (see this test function's header). Exactly one
	// avatar belongs to userA (avatarA) — 0 means avatar_update wrongly
	// denies the owner, 2 means it wrongly admits userB's avatar too. Literal
	// SET value, not `name = name` — a self-referencing SET forces a read of
	// the row's current value, which is gated by the (nonexistent)
	// avatar_select policy and would make even the OWNER's row read back as
	// 0 for the wrong reason (measured directly: `name = name` here returns
	// 0, a literal value returns 1, on the exact same row).
	t.Run("unqualified_update_reaches_only_own_avatar", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update storage.objects set name = $1`, avatarAKey+"-touched")
			if err != nil {
				t.Fatalf("unqualified update storage.objects: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("unqualified update affected %d avatar rows, want 1 (own avatar only)", tag.RowsAffected())
			}
		})
	})

	t.Run("unqualified_delete_reaches_only_own_avatar", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from storage.objects`)
			if err != nil {
				t.Fatalf("unqualified delete storage.objects: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("unqualified delete affected %d avatar rows, want 1 (own avatar only) — "+
					"a higher count means avatar_delete admits another user's avatar", tag.RowsAffected())
			}
		})
	})
}

// =============================================================================
// profiles (0002_rls.sql) — select-own + select-admin, deliberately NO update
// policy at all (web/actions/profile.ts writes through the admin client).
// This table holds emails, so a cross-user read is a PII leak; the missing
// update policy is what makes a cross-user (or even same-user) write through
// RLS categorically impossible, not merely denied by ownership.
// =============================================================================
func TestRLSProfiles(t *testing.T) {
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
	userB := seedUser(ctx, t, s)
	adminUser := seedUser(ctx, t, s)
	makeAdmin(ctx, t, s, adminUser)

	t.Run("select_own_profile", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from profiles where id = $1`, userA).Scan(&count); err != nil {
				t.Fatalf("select own profile: %v", err)
			}
			if count != 1 {
				t.Errorf("own profile visible rows = %d, want 1", count)
			}
		})
	})

	t.Run("select_other_users_profile_returns_zero", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from profiles where id = $1`, userB).Scan(&count); err != nil {
				t.Fatalf("select other user's profile: %v", err)
			}
			if count != 0 {
				t.Errorf("other user's profile visible rows = %d, want 0 (this table holds email — a PII leak)", count)
			}
		})
	})

	t.Run("admin_can_select_other_users_profile", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from profiles where id = $1`, userB).Scan(&count); err != nil {
				t.Fatalf("admin select other user's profile: %v", err)
			}
			if count != 1 {
				t.Errorf("admin visible rows for other user's profile = %d, want 1 (admin read access is being denied uselessly strict)", count)
			}
		})
	})

	// No UPDATE policy exists for profiles at all — 0002_rls.sql defines
	// only profiles_select_own/profiles_select_admin. A table with RLS
	// enabled and no policy for a command is default-deny for that command,
	// so this must hold for every actor, targeted or not, own row or
	// another's, admin or not — there is no `is_admin()` escape hatch to
	// check because none was ever written.
	t.Run("non_admin_cannot_update_own_profile_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update profiles set username = 'pwned' where id = $1`, userA)
			if err != nil {
				t.Fatalf("update own profile: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("update of own profile affected %d rows, want 0 (no update policy exists on profiles at all)", tag.RowsAffected())
			}
		})
	})

	t.Run("non_admin_cannot_update_other_users_profile_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update profiles set username = 'pwned' where id = $1`, userB)
			if err != nil {
				t.Fatalf("update other user's profile: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("update of other user's profile affected %d rows, want 0", tag.RowsAffected())
			}
		})
	})

	t.Run("unqualified_update_never_touches_any_profile_non_admin", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update profiles set username = 'pwned'`)
			if err != nil {
				t.Fatalf("unqualified update profiles: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified update affected %d profiles, want 0 (no update policy exists — "+
					"not even the caller's own row is reachable)", tag.RowsAffected())
			}
		})
	})

	// 0129 (team) and 0130 (last_seen_at) add columns, not policies. Neither is
	// writable from a client: team is admin-only through setAccountTeam's
	// service-role client, last_seen_at through touchPresence's.
	for _, column := range []struct{ name, value string }{
		{"team", "'ai_animator'"},
		{"last_seen_at", "now()"},
	} {
		column := column
		t.Run("non_admin_cannot_set_own_"+column.name, func(t *testing.T) {
			runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
				tag, err := tx.Exec(ctx,
					`update profiles set `+column.name+` = `+column.value+` where id = $1`, userA)
				if err != nil {
					t.Fatalf("update own %s: %v", column.name, err)
				}
				if tag.RowsAffected() != 0 {
					t.Errorf("update of own %s affected %d rows, want 0", column.name, tag.RowsAffected())
				}
			})
		})

		t.Run("admin_cannot_set_"+column.name+"_through_the_client_either", func(t *testing.T) {
			runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
				tag, err := tx.Exec(ctx,
					`update profiles set `+column.name+` = `+column.value+` where id = $1`, userB)
				if err != nil {
					t.Fatalf("admin update %s: %v", column.name, err)
				}
				if tag.RowsAffected() != 0 {
					t.Errorf("admin client update of %s affected %d rows, want 0 (only the service-role action writes it)",
						column.name, tag.RowsAffected())
				}
			})
		})
	}

	// Admin gets no special treatment either — profiles_select_admin is a
	// SELECT policy only; there is no admin-scoped UPDATE policy to widen.
	t.Run("unqualified_update_never_touches_any_profile_admin", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update profiles set username = 'pwned'`)
			if err != nil {
				t.Fatalf("unqualified update profiles (admin): %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified update as admin affected %d profiles, want 0 (profiles has no update "+
					"policy at all, admin included — web/actions/profile.ts's admin client is the only writer)", tag.RowsAffected())
			}
		})
	})
}

// seedAllowanceGrant inserts an allowance_grants row via the superuser pool
// (this table is append-only by RLS design — see allowance_grants' own
// comment in 0032_allowance_requests.sql — so every row an RLS test needs to
// already exist must be seeded outside RLS entirely).
func seedAllowanceGrant(ctx context.Context, t *testing.T, s *Store, userID, grantedBy string) (id string) {
	t.Helper()
	if err := s.pool.QueryRow(ctx, `
INSERT INTO allowance_grants (user_id, amount_usd, expires_at, granted_by)
VALUES ($1, 5, $2, $3)
RETURNING id`, userID, time.Now().Add(7*24*time.Hour), grantedBy).Scan(&id); err != nil {
		t.Fatalf("seed allowance_grant: %v", err)
	}
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(), `DELETE FROM allowance_grants WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup allowance_grant %s: %v", id, err)
		}
	})
	return id
}

// =============================================================================
// allowance_grants (0032_allowance_requests.sql) — a money ledger. select +
// insert_admin only; NO update, NO delete policy at all, by design (this
// table's own comment: "never mutated once written" — correcting a mistaken
// grant means a new, smaller/expired one, not rewriting history).
// =============================================================================
func TestRLSAllowanceGrants(t *testing.T) {
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
	userB := seedUser(ctx, t, s)
	adminUser := seedUser(ctx, t, s)
	makeAdmin(ctx, t, s, adminUser)

	grantA := seedAllowanceGrant(ctx, t, s, userA, adminUser)
	grantB := seedAllowanceGrant(ctx, t, s, userB, adminUser)

	t.Run("select_own_grant", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from allowance_grants where id = $1`, grantA).Scan(&count); err != nil {
				t.Fatalf("select own grant: %v", err)
			}
			if count != 1 {
				t.Errorf("own grant visible rows = %d, want 1", count)
			}
		})
	})

	t.Run("select_other_users_grant_returns_zero", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from allowance_grants where id = $1`, grantB).Scan(&count); err != nil {
				t.Fatalf("select other user's grant: %v", err)
			}
			if count != 0 {
				t.Errorf("other user's grant visible rows = %d, want 0", count)
			}
		})
	})

	t.Run("admin_can_select_other_users_grant", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from allowance_grants where id = $1`, grantB).Scan(&count); err != nil {
				t.Fatalf("admin select other user's grant: %v", err)
			}
			if count != 1 {
				t.Errorf("admin visible rows for other user's grant = %d, want 1 (admin read access is being denied uselessly strict)", count)
			}
		})
	})

	t.Run("admin_can_insert_grant_for_another_user", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx,
				`insert into allowance_grants (user_id, amount_usd, expires_at, granted_by) values ($1, 5, now() + interval '7 days', $2)`,
				userB, adminUser,
			)
			if err != nil {
				t.Fatalf("admin insert grant: %v", err)
			}
			if tag.RowsAffected() != 1 {
				t.Errorf("admin insert grant affected %d rows, want 1 (admin write access is being denied uselessly strict)", tag.RowsAffected())
			}
		})
	})

	// Money: a non-admin must not be able to grant themselves anything, even
	// naming themselves as both user_id and granted_by.
	t.Run("non_admin_cannot_insert_grant_for_self", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into allowance_grants (user_id, amount_usd, expires_at, granted_by) values ($1, 5, now() + interval '7 days', $1)`,
				userA,
			)
			if err == nil {
				t.Errorf("non-admin insert of a grant for themselves succeeded, want RLS denial")
			}
		})
	})

	t.Run("non_admin_cannot_insert_grant_for_another_user", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			_, err := tx.Exec(ctx,
				`insert into allowance_grants (user_id, amount_usd, expires_at, granted_by) values ($1, 5, now() + interval '7 days', $2)`,
				userB, userA,
			)
			if err == nil {
				t.Errorf("non-admin insert of a grant for another user succeeded, want RLS denial")
			}
		})
	})

	// Append-only: no update policy exists at all, for anyone, own row or
	// not, admin or not. Targeted first (the row IS select-visible to its
	// owner, so a 0-row result here is solely the missing UPDATE policy, not
	// a SELECT-policy proxy).
	t.Run("non_admin_cannot_update_own_grant_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update allowance_grants set amount_usd = 999 where id = $1`, grantA)
			if err != nil {
				t.Fatalf("update own grant: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("update of own grant affected %d rows, want 0 (allowance_grants has no update policy at all)", tag.RowsAffected())
			}
		})
	})

	t.Run("admin_cannot_update_grant_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update allowance_grants set amount_usd = 999 where id = $1`, grantB)
			if err != nil {
				t.Fatalf("admin update grant: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("admin update of a grant affected %d rows, want 0 (no update policy exists — "+
					"even admin cannot mutate a ledger entry through RLS)", tag.RowsAffected())
			}
		})
	})

	t.Run("unqualified_update_never_touches_any_grant", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `update allowance_grants set amount_usd = 999`)
			if err != nil {
				t.Fatalf("unqualified update allowance_grants: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified update affected %d grants, want 0 (no update policy exists on allowance_grants)", tag.RowsAffected())
			}
		})
	})

	t.Run("non_admin_cannot_delete_own_grant_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, userA, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from allowance_grants where id = $1`, grantA)
			if err != nil {
				t.Fatalf("delete own grant: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("delete of own grant affected %d rows, want 0 (allowance_grants has no delete policy at all)", tag.RowsAffected())
			}
		})
	})

	t.Run("admin_cannot_delete_grant_targeted", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from allowance_grants where id = $1`, grantB)
			if err != nil {
				t.Fatalf("admin delete grant: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("admin delete of a grant affected %d rows, want 0 (no delete policy exists — "+
					"even admin cannot erase a ledger entry through RLS)", tag.RowsAffected())
			}
		})
	})

	t.Run("unqualified_delete_never_touches_any_grant", func(t *testing.T) {
		runAsUser(ctx, t, s, adminUser, func(tx pgx.Tx) {
			tag, err := tx.Exec(ctx, `delete from allowance_grants`)
			if err != nil {
				t.Fatalf("unqualified delete allowance_grants: %v", err)
			}
			if tag.RowsAffected() != 0 {
				t.Errorf("unqualified delete as admin affected %d grants, want 0 (no delete policy exists on allowance_grants)", tag.RowsAffected())
			}
		})
	})
}
