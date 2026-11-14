// The receipts, as assertions.
//
// Every number in rates.ts marked `receipt` was read off the kie credit
// balance immediately before and after one render. Those three readings are
// the only ground truth this product has about what a video costs, and until
// now they lived in doc comments — which is to say, nowhere a refactor could
// notice breaking them.
//
// The two-year-old defect this guards against is not arithmetic. It is a rate
// being quietly reshaped to make a formula land: Kling's kie rate was stored
// as $0.1125/s for weeks, a number nobody was ever charged, because it was
// $0.135 divided by a 1.2 borrowed from fal's billing. Both halves were
// wrong and the product of them was right, so every test passed.

import { describe, expect, it } from "vitest";
import { quoteClip, cheapestFor } from "./cost";
import { KIE_RATES, isPromotionExpired, rateFor } from "./rates";
import { KIE_MODELS } from "./models";

// Fixed, not `new Date()`: one entry carries a promotion end date, and a test
// whose answer changes on 2026-09-17 is a test that fails on a Tuesday for
// reasons nobody remembers.
const NOW = new Date("2026-08-31T00:00:00Z");

describe("quoteClip reproduces the receipts", () => {
  it.each([
    // 15s with sound: 405 credits. The render every earlier version of the
    // price model was reverse-engineered to match.
    ["kling-3.0-pro", "1080p", 15, true, 405, 2.025],
    // 3s silent: 54 credits. The measurement that proved kie surcharges
    // AUDIO rather than billing extra seconds, and made silent Kling
    // reachable at all.
    ["kling-3.0-pro", "1080p", 3, false, 54, 0.27],
    // 10s: 90 credits. The cheapest second on the account.
    ["hailuo-2.3-pro", "768P", 10, false, 90, 0.45],
    // Seedance at 720p: 63 cr/s, confirmed against creditsConsumed. Also the
    // row that agrees with kie's published page to the cent, which is what
    // makes the other two rows of that page worth listing.
    ["seedance-2.5", "720p", 4, false, 252, 1.26],
  ] as const)(
    "%s %s %ds sound=%s bills %d credits",
    (modelId, resolution, durationS, withSound, credits, usd) => {
      const result = quoteClip({ modelId, resolution, durationS, withSound }, NOW);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.quote.credits).toBe(credits);
      expect(result.quote.usd).toBeCloseTo(usd, 4);
      expect(result.quote.provenance).toBe("receipt");
      expect(result.quote.unpaid).toBe(false);
    },
  );

  it("labels a published rate as unpaid rather than passing it off as measured", () => {
    const result = quoteClip(
      { modelId: "seedance-2.5", resolution: "1080p", durationS: 4, withSound: false },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.credits).toBe(632);
    // The whole point. A number from a vendor's page and a number off a
    // receipt must not be indistinguishable on a button that spends.
    expect(result.quote.provenance).toBe("published");
    expect(result.quote.unpaid).toBe(true);
  });

  // The quote this route was built around, and the one the first real render
  // settled: 28 cr/s x 4s = 112 credits, billed to the credit on 2026-09-02.
  it("quotes the 480p clip off a receipt now, not a published figure", () => {
    const result = quoteClip(
      { modelId: "seedance-2.5", resolution: "480p", durationS: 4, withSound: false },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.credits).toBe(112);
    expect(result.quote.usd).toBeCloseTo(0.56, 4);
    expect(result.quote.provenance).toBe("receipt");
    expect(result.quote.unpaid).toBe(false);
  });

  it("flags a lapsed promotion, because the real bill is then HIGHER", () => {
    // No table entry carries a promotion today (seedance-2.5 1080p's lapsed
    // on 2026-09-17 and was replaced by kie's current price), so the rule is
    // pinned on a rate built for it.
    const promo = {
      creditsPerSecond: 114,
      provenance: "published" as const,
      pricedAt: "2026-08-31",
      promotionEndsAt: "2026-09-17",
      note: "test",
    };
    expect(isPromotionExpired(promo, new Date("2026-09-16T00:00:00Z"))).toBe(false);
    expect(isPromotionExpired(promo, new Date("2026-09-18T00:00:00Z"))).toBe(true);
  });
});

describe("quoteClip refuses rather than substituting", () => {
  it.each([
    // 6s and 10s only. The cheapest model per second cannot serve the
    // cheapest workflow, and "unpriced" would be the wrong story.
    ["hailuo-2.3-pro", "768P", 4, false, "unsupported-duration"],
    ["seedance-2-mini", "720p", 4, false, "unpriced"],
    ["kling-3.0-pro", "480p", 4, false, "unsupported-resolution"],
    ["wan-2.5", "720p", 4, false, "unknown-model"],
  ] as const)("%s %s %ds sound=%s -> %s", (modelId, resolution, durationS, withSound, reason) => {
    const result = quoteClip({ modelId, resolution, durationS, withSound }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe(reason);
  });

  it("never answers with another vendor's number", () => {
    // The defect this module exists to remove: lib/models.ts falls back to
    // fal's rate for an unmeasured kie pair, which is how Seedance 1080p came
    // to be quoted at $1.1497/s against kie's real $0.570 and was pulled from
    // the product as too expensive.
    //
    // seedance-2 480p SILENT, not kling-3.0-pro 720p silent as this used to
    // read: Kling's std/720p silent tier got its own receipt on 2026-09-10
    // (14 cr/s — see this table's "kling-3.0-pro".silent["720p"]) and is now
    // genuinely priced, so it stopped being an example of "nobody has paid
    // for this." seedance-2 still has no silent tier at all — "every render
    // this product makes sets generate_audio true", per that entry's own
    // comment — so a silent quote for it is still refused rather than
    // answered from a number measured for a different mode.
    const result = quoteClip(
      { modelId: "seedance-2", resolution: "480p", durationS: 4, withSound: false },
      NOW,
    );
    expect(result.ok).toBe(false);
  });
});

describe("cheapestFor", () => {
  it.each([
    // Gemini Omni 1.2's published 360p rate is 4 credits per second.
    [4, "gemini-omni-1.2", 16],
    [6, "gemini-omni-1.2", 24],
    [10, "gemini-omni-1.2", 40],
  ] as const)(
    "at %ds the cheapest sound-off quote is %s at %d credits",
    (durationS, modelId, credits) => {
      const best = cheapestFor(durationS, false, NOW);
      expect(best?.modelId).toBe(modelId);
      expect(best?.quote.credits).toBe(credits);
    },
  );

  it("beats the route every silent scene used to be forced onto", () => {
    // Seedance 2.5 at 720p — 63 cr/s — is where pickModel sent every
    // non-talking-head scene until 2026-08-31. If the cheapest option ever
    // stops beating it, removing that fallback was the wrong call and this
    // fails before anyone is overcharged.
    const best = cheapestFor(6, false, NOW);
    expect(best!.quote.credits).toBeLessThan(63 * 6);
  });
});

describe("the rate table itself", () => {
  it("prices every resolution each model claims to offer, in at least one audio tier", () => {
    // A model listing a resolution with no rate behind it would show up in a
    // picker and then refuse at quote time — a control that looks live and
    // is not.
    //
    // "IN AT LEAST ONE TIER", not "in the silent tier", since 2026-09-04.
    // This asked only about silence, on the assumption every model can render
    // without sound — which was true of every model in the table when it was
    // written and stopped being true twice over. seedance 2.5's silent entry
    // is an inference copied from its sound receipts, and seedance-2-fast has
    // no silent entry at all because nothing has ever been rendered on it
    // that way. What the picker actually needs is that a listed resolution
    // can be QUOTED, and it is quoted at whichever tier the render will use.
    for (const model of KIE_MODELS) {
      for (const resolution of model.resolutions) {
        const silent = rateFor(model.id, resolution, false);
        const spoken = rateFor(model.id, resolution, true);
        expect(
          silent ?? spoken,
          `${model.label} lists ${resolution} and has no rate for it in either tier, so a picker ` +
            `would offer it and the quote would then refuse`,
        ).not.toBeNull();
      }
    }
  });

  it("gives every rate a date, so a stale one is visible as stale", () => {
    // kie says on its own page that prices are beta. A rate with no pricedAt
    // is a rate nobody can audit.
    for (const [modelId, rates] of Object.entries(KIE_RATES)) {
      for (const table of [rates.silent, rates.sound]) {
        for (const [resolution, rate] of Object.entries(table ?? {})) {
          expect(rate.pricedAt, `${modelId} ${resolution} has no pricedAt`).toMatch(
            /^\d{4}-\d{2}-\d{2}$/,
          );
          expect(rate.creditsPerSecond).toBeGreaterThan(0);
        }
      }
    }
  });

  it("never charges less for sound than for silence except documented equal-price pairs", () => {
    // Seedance 2.5 publishes one price per tier regardless of audio, on kie
    // and on BytePlus (per token, audio included). Kling 4.0 has no sound
    // input and one published price per resolution.
    const MAY_TIE = new Set([
      "seedance-2.5 480p",
      "seedance-2.5 720p",
      "seedance-2.5 1080p",
      "seedance-2.5-byteplus 480p",
      "seedance-2.5-byteplus 720p",
      "seedance-2.5-byteplus 1080p",
      "seedance-2.5-flash-byteplus 480p",
      "seedance-2.5-flash-byteplus 720p",
      "kling-4.0 720p",
      "kling-4.0 1080p",
      "kling-4.0-reference 720p",
      "kling-4.0-reference 1080p",
      "gemini-omni-1.2 360p",
      "gemini-omni-1.2 720p",
      "gemini-omni-1.2 1080p",
      "gemini-omni-1.2 4k",
    ]);

    for (const model of KIE_MODELS) {
      for (const resolution of model.resolutions) {
        const silent = rateFor(model.id, resolution, false);
        const spoken = rateFor(model.id, resolution, true);
        if (!silent || !spoken) continue;

        const pair = `${model.id} ${resolution}`;
        // Sound cheaper than silence is nonsense in every case, allowance or
        // not — that would be the vendor paying us to add audio.
        expect(
          spoken.creditsPerSecond,
          `${pair}: sound is CHEAPER than silence, which kie's pricing cannot produce`,
        ).toBeGreaterThanOrEqual(silent.creditsPerSecond);

        if (!MAY_TIE.has(pair)) {
          expect(
            spoken.creditsPerSecond,
            `${pair}: the two tiers converged. Either the surcharge is gone, or a silent rate was ` +
              `filled in by copying the sound one — if the latter, say so here by name rather than ` +
              `widening the rule`,
          ).toBeGreaterThan(silent.creditsPerSecond);
        }
      }
    }
  });
});
