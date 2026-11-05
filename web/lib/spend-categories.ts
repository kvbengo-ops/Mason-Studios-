// The TypeScript mirror of 0037_spend_category_totals.sql's CASE, as widened
// by 0056_seedance_counts_as_render.sql — see those headers for the full
// reasoning (why 'render' is a LIKE on "-to-video" rather than an enumerated
// endpoint list, and why the real aggregation happens in SQL, never here).
//
// fal is decommissioned; kie is the only vendor a video render can ever
// write. `runs.model` for a video render is worker/internal/kie/models.go's
// Model.KieModelID — the WIRE string kie itself expects ("kling-3.0/video",
// not this product's own "kling-3.0-pro" id) — mirrored on the web side by
// lib/kie/models.ts's KieModel.kieModelName. Every image generation
// (lib/kie.ts's generateImage) ALSO now writes vendor="kie", but at a model
// string ("google/nano-banana", "google/nano-banana-edit") that appears in
// neither list, so it still lands in 'iterate' — the vendor check alone was
// never sufficient to tell a render apart from a reference-frame image, and
// still isn't.
//
// This file is NOT on the /spend read path — web/lib/db-aggregates.ts's
// getSpendCategoryTotals/getSpendCategoryTotalsByUser call the SQL
// functions directly, which is where every real dollar figure this feature
// shows comes from (aggregate in SQL, never fetch-and-reduce — this
// schema's standing rule, see lib/spend.ts's own header). categorizeRun
// exists so the categorization RULE itself — "which bucket does this
// vendor/model pair land in" — has one place written in TypeScript,
// reviewable and unit-testable, that a reviewer can check the SQL CASE
// against by eye, and so a future call site that genuinely does need this
// classification client-side (a UI label next to a single run row, say)
// has a shared implementation instead of a second, possibly-drifted copy of
// the same three conditions.
import { KIE_MODELS } from "@/lib/kie/models";

export type SpendCategory = "iterate" | "render";

/**
 * The exact set of kie wire model ids a video render can ever write to
 * `runs.model` — worker/internal/kie/models.go's `model.KieModelID`, one per
 * lib/kie/models.ts's KIE_MODELS entry. An exact-match Set here, not the SQL
 * side's LIKE '%-to-video%' — this file has the authoritative list in hand
 * (KIE_MODELS) and should use it exactly, unlike the SQL function, which has
 * no access to a TypeScript import and falls back to a naming convention
 * (see 0037_spend_category_totals.sql's header for what breaks that
 * convention would mean).
 */
const VIDEO_MODEL_WIRE_IDS: ReadonlySet<string> = new Set(KIE_MODELS.map((m) => m.kieModelName));

/**
 * Which spend category one `runs` row belongs to — 'render' for a video
 * generation (the one expensive commit per ad), 'iterate' for everything
 * else (a Claude compile or a reference-frame image, both cheap and done
 * repeatedly). Total function: every (vendor, model) pair lands in exactly
 * one bucket, never neither — see spend-categories.test.ts for the pinning
 * tests against this codebase's actual vendor/model strings.
 */
export function categorizeRun(vendor: string, model: string): SpendCategory {
  return vendor === "kie" && VIDEO_MODEL_WIRE_IDS.has(model) ? "render" : "iterate";
}
