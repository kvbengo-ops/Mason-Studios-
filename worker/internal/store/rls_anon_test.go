package store

import (
	"context"
	"os"
	"testing"
)

// Pins a security invariant that currently holds only by omission: the `anon`
// role has no table privileges at all, so an unauthenticated caller is
// rejected at the GRANT layer before any RLS policy is even consulted.
//
// This matters because two policies are deliberately unrestricted —
// characters_select (0020_characters.sql) and prompt_templates_select
// (0008_prompt_templates_rls.sql) are both `using (true)`, since a shared
// character library and the compiler's own templates are readable by any
// signed-in editor. But only prompt_templates_select carries a `to
// authenticated` clause. characters_select has none, so it applies to PUBLIC,
// which includes anon.
//
// Today that is harmless: 0007_grants.sql grants table privileges to
// `authenticated` and never to `anon`, so `set role anon; select * from
// characters` fails with "permission denied for table characters" — the
// policy is never reached. The invariant is the grant, not the policy.
//
// That is exactly why it deserves a test. The day someone grants anon read
// access for a genuinely public page, characters becomes world-readable with
// no policy change to notice in review and nothing failing. This test fails
// at that moment instead.
//
// The narrower fix would be adding `to authenticated` to characters_select so
// it matches its sibling and stops depending on the grant layer at all. That
// needs a migration; this test guards the invariant either way.
func TestRLSAnonHasNoTablePrivileges(t *testing.T) {
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

	// Every table the migrations create. A new table that grants anon
	// anything will surface here rather than in an incident.
	tables := []string{
		"allowance_grants",
		"allowance_requests",
		"assets",
		"characters",
		"chat_conversations",
		"chat_messages",
		"chat_read_states",
		"deleted_project_cost_history",
		"deleted_scene_versions",
		"deleted_scenes",
		"kie_topups",
		"notifications",
		"profiles",
		"projects",
		"prompt_templates",
		"runs",
		"scenes",
	}

	for _, table := range tables {
		t.Run(table, func(t *testing.T) {
			// Assert the table EXISTS before counting its grants. Without
			// this the whole test passes vacuously against an empty
			// database: "anon holds no privileges on X" is trivially true
			// when X was never created. Caught exactly that way — a run
			// against a database whose migrations had silently not applied
			// reported every subtest here green.
			var exists bool
			if err := s.pool.QueryRow(ctx,
				`select to_regclass('public.' || $1) is not null`, table,
			).Scan(&exists); err != nil {
				t.Fatalf("check %s exists: %v", table, err)
			}
			if !exists {
				t.Fatalf("table %s does not exist — migrations did not apply, so this "+
					"test would otherwise pass for the wrong reason", table)
			}

			// has_table_privilege, NOT a row count over
			// information_schema.role_table_grants. That catalog records the
			// grantee a GRANT literally named, so `grant select on characters
			// to PUBLIC` files a row under grantee 'PUBLIC' and none under
			// 'anon' — while anon, like every role, inherits it and can read
			// the table outright. An earlier version of this test filtered on
			// `grantee = 'anon'` and reported CLEAN in exactly that state;
			// measured against this schema, anon read the full character
			// library while the subtest stayed green.
			//
			// has_table_privilege asks Postgres to resolve effective
			// privilege — direct grants, PUBLIC, and role inheritance
			// together — which is the only thing that actually decides
			// whether an unauthenticated caller gets in.
			var held []string
			for _, priv := range []string{
				"SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER",
			} {
				var has bool
				if err := s.pool.QueryRow(ctx,
					`select has_table_privilege('anon', $1, $2)`, table, priv,
				).Scan(&has); err != nil {
					t.Fatalf("check anon %s on %s: %v", priv, table, err)
				}
				if has {
					held = append(held, priv)
				}
			}
			if len(held) != 0 {
				t.Errorf("anon effectively holds %v on %s, want none — an unauthenticated "+
					"caller must be stopped by GRANTs before RLS is consulted; "+
					"characters_select and prompt_templates_select are `using (true)` "+
					"and would admit anon outright. Note a grant to PUBLIC is enough "+
					"to cause this, and shows up under grantee 'PUBLIC', not 'anon'",
					held, table)
			}
		})
	}
}
