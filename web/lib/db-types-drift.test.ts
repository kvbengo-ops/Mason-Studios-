// Drift guard: types/db.ts is hand-maintained, and TypeScript believes it
// completely. A column typed there that no migration ever creates is not a
// type error anywhere — it is a lie the compiler will defend, and every
// `.insert()` and `.select()` naming that column type-checks perfectly and
// then fails at runtime against PostgREST with "Could not find the '<column>'
// column of '<table>' in the schema cache".
//
// That is not hypothetical. An earlier draft of migration 0071 added
// scenes.ref_frame_category / _description / _tag; the draft was replaced by
// a scene_references table before it was ever committed, but db.ts kept the
// three columns and actions/ugc.ts kept writing them. Type-check green, unit
// tests green (they mock Supabase), CI green — and every Generate on /ugc
// failed in production with a spinner and a generic toast.
//
// WHY TEXT, NOT A DATABASE. The authoritative check is information_schema,
// but the web test leg has no Postgres (only the Go store tests get one), and
// the failure worth catching does not need one: a column that appears in no
// migration file at all cannot exist in any database built from this repo.
// Matching a bare identifier anywhere in the SQL is deliberately loose — it
// will not catch a column dropped by a later migration, or one renamed in
// place — but it catches "declared in types, created nowhere" exactly, which
// is the shape that shipped.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Same "resolve off import.meta.url, not process.cwd()" reasoning as
// lib/version.test.ts — this has to work regardless of where vitest is run.
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DB_TYPES = join(WEB_ROOT, "types", "db.ts");
const MIGRATIONS_DIR = join(WEB_ROOT, "..", "supabase", "migrations");

// db.ts is generated in Supabase's own shape, so the nesting is fixed:
// a table name at six spaces, `Row: {` at eight, and its columns at ten.
// Insert/Update repeat the same columns optionally, so reading Row alone
// covers every column without counting any of them three times.
const TABLE = /^ {6}([a-z_]+): \{$/;
const ROW_OPEN = /^ {8}Row: \{$/;
const ROW_CLOSE = /^ {8}\};$/;
const COLUMN = /^ {10}([a-z_]+)\??:/;

function declaredColumns(): Array<{ table: string; column: string }> {
  const out: Array<{ table: string; column: string }> = [];
  let table: string | null = null;
  let inRow = false;

  for (const line of readFileSync(DB_TYPES, "utf8").split("\n")) {
    // Read the capture out in one step: under noUncheckedIndexedAccess a
    // group is `string | undefined` even after the match is known non-null,
    // and the truthiness check here is what narrows it.
    const tableName = TABLE.exec(line)?.[1];
    if (tableName) {
      table = tableName;
      inRow = false;
      continue;
    }
    if (table && ROW_OPEN.test(line)) {
      inRow = true;
      continue;
    }
    if (inRow && ROW_CLOSE.test(line)) {
      inRow = false;
      continue;
    }
    if (inRow && table) {
      const columnName = COLUMN.exec(line)?.[1];
      if (columnName) out.push({ table, column: columnName });
    }
  }
  return out;
}

/** Every bare identifier across every migration, lowercased. */
function migrationIdentifiers(): Set<string> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  const words = new Set<string>();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8").toLowerCase();
    for (const word of sql.match(/[a-z_][a-z0-9_]*/g) ?? []) words.add(word);
  }
  return words;
}

describe("types/db.ts against the migrations", () => {
  it("declares no column that no migration creates", () => {
    const declared = declaredColumns();
    const identifiers = migrationIdentifiers();

    const orphans = declared
      .filter(({ column }) => !identifiers.has(column))
      .map(({ table, column }) => `${table}.${column}`)
      .sort();

    expect(
      orphans,
      "types/db.ts types these columns, but no migration mentions them. Either " +
        "the migration that would create them was never written, or it was " +
        "replaced and db.ts was not updated with it. Every write naming one of " +
        "these type-checks and then fails at runtime.",
    ).toEqual([]);
  });

  // The parse above is regex over an indentation convention, so a reformat of
  // db.ts could quietly match nothing and leave the assertion above passing
  // over an empty list forever. These pin that it found real structure —
  // same reasoning as models-drift.test.ts asserting its own parse count.
  it("parsed a plausible amount of db.ts", () => {
    const declared = declaredColumns();
    const tables = new Set(declared.map((d) => d.table));

    expect(tables.size).toBeGreaterThanOrEqual(15);
    expect(declared.length).toBeGreaterThanOrEqual(150);
    // A table everything else in this repo depends on, spot-checked so the
    // parse is proven to reach column level and not just table headings.
    expect(declared).toContainEqual({ table: "scenes", column: "video_prompt" });
    expect(declared).toContainEqual({ table: "scenes", column: "ai_generated_prompt" });
  });

  it("reads a migrations directory that is actually there", () => {
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).length).toBeGreaterThan(60);
  });
});
