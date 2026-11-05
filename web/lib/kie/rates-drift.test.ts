// Drift guard: worker/internal/kie/models.go's Rates table (this file's
// Go-side twin) is a hand-maintained mirror of KIE_RATES below — its own
// header says so explicitly ("mirrored field-for-field... so a rate changed
// on one side and not the other is a drift the worker/web-side drift test
// ... can actually catch") and names THIS test by description. That
// description used to point at web/lib/models-drift.test.ts, which compared
// web/lib/models.ts against the now-deleted worker/internal/fal/models.go —
// gone along with fal itself, and never replaced with a kie-shaped
// successor. This is that successor: a real render is priced from
// runs.cost_usd (what kie actually billed), never from either of these
// tables, but every ESTIMATE shown before that render — the render gate,
// the spend caps in enqueue-guard.ts, the per-scene cost preview — is priced
// from web/lib/kie/rates.ts's rateFor(). If worker/internal/kie/models.go's
// Rates disagreed with KIE_RATES, nothing here would look broken: both
// sides would keep compiling, keep submitting real renders, and just quote
// the operator a number that isn't what kie is about to charge — exactly
// the shape of bug 0066_kie_video_models_count_as_render.sql's header
// describes for the render-vs-iterate split, one layer over.
//
// Same "resolve off import.meta.url, not process.cwd()" reasoning as
// lib/version.test.ts, so this works under `vitest run` regardless of which
// directory it's invoked from.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CREDITS_PER_USD,
  GEMINI_OMNI_VIDEO_CREDITS,
  KIE_RATES,
  type Provenance,
  type RatePoint,
} from "./rates";

const WEB_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GO_MODELS_FILE = `${WEB_ROOT}/../worker/internal/kie/models.go`;

/**
 * Returns the index of the `{` matching the one at `openBraceIndex` —
 * plain depth counting, not a regex, because Go struct/map literals nest
 * (ModelRates{ Silent: map[string]RatePoint{ "1080p": {...} } }) and a
 * regex has no way to express "balanced to arbitrary depth."
 */
function matchBalanced(source: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unbalanced braces starting at index ${openBraceIndex} in ${GO_MODELS_FILE}`);
}

/**
 * Every `"key": { ... }` block sitting at the TOP level of `body` (not
 * nested inside another such block) — used both for Rates' own
 * modelId -> ModelRates entries and, one level down, each ModelRates'
 * resolution -> RatePoint entries. Advancing `lastIndex` past each match's
 * closing brace (not just its opening one) is what keeps this to top-level
 * blocks only: a nested `"key": {` inside the block just consumed is never
 * independently matched.
 */
function extractQuotedBlocks(body: string): [key: string, block: string][] {
  const results: [string, string][] = [];
  const re = /"([^"]+)":\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const key = match[1]!;
    const openIdx = match.index + match[0].length - 1;
    const closeIdx = matchBalanced(body, openIdx);
    results.push([key, body.slice(openIdx + 1, closeIdx)]);
    re.lastIndex = closeIdx + 1;
  }
  return results;
}

/** The body of `fieldName: map[string]RatePoint{ ... }` inside a ModelRates block, or undefined when the field is absent (Go's nil map — "this model has no sound tier," not a parse failure). */
function extractRatePointMap(
  modelBlock: string,
  fieldName: "Silent" | "Sound" | "Video",
): string | undefined {
  const re = new RegExp(`\\b${fieldName}:\\s*map\\[string\\]RatePoint\\{`);
  const match = re.exec(modelBlock);
  if (!match) return undefined;
  const openIdx = match.index + match[0].length - 1;
  const closeIdx = matchBalanced(modelBlock, openIdx);
  return modelBlock.slice(openIdx + 1, closeIdx);
}

interface GoRatePoint {
  creditsPerSecond: number;
  provenance: Provenance;
  pricedAt: string;
  promotionEndsAt?: string;
}

function parseRatePoint(block: string, dateConsts: Record<string, string>): GoRatePoint {
  const credits = /CreditsPerSecond:\s*([\d.]+)/.exec(block)?.[1];
  const provenanceIdent = /Provenance:\s*Provenance(Receipt|Published)/.exec(block)?.[1];
  const pricedAtIdent = /PricedAt:\s*(\w+)/.exec(block)?.[1];
  if (credits === undefined || provenanceIdent === undefined || pricedAtIdent === undefined) {
    throw new Error(`RatePoint block missing CreditsPerSecond/Provenance/PricedAt:\n${block}`);
  }
  const pricedAt = dateConsts[pricedAtIdent];
  if (pricedAt === undefined) {
    throw new Error(`PricedAt referenced an unknown constant "${pricedAtIdent}" in:\n${block}`);
  }
  const promotionEndsAt = /PromotionEndsAt:\s*"([^"]+)"/.exec(block)?.[1];
  return {
    creditsPerSecond: Number(credits),
    provenance: provenanceIdent === "Receipt" ? "receipt" : "published",
    pricedAt,
    ...(promotionEndsAt !== undefined ? { promotionEndsAt } : {}),
  };
}

function parseRatePointMap(
  mapBody: string,
  dateConsts: Record<string, string>,
): Record<string, GoRatePoint> {
  const out: Record<string, GoRatePoint> = {};
  for (const [resolution, pointBlock] of extractQuotedBlocks(mapBody)) {
    out[resolution] = parseRatePoint(pointBlock, dateConsts);
  }
  return out;
}

interface GoModelRates {
  silent: Record<string, GoRatePoint>;
  sound?: Record<string, GoRatePoint>;
  video?: Record<string, GoRatePoint>;
}

function parseGoRates(source: string): Record<string, GoModelRates> {
  // The date constants are declared once, in a single `const (...)` block,
  // and every RatePoint's PricedAt refers to
  // one of the two identifiers rather than repeating the literal — resolve
  // them here instead of hardcoding "2026-08-31" into this test, which would
  // silently stop verifying the date the moment either constant changes.
  const dateConsts: Record<string, string> = {};
  for (const constMatch of source.matchAll(
    /\b([A-Za-z]\w*)\s*=\s*"(\d{4}-\d{2}-\d{2})"/g,
  )) {
    dateConsts[constMatch[1]!] = constMatch[2]!;
  }
  expect(Object.keys(dateConsts).length).toBeGreaterThan(0);

  const ratesDeclMatch = /var Rates = map\[string\]ModelRates\{/.exec(source);
  if (!ratesDeclMatch) {
    throw new Error("Could not find `var Rates = map[string]ModelRates{` in models.go");
  }
  const openIdx = ratesDeclMatch.index + ratesDeclMatch[0].length - 1;
  const closeIdx = matchBalanced(source, openIdx);
  const ratesBody = source.slice(openIdx + 1, closeIdx);

  const rates: Record<string, GoModelRates> = {};
  for (const [modelId, modelBlock] of extractQuotedBlocks(ratesBody)) {
    const silentBody = extractRatePointMap(modelBlock, "Silent");
    if (silentBody === undefined) {
      throw new Error(
        `Model "${modelId}" has no Silent map — every model has one (see rates.ts's KieRates.silent doc comment)`,
      );
    }
    const soundBody = extractRatePointMap(modelBlock, "Sound");
    const videoBody = extractRatePointMap(modelBlock, "Video");
    rates[modelId] = {
      silent: parseRatePointMap(silentBody, dateConsts),
      ...(soundBody !== undefined ? { sound: parseRatePointMap(soundBody, dateConsts) } : {}),
      ...(videoBody !== undefined ? { video: parseRatePointMap(videoBody, dateConsts) } : {}),
    };
  }
  return rates;
}

function parseGeminiNoVideoCredits(source: string): Record<string, Record<number, number>> {
  const decl = /var geminiOmniNoVideoCredits = map\[string\]map\[int\]float64\{/.exec(source);
  if (!decl) throw new Error("Could not parse geminiOmniNoVideoCredits from models.go");
  const openIdx = decl.index + decl[0].length - 1;
  const body = source.slice(openIdx + 1, matchBalanced(source, openIdx));
  return Object.fromEntries(
    extractQuotedBlocks(body).map(([resolution, values]) => [
      resolution,
      Object.fromEntries(
        [...values.matchAll(/(\d+):\s*([\d.]+)/g)].map((match) => [
          Number(match[1]!),
          Number(match[2]!),
        ]),
      ),
    ]),
  );
}

function parseGeminiVideoCredits(source: string): Record<string, number> {
  const decl = /var geminiOmniVideoCredits = map\[string\]float64\{/.exec(source);
  if (!decl) throw new Error("Could not parse geminiOmniVideoCredits from models.go");
  const openIdx = decl.index + decl[0].length - 1;
  const body = source.slice(openIdx + 1, matchBalanced(source, openIdx));
  return Object.fromEntries(
    [...body.matchAll(/"([^"]+)":\s*([\d.]+)/g)].map((match) => [match[1]!, Number(match[2]!)]),
  );
}

/** KIE_RATES' RatePoint carries `note`, which is prose, not a priced fact — stripped so the comparison below is about the numbers, not the commentary. */
function stripNote({ note: _note, ...rest }: RatePoint): GoRatePoint {
  return rest;
}

describe("web/lib/kie/rates.ts vs worker/internal/kie/models.go", () => {
  const goRates = parseGoRates(readFileSync(GO_MODELS_FILE, "utf8"));
  const webModelIds = Object.keys(KIE_RATES);

  it("parses a non-empty, expected-size model set out of models.go", () => {
    // Pinned to the web side's own count, not a literal, so this fails loud
    // (an empty/short array) rather than silently passing every assertion
    // below over nothing the moment the regex stops matching after a
    // Go-side refactor.
    expect(Object.keys(goRates).length).toBeGreaterThan(0);
    expect(Object.keys(goRates)).toHaveLength(webModelIds.length);
  });

  it("has the same set of model ids on both sides", () => {
    expect(Object.keys(goRates).sort()).toEqual([...webModelIds].sort());
  });

  it("CreditsPerUSD (Go) matches CREDITS_PER_USD (web) — the one place the credits-to-dollars conversion lives on each side", () => {
    const match = /CreditsPerUSD\s*=\s*(\d+)/.exec(readFileSync(GO_MODELS_FILE, "utf8"));
    if (!match?.[1]) {
      throw new Error("Could not parse CreditsPerUSD out of models.go");
    }
    expect(Number(match[1])).toBe(CREDITS_PER_USD);
  });

  it.each(webModelIds.map((id) => [id, KIE_RATES[id]!] as const))(
    "%s: silent/sound/video resolutions and prices match",
    (id, webRates) => {
      const goModelRates = goRates[id];
      // Existence is already covered by the set-equality test above; this
      // guards a future change to that test from silently letting an
      // undefined lookup through here.
      if (!goModelRates) throw new Error(`No Go-side Rates entry found for id "${id}"`);

      const webSilent = Object.fromEntries(
        Object.entries(webRates.silent).map(([resolution, rate]) => [resolution, stripNote(rate)]),
      );
      expect(goModelRates.silent).toEqual(webSilent);

      // sound is optional on both sides and its absence is meaningful (no
      // audio tier at all, not "audio costs nothing" — see rates.ts's
      // KieRates.sound doc comment), so undefined must match undefined
      // exactly rather than being treated as "no rows to compare."
      if (webRates.sound === undefined) {
        expect(goModelRates.sound).toBeUndefined();
      } else {
        const webSound = Object.fromEntries(
          Object.entries(webRates.sound).map(([resolution, rate]) => [resolution, stripNote(rate)]),
        );
        expect(goModelRates.sound).toEqual(webSound);
      }

      if (webRates.video === undefined) {
        expect(goModelRates.video).toBeUndefined();
      } else {
        const webVideo = Object.fromEntries(
          Object.entries(webRates.video).map(([resolution, rate]) => [resolution, stripNote(rate)]),
        );
        expect(goModelRates.video).toEqual(webVideo);
      }
    },
  );

  it("keeps Gemini's exact duration and fixed video-price tables in sync", () => {
    const source = readFileSync(GO_MODELS_FILE, "utf8");
    expect(parseGeminiNoVideoCredits(source)).toEqual(GEMINI_OMNI_VIDEO_CREDITS.noVideo);
    expect(parseGeminiVideoCredits(source)).toEqual(GEMINI_OMNI_VIDEO_CREDITS.withVideo);
  });
});
