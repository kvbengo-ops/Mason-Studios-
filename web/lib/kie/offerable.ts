// Which model/resolution pairs /ugc may actually offer, and why the rest are
// refused.
//
// Before fal was decommissioned, this module existed to reconcile two price
// tables that did not know the same things: lib/kie/rates.ts (credits per
// second, receipt or published) and lib/models.ts, which was fal-shaped and
// fell back to fal's rate for any kie pair it had no measurement for — the
// exact mismatch that once quoted Seedance 2.5 at 480P for $0.56 while the
// spend cap checked it against fal's $1.87 number. lib/models.ts's
// VideoModelDescriptor now reads its own prices straight through
// lib/kie/rates.ts (see that file's priceForSecond), so there is no second
// table left to disagree with.
//
// PUBLISHED PRICES ARE SOLD (2026-10-30, by the owner's decision): kie's
// documented rate is trusted without a measuring render. Every receipt so far
// matched the published number to the credit. The UI still labels an unpaid
// rate (ugc-column.tsx), and a measured render still flips it to "receipt".
// The one refusal left is a lapsed promotion — see offers().

import { KIE_MODELS, type KieModel } from "@/lib/kie/models";
import {
  geminiOmniCredits,
  isPromotionExpired,
  offerRateFor,
  type Resolution,
} from "@/lib/kie/rates";

export interface Offer {
  readonly model: KieModel;
  readonly resolution: Resolution;
  /** False when the pair may be quoted but not sold — see `blockedReason`. */
  readonly offerable: boolean;
  /**
   * Operator-facing reason, present exactly when `offerable` is false.
   *
   * Written to be read on a disabled control rather than logged. A disabled
   * option with no reason is the thing this product has rewritten twice
   * already — see renderCapRefusalMessage, which was changed to name the
   * misconfiguration rather than blame the daily cap.
   */
  readonly blockedReason?: string;
}

/**
 * Every pair, marked with whether it can be sold today.
 *
 * Deliberately returns the blocked ones too, so a refused tier reads as
 * refused for a reason rather than as a tier kie does not have.
 */
export function offers(withSound: boolean): Offer[] {
  const out: Offer[] = [];
  const now = new Date();

  for (const model of KIE_MODELS) {
    for (const resolution of model.resolutions) {
      const rate = offerRateFor(model.id, resolution, withSound);
      if (!rate) continue;

      // A lapsed promotion is the one published number known to be wrong,
      // and wrong LOW — selling on it would under-quote every cap check.
      if (isPromotionExpired(rate, now)) {
        out.push({
          model,
          resolution,
          offerable: false,
          blockedReason:
            `${model.label} at ${resolution} was priced under a kie promotion that ended ` +
            `${rate.promotionEndsAt}, so the stored rate is too low to sell on.`,
        });
        continue;
      }

      out.push({ model, resolution, offerable: true });
    }
  }

  return out;
}

/** Just the pairs that can be sold, in the cheapest-first order KIE_MODELS declares. */
export function offerable(withSound: boolean): Offer[] {
  return offers(withSound).filter((o) => o.offerable);
}

/**
 * The pair /ugc should start on.
 *
 * Cheapest offerable pair at the given duration, NOT the cheapest pair
 * overall — those differ today, and pretending otherwise is how a default
 * ends up being a price nobody verified. Returns null when nothing can be
 * sold at that length, which is a real state: no enabled model prices a 4s
 * clip except Kling, and Hailuo refuses 4s outright.
 */
export function defaultOffer(durationS: number, withSound: boolean): Offer | null {
  const candidates = offerable(withSound).filter((o) => o.model.durationsS.includes(durationS));
  if (candidates.length === 0) return null;

  let best = candidates[0]!;
  let bestCredits = creditsForOffer(best, durationS, withSound);
  for (const candidate of candidates.slice(1)) {
    const credits = creditsForOffer(candidate, durationS, withSound);
    if (credits < bestCredits) {
      best = candidate;
      bestCredits = credits;
    }
  }
  return best;
}

function creditsForOffer(offer: Offer, durationS: number, withSound: boolean): number {
  if (offer.model.id === "gemini-omni-video") {
    // Gemini's RatePoint is a receipt/provenance marker, not a price shape:
    // the job has a fixed intercept and its exact schedule is duration-keyed.
    return geminiOmniCredits(offer.resolution, durationS, false) ?? Number.POSITIVE_INFINITY;
  }
  const rate = offerRateFor(offer.model.id, offer.resolution, withSound);
  return rate ? rate.creditsPerSecond * durationS : Number.POSITIVE_INFINITY;
}
