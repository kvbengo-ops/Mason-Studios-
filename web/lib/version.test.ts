// Drift guard: EXPECTED_DB_VERSION (this file's twin, lib/version.ts) is a
// hand-maintained constant, not derived — so nothing stops it from going
// stale the moment someone adds a new migration and forgets to bump it. This
// test is the thing that stops it: it reads supabase/migrations/ directly
// (the actual source of truth) and asserts the highest-numbered file there
// still matches EXPECTED_DB_VERSION. Add 0047 without touching lib/version.ts
// and this goes red — that's the point.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPECTED_DB_VERSION } from "./version";

// supabase/migrations/ lives at the repo root, one level above web/ — same
// "resolve off import.meta.url, not process.cwd()" reasoning as
// lib/guard-seam.test.ts's WEB_ROOT, so this works under `vitest run`
// regardless of which directory it's invoked from.
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS_DIR = join(WEB_ROOT, "..", "supabase", "migrations");

/** e.g. "0046" from "0046_applied_schema_version.sql". Every migration file
 * in this repo is named with a leading zero-padded numeric prefix. */
const VERSION_PREFIX = /^(\d+)_/;

function highestMigrationVersion(): string {
  const versions = readdirSync(MIGRATIONS_DIR)
    .map((entry) => VERSION_PREFIX.exec(entry)?.[1])
    .filter((version): version is string => version !== undefined);

  // Same "length, then value" ordering as applied_schema_version() itself
  // (supabase/migrations/0046_applied_schema_version.sql) — for same-width
  // zero-padded prefixes this agrees with plain numeric ordering, but a
  // future width change still sorts a longer, later version above a
  // shorter, earlier one instead of losing to lexicographic comparison.
  versions.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));

  const highest = versions.at(-1);
  if (highest === undefined) {
    throw new Error(`No migration files found under ${MIGRATIONS_DIR}`);
  }
  return highest;
}

import { readFileSync } from "node:fs";

/**
 * elements.category is declared twice — once as a CHECK in SQL, once as a TS
 * union — and nothing makes them agree.
 *
 * A category the union admits and the CHECK refuses is a 500 the operator
 * cannot act on: they pick "Location", press save, and get a database error
 * with nothing on screen explaining it. The reverse is quieter and worse — a
 * category the database allows but the UI never offers is a feature that
 * silently does not exist, which is exactly what "location" was between 0071
 * (which admitted it for scene_references) and 0073 (which admitted it here).
 */
describe("elements.category agrees across SQL and TypeScript", () => {
  it("offers every category the CHECK constraint admits", () => {
    // FOUND, NOT NAMED. This used to hardcode a migration filename, and that
    // was wrong twice for the same reason: it sat on 0073 until 0081 replaced
    // that CHECK, then on 0081 until 0093 replaced it again, and both times it
    // kept passing against a constraint the database no longer had. A guard
    // that has to be hand-repointed every time the thing it guards changes is
    // a guard that is stale by default and correct only by luck.
    //
    // So it reads the migrations directory and takes the LAST file that adds
    // this constraint. Migrations apply in filename order and each one drops
    // the previous, so the highest-numbered file that mentions it IS the
    // constraint in force — the same rule the database itself follows.
    const migrationsDir = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));
    const owning = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) =>
        /add constraint elements_category_check/.test(readFileSync(join(migrationsDir, f), "utf8")),
      )
      .pop();
    if (!owning) {
      throw new Error(
        "No migration adds elements_category_check. Either it was renamed or the constraint " +
          "is gone — a guard that matches nothing is worse than none.",
      );
    }
    const sql = readFileSync(join(migrationsDir, owning), "utf8");

    const match = sql.match(/check \(category in \(([^)]+)\)\)/);
    if (!match?.[1]) {
      throw new Error(
        "Could not find elements' category CHECK in 0081. If a later migration replaced it, " +
          "point this at that file — a guard that matches nothing is worse than none.",
      );
    }
    const fromSql = Array.from(match[1].matchAll(/'([a-z]+)'/g))
      .map((m) => m[1])
      .sort();

    // The union, read from source rather than imported: a type has no runtime
    // value to compare against.
    const ts = readFileSync(fileURLToPath(new URL("../types/db.ts", import.meta.url)), "utf8");
    // \s* after the =, because a union of six no longer fits on one line and
    // a guard that stops matching when the thing it guards grows is a guard
    // that reports "gone" for "reformatted".
    const union = ts.match(/export type ElementCategory =\s*([^;]+);/);
    if (!union?.[1]) throw new Error("ElementCategory is gone from web/types/db.ts");
    const fromTs = Array.from(union[1].matchAll(/"([a-z]+)"/g))
      .map((m) => m[1])
      .sort();

    expect(
      fromTs,
      "web/types/db.ts's ElementCategory and elements' CHECK constraint disagree. One of them " +
        "either refuses a category the other offers (a 500 with nothing on screen) or hides one " +
        "the database allows (a feature that silently does not exist).",
    ).toEqual(fromSql);
  });
});

describe("EXPECTED_DB_VERSION drift guard", () => {
  it("matches the highest-numbered file in supabase/migrations/", () => {
    expect(EXPECTED_DB_VERSION).toBe(highestMigrationVersion());
  });
});
