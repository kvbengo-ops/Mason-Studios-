// What one kie clip costs. One function, and it can refuse to answer.
//
// The old path was `priceForSecond(model, resolution, vendor) *
// billedSeconds(model, durationS)` — two vendor-aware functions multiplied
// together at three separate call sites, each having to agree with the other
// two about the vendor and about whether the clip carries sound. Three
// chances to disagree per call, in three files, on a number attached to a
// spend button.
//
// It is one call here, it works in credits because that is what kie bills,
// and it returns null rather than a number when nobody has paid for the
// combination asked about.

import {
  CREDITS_PER_USD,
  geminiOmniCredits,
  isPromotionExpired,
  offerRateFor,
  rateFor,
  type Provenance,
  type RatePoint,
  type Resolution,
} from "@/lib/kie/rates";
import { KIE_MODELS, kieModel } from "@/lib/kie/models";

export interface ClipQuote {
  readonly credits: number;
  readonly usd: number;
  /** Null when the vendor prices this as a non-linear fixed job. */
  readonly creditsPerSecond: number | null;
  readonly provenance: Provenance;
  readonly pricedAt: string;
  /**
   * True when this quote rests on a price nobody here has been billed for.
   * The UI owes the operator a visible label when this is set — a number
   * from a vendor's marketing page and a number off a receipt must not look
   * identical on a button that spends money.
   */
  readonly unpaid: boolean;
  /**
   * True when the rate was a promotion whose end date has passed, so the
   * real bill is now HIGHER than this quote. The one direction of error this
   * product has never tolerated.
   */
  readonly stale: boolean;
  readonly note?: string;
}

export interface ClipRequest {
  readonly modelId: string;
  readonly resolution: Resolution;
  readonly durationS: number;
  readonly withSound: boolean;
}

/**
 * Why a clip could not be quoted. Never a price.
 *
 * These exist so a caller can say something specific instead of showing a
 * disabled control with no reason, which is the failure the render gate's
 * own refusal messages were rewritten to fix.
 */
export type QuoteRefusal =
  | { reason: "unknown-model"; modelId: string }
  | { reason: "unsupported-duration"; allowed: readonly number[] }
  | { reason: "unsupported-resolution"; allowed: readonly Resolution[] }
  | { reason: "model-has-no-sound"; modelId: string }
  | { reason: "unpriced"; modelId: string; resolution: Resolution; withSound: boolean };

export type QuoteResult = { ok: true; quote: ClipQuote } | { ok: false; refusal: QuoteRefusal };

/**
 * Prices one clip, or explains why it cannot.
 *
 * `now` is a parameter rather than a call to the clock so that a server
 * render and a client render of the same screen cannot disagree about
 * whether a promotion has lapsed, and so the stale branch is testable
 * without freezing time globally.
 */
export function quoteClip(req: ClipRequest, now: Date): QuoteResult {
  const model = kieModel(req.modelId);
  if (!model) {
    return { ok: false, refusal: { reason: "unknown-model", modelId: req.modelId } };
  }

  if (!model.durationsS.includes(req.durationS)) {
    // Checked before the rate lookup because the failure is more specific
    // and more actionable: Hailuo has a perfectly good 768P rate and still
    // cannot render four seconds, and "unpriced" would be the wrong story.
    return { ok: false, refusal: { reason: "unsupported-duration", allowed: model.durationsS } };
  }

  if (!model.resolutions.includes(req.resolution)) {
    return {
      ok: false,
      refusal: { reason: "unsupported-resolution", allowed: model.resolutions },
    };
  }

  const rate: RatePoint | null = offerRateFor(req.modelId, req.resolution, req.withSound);
  if (!rate) {
    // Two different stories share this branch, so separate them: asking for
    // sound from a silent model is a caller bug, while an unpriced pair is
    // simply a rate nobody has read yet.
    if (req.withSound && rateFor(req.modelId, req.resolution, false) !== null) {
      return { ok: false, refusal: { reason: "model-has-no-sound", modelId: req.modelId } };
    }
    return {
      ok: false,
      refusal: {
        reason: "unpriced",
        modelId: req.modelId,
        resolution: req.resolution,
        withSound: req.withSound,
      },
    };
  }

  if (req.modelId === "gemini-omni-video") {
    const credits = geminiOmniCredits(req.resolution, req.durationS, false);
    if (credits === null) {
      return {
        ok: false,
        refusal: {
          reason: "unpriced",
          modelId: req.modelId,
          resolution: req.resolution,
          withSound: req.withSound,
        },
      };
    }
    const note = rate.note;
    return {
      ok: true,
      quote: {
        credits,
        usd: credits / CREDITS_PER_USD,
        // An average here would look linear to any future consumer. Gemini's
        // exact total is above; it has no truthful credits-per-second value.
        creditsPerSecond: null,
        provenance: rate.provenance,
        pricedAt: rate.pricedAt,
        unpaid: rate.provenance === "published",
        stale: isPromotionExpired(rate, now),
        ...(note === undefined ? {} : { note }),
      },
    };
  }

  // kie bills the seconds requested. There is no billed-seconds multiplier
  // on this vendor — that was fal's, measured when a 6s Kling request came
  // back billed as 7.2 seconds, and carrying it onto kie is what forced the
  // stored rate down to a $0.1125/s nobody was ever charged.
  const credits = rate.creditsPerSecond * req.durationS;

  return {
    ok: true,
    quote: {
      credits,
      usd: credits / CREDITS_PER_USD,
      creditsPerSecond: rate.creditsPerSecond,
      provenance: rate.provenance,
      pricedAt: rate.pricedAt,
      unpaid: rate.provenance === "published",
      stale: isPromotionExpired(rate, now),
      ...(rate.note === undefined ? {} : { note: rate.note }),
    },
  };
}

/**
 * The cheapest way to render a clip of this length, or null when no model can.
 *
 * Exists because the answer is genuinely not obvious and changes with
 * duration: at 6 seconds Hailuo wins at 54 credits, at 4 seconds Hailuo
 * cannot render at all and Kling silent wins at 72 — while Seedance at 720P,
 * which is where every silent scene used to be routed, costs 252.
 */
export function cheapestFor(
  durationS: number,
  withSound: boolean,
  now: Date,
): { modelId: string; resolution: Resolution; quote: ClipQuote } | null {
  let best: { modelId: string; resolution: Resolution; quote: ClipQuote } | null = null;

  for (const m of KIE_MODELS) {
    for (const resolution of m.resolutions) {
      const result = quoteClip({ modelId: m.id, resolution, durationS, withSound }, now);
      if (!result.ok) continue;
      // Ties go to the first listed, which is the cheapest-first order
      // KIE_MODELS already declares. A strict < keeps that stable.
      if (best === null || result.quote.credits < best.quote.credits) {
        best = { modelId: m.id, resolution, quote: result.quote };
      }
    }
  }
  return best;
}

/** Formats a quote the way a button should show it: dollars, then credits. */
export function formatQuote(quote: ClipQuote): string {
  const usd = quote.usd.toLocaleString("en-US", { style: "currency", currency: "USD" });
  return `${usd} · ${quote.credits} credits`;
}
