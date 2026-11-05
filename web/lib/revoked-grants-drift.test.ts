// Drift guard for the "active grant" predicate
// (0075_revoke_allowance_grants.sql).
//
// A grant counts toward an account's weekly ceiling only while it is
// unexpired AND unrevoked. Six places state that rule, and NONE of them
// share code: four SQL aggregates spread across four migrations, plus two
// PostgREST row selects in TypeScript. They cannot share code — one is an
// enforcement path, one is a batched page read, one is a team-wide sum, one
// is a single-round-trip snapshot, and two need whole rows rather than a
// sum — so the only thing keeping them in agreement is that somebody
// remembers all six.
//
// The failure this catches is silent and expensive in exactly the way the
// db-types-drift guard beside it describes: a later migration that redefines
// one of these functions from its ORIGINAL 0032/0033/0035/0044 text (the
// obvious thing to copy) drops `revoked_at is null` without any error
// anywhere. The grant an admin revoked keeps funding renders, the /users
// column keeps reporting it, and nothing fails until an invoice does.
//
// WHY TEXT, NOT A DATABASE — same reason as lib/db-types-drift.test.ts: the
// web test leg has no Postgres, and this failure does not need one. A
// function definition that omits the filter in the repo's own SQL cannot
// have it in any database built from this repo.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS_DIR = join(WEB_ROOT, "..", "supabase", "migrations");

/**
 * Every SQL function whose body decides which grants are active. Redefining
 * any of them without the revoked filter is the bug this file exists to
 * catch, so the list is the test's whole point — add to it whenever a new
 * function learns to read allowance_grants.
 */
const GRANT_AGGREGATES = [
  "user_active_grants_usd",
  "user_active_grants_usd_by_user",
  "outstanding_allowance_usd",
  "sidebar_budget_snapshot",
] as const;

/**
 * The LAST definition of `name` across every migration, in applied order —
 * which is the one a fresh database ends up with. Earlier definitions are
 * deliberately ignored: 0032's original user_active_grants_usd has no
 * revoked filter and never will, because 0075 replaces it.
 */
function latestDefinitionOf(name: string): { file: string; body: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let found: { file: string; body: string } | null = null;

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // `create or replace function <name>(` — the paren pins the match to a
    // definition rather than a mention in a comment or a call site.
    const marker = `create or replace function ${name}(`;
    const start = sql.lastIndexOf(marker);
    if (start === -1) continue;

    // A definition runs to the `$$;` that closes its body. Every function in
    // this schema is dollar-quoted, so this is exact rather than heuristic.
    const end = sql.indexOf("$$;", start);
    found = { file, body: sql.slice(start, end === -1 ? undefined : end) };
  }

  if (!found) throw new Error(`No migration defines ${name}`);
  return found;
}

describe("active-grant predicate", () => {
  it.each(GRANT_AGGREGATES)("%s filters out revoked grants", (name) => {
    const { file, body } = latestDefinitionOf(name);

    // Both halves, not just the new one: a definition that dropped the
    // expiry filter while keeping the revoked one would be just as wrong,
    // and this is the only place that reads these bodies at all.
    expect(body, `${file} defines ${name} without a revoked_at filter`).toMatch(
      /revoked_at is null/,
    );
    expect(body, `${file} defines ${name} without an expires_at filter`).toMatch(/expires_at >/);
  });

  // The two TypeScript readers. Both select ROWS rather than calling one of
  // the aggregates above (one needs amount+expiry per grant, the other needs
  // the whole row for /profile's list), so both restate the predicate by
  // hand and neither is covered by the SQL cases above.
  it.each([
    ["lib/spend.ts", join(WEB_ROOT, "lib", "spend.ts")],
    ["app/(app)/profile/page.tsx", join(WEB_ROOT, "app", "(app)", "profile", "page.tsx")],
  ])("%s pairs every allowance_grants select with a revoked_at filter", (label, path) => {
    const source = readFileSync(path, "utf8");
    const selects = source.split('.from("allowance_grants")').slice(1);

    expect(
      selects.length,
      `${label} no longer reads allowance_grants — update this test`,
    ).toBeGreaterThan(0);

    for (const chain of selects) {
      // The builder chain ends at the first semicolon that closes the
      // await/assignment; scanning a bounded window keeps an unrelated later
      // `.is(...)` in the same file from satisfying this by accident.
      const chainEnd = chain.indexOf(";");
      const window = chain.slice(0, chainEnd === -1 ? 400 : chainEnd);
      expect(window, `${label} selects allowance_grants without .is("revoked_at", null)`).toMatch(
        /\.is\("revoked_at", null\)/,
      );
    }
  });
});
