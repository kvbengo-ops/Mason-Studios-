// The guard that would have caught the bug 0056_seedance_counts_as_render.sql
// (and 0066_kie_video_models_count_as_render.sql after it) exist to fix, and
// that nothing else in this repo has.
//
// /spend's iterate-vs-render split lives in SQL, where it cannot import
// KIE_MODELS, so 0066_kie_video_models_count_as_render.sql matches
// runs.model against an exact-match list written out by hand instead. Its
// own header says what would break it: a fourth kie model added without
// updating this list falls silently into 'iterate'. A comment asking a
// future author to remember is not a check. This is: it reads the live SQL
// predicate out of the migration file and asserts it classifies every model
// this codebase can actually route to, in BOTH directions.
//
// lib/spend-categories.ts is deliberately not the subject: it matches an
// exact Set built from KIE_MODELS and was never wrong. The SQL is the copy
// that drifted (twice — first for fal's endpoint-naming convention, then
// for kie's), so the SQL is what this reads.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KIE_MODELS } from "@/lib/kie/models";
import { REF_FRAME_COST_USD } from "@/lib/models";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

/**
 * The exact-match wire ids the newest migration to define
 * spend_category_totals uses for the 'render' bucket, read from the file
 * rather than restated here — a restated copy would agree with itself
 * forever, which is the failure mode this whole file exists to avoid.
 *
 * "Newest that defines it" rather than a hardcoded filename: 0037 wrote
 * these functions, 0040 redefined them to union the archive in, 0056
 * redefined them again for fal's naming convention, and
 * 0066_kie_video_models_count_as_render.sql redefined them a third time for
 * kie's. Whichever migration is last wins in a fresh database, so that is
 * the one whose predicate is live.
 */
function liveRenderModelIds(): string[] {
  const defining = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").includes(
        "create or replace function spend_category_totals(",
      ),
    );

  expect(
    defining.length,
    "no migration defines spend_category_totals() — this test is reading nothing",
  ).toBeGreaterThan(0);

  const sql = readFileSync(join(MIGRATIONS_DIR, defining[defining.length - 1]!), "utf8");
  const match = sql.match(/t\.model = any \(array\[\s*([^\]]+)\]\)/);
  expect(
    match,
    "could not find the render-bucket exact-match array in the live definition — if the " +
      "predicate changed shape, this test must be taught the new shape rather than deleted",
  ).not.toBeNull();

  // Pull each single-quoted literal out of the array body.
  return [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

function livePerUserSpendCategorySql(): string {
  const defining = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").includes(
        "create or replace function spend_category_totals_by_user(",
      ),
    );

  expect(
    defining.length,
    "no migration defines spend_category_totals_by_user() — this test is reading nothing",
  ).toBeGreaterThan(0);

  return readFileSync(join(MIGRATIONS_DIR, defining[defining.length - 1]!), "utf8");
}

describe("the SQL render-category predicate", () => {
  const renderModelIds = liveRenderModelIds();

  it("classifies every video model this codebase can route to as 'render'", () => {
    expect(KIE_MODELS.length).toBeGreaterThan(0);

    for (const model of KIE_MODELS) {
      expect(
        renderModelIds.includes(model.kieModelName),
        `${model.id} (${model.kieModelName}) is not in the SQL predicate's render list, so its ` +
          `renders are being counted as cheap iteration on /spend. Add it in a new migration, in ` +
          `the same commit that adds the model.`,
      ).toBe(true);
    }
  });

  it("does NOT sweep the iterate side into 'render'", () => {
    // The other direction, which matters just as much: the render list must
    // not also catch an image generation or a Claude compile, or the split
    // stops meaning anything. These are the model strings the non-video
    // writers actually record — lib/kie.ts's image endpoints and
    // lib/claude.ts's compiler ids.
    expect(REF_FRAME_COST_USD).toBeGreaterThan(0); // the image path exists
    for (const notVideo of [
      "google/nano-banana",
      "google/nano-banana-edit",
      "claude-haiku-4-5",
      "claude-sonnet-5",
      "claude-opus-5",
      "gemini-3-8-flash",
    ]) {
      expect(
        renderModelIds.includes(notVideo),
        `${notVideo} is in the SQL predicate's render list and would be counted as a video render`,
      ).toBe(false);
    }
  });
});

describe("the SQL per-user spend attribution", () => {
  const sql = livePerUserSpendCategorySql();

  it("includes projectless image runs and keeps the requested half-open time window", () => {
    expect(sql).toContain("coalesce(r.user_id, p.user_id)");
    expect(sql).toContain("left join projects p on p.id = r.project_id");
    expect(sql).toContain("r.created_at >= from_ts and r.created_at < to_ts");
    expect(sql).toContain("h.run_created_at >= from_ts and h.run_created_at < to_ts");
  });
});
