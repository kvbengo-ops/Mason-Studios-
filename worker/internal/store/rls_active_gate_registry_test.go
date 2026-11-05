package store

import (
	"context"
	"os"
	"sort"
	"strings"
	"testing"
)

// The account-status gate, asserted per policy instead of per behaviour.
//
// WHY THIS EXISTS. 0053_active_gate_on_child_writes.sql put is_active() on
// nine write policies so a rejected or deactivated account cannot write
// project children. 0085_personal_image_generator.sql needed six of those
// predicates to admit a new owner shape and used `alter policy ... using
// (...)`, which REPLACES the predicate outright — so the gate went with it, on
// six policies at once, silently. Nothing in the new expression referred to
// what it replaced, so nothing said a term had gone.
//
// TestRLSRejectedAccountCannotWriteProjectChildren does catch it, and it did
// not run: it needs a database, CI provides one, and CI was blocked. So this
// is a second, cheaper check of the same invariant, expressed as a property of
// the SCHEMA rather than of a scenario — it fails on any policy that loses the
// gate, including ones nobody has written a scenario for yet, and it names the
// policy rather than describing a behaviour that went missing.
//
// A REGISTRY, deliberately, not a scan for "every policy that mentions
// projects". The list below is the decision 0053 made, written down. A new
// write policy that should be gated has to be added here by whoever adds it,
// and the failure message says so — the same forcing-function shape as
// lib/guard-seam.ts's route registry, for the same reason: the right answer
// differs per policy and a blanket rule would be wrong half the time.
func TestActiveGateStillOnEveryWritePolicy(t *testing.T) {
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

	// The nine from 0053. SELECT policies are deliberately absent: reading your
	// own rows after your account is switched off is not a write, and 0053
	// gated writes only.
	gated := []string{
		"scenes_insert", "scenes_update", "scenes_delete",
		"assets_insert", "assets_update", "assets_delete",
		"runs_insert", "runs_update", "runs_delete",
	}

	rows, err := s.pool.Query(ctx, `
		select p.polname,
		       coalesce(pg_get_expr(p.polqual, p.polrelid), '') ||
		       coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
		  from pg_policy p
		 where p.polname = any($1)`, gated)
	if err != nil {
		t.Fatalf("read policies: %v", err)
	}
	defer rows.Close()

	seen := map[string]string{}
	for rows.Next() {
		var name, expr string
		if err := rows.Scan(&name, &expr); err != nil {
			t.Fatalf("scan: %v", err)
		}
		seen[name] = expr
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}

	var missing, absent []string
	for _, name := range gated {
		expr, ok := seen[name]
		if !ok {
			absent = append(absent, name)
			continue
		}
		if !strings.Contains(expr, "is_active()") {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	sort.Strings(absent)

	if len(absent) > 0 {
		t.Errorf("policies in the registry do not exist: %s — if one was renamed or "+
			"dropped on purpose, update this registry in the same change",
			strings.Join(absent, ", "))
	}
	if len(missing) > 0 {
		t.Errorf("is_active() is gone from: %s\n\n"+
			"0053 put it on these nine so a rejected account cannot write project children. "+
			"`alter policy ... using (...)` REPLACES a predicate — it does not extend it — so a "+
			"migration that widens one of these for a new owner shape drops the gate unless it "+
			"restates it. That is what 0085 did to six of them; 0086 put them back. If a policy "+
			"here is genuinely no longer meant to be gated, remove it from this registry in the "+
			"same change and say why.",
			strings.Join(missing, ", "))
	}
}
