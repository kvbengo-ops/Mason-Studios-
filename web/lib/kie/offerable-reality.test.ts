// What /ugc can actually sell today, pinned — and the one piece of UI that
// follows from it being unreachable.
//
// offerable() draws a line the rest of the app depends on: a rate that is real
// but UNPAID (provenance "published", nobody has been billed at it) may be
// quoted but not sold. The consequence is easy to miss when reading the code
// from either end — components/ugc-column.tsx carries an `unpaid` flag and
// renders "rate from kie's page — never billed here" in warning colour, which
// reads like a live state and is not. offerable() has already filtered every
// such pair out before the column sees it, so that branch cannot render.
//
// THAT MOMENT ARRIVED. seedance-2.5 480p is now offered on kie's published
// 28 cr/s — deliberately, by name, through ACCEPTED_PUBLISHED_RATES in
// offerable.ts — because it is the tier the editors work in and the block was
// costing them 55% on every clip. So the warning IS live now, and this file's
// job flips: it stops asserting that no published rate is offered, and starts
// asserting that exactly the accepted one is, and that the UI says so.
//
// The guard earned its keep on the way through. Its failure message said the
// warning "has been unreachable until now, so check it actually renders before
// shipping this" — and it did not: the line had been deleted months earlier on
// the correct-at-the-time argument that it could only ever say one thing. An
// unpaid rate would have shipped with no warning at all.

import { describe, expect, it } from "vitest";
import { offerable } from "./offerable";
import { offerRateFor as rateFor } from "./rates";

describe("published prices are sold on /ugc", () => {
  it("sells exactly these published (unmeasured) rates", () => {
    const published: string[] = [];

    for (const withSound of [false, true]) {
      for (const offer of offerable(withSound)) {
        const rate = rateFor(offer.model.id, offer.resolution, withSound);
        expect(
          rate,
          `${offer.model.id} ${offer.resolution} is offered with no rate at all`,
        ).not.toBeNull();
        if (rate?.provenance === "published") {
          published.push(`${offer.model.id} ${offer.resolution} (sound=${withSound})`);
        }
      }
    }

    // A SET, not a count. An unpaid rate slipping into the offered set is the
    // failure this exists to catch, and it has to fail by name — "expected 1
    // to be 0" would not tell anyone which tier appeared, or that
    // components/ugc-column.tsx's warning has to be true of it too.
    //
    // This has been empty, then held one entry, then emptied again — twice
    // now, and the same way both times.
    //
    // ["seedance-2.5 480p (sound=false)"] until 2026-09-02: one 4s render
    // billed 112 credits, exactly the published 28 cr/s.
    //
    // ["seedance-2 480p (sound=true)"] until 2026-09-07: two renders took the
    // balance from 17797.5 to 17674.7, and 122.8 is exactly 76 + 46.8 — 19
    // cr/s for 2.0 and 11.7 for 2.0 Fast, both published figures, both right
    // to the credit.
    //
    // Each time the provenance became a receipt, the acceptance in
    // offerable.ts was deleted as its own comment instructed, and the honest
    // expectation here went back to the empty list. That is the loop working:
    // the exception is meant to be temporary and something has to notice when
    // it stops being needed.
    //
    // Not empty again since 2026-10-25: the three new models, each accepted
    // by name at its cheapest tier until its first measured render. Wan 3.0
    // and Kling 4.0 retired on 2026-10-28 (30s receipts, exact to the credit).
    expect(
      published.sort(),
      "the set of tiers sold on kie's published price changed. A new one is sold on the " +
        "docs alone (offerable.ts's header); confirm that is intended, and that " +
        "ugc-column.tsx's unpaid warning reads correctly for it:\n  " +
        published.join("\n  "),
    ).toEqual(
      // Every published rate is sold since 2026-10-30 (offerable.ts's header),
      // so this pins exactly which tiers are on kie's word alone.
      [
        "gemini-omni-1.2 1080p (sound=false)",
        "gemini-omni-1.2 1080p (sound=true)",
        "gemini-omni-1.2 360p (sound=false)",
        "gemini-omni-1.2 360p (sound=true)",
        "gemini-omni-1.2 4k (sound=false)",
        "gemini-omni-1.2 4k (sound=true)",
        "gemini-omni-1.2 720p (sound=false)",
        "gemini-omni-1.2 720p (sound=true)",
        "gemini-omni-video 1080p (sound=false)",
        "gemini-omni-video 1080p (sound=true)",
        "gemini-omni-video 4k (sound=false)",
        "gemini-omni-video 4k (sound=true)",
        "kling-4.0 1080p (sound=false)",
        "kling-4.0 1080p (sound=true)",
        "kling-4.0-reference 1080p (sound=false)",
        "kling-4.0-reference 1080p (sound=true)",
        "seedance-2 1080p (sound=true)",
        "seedance-2 720p (sound=true)",
        "seedance-2-fast 720p (sound=true)",
        "seedance-2-mini 480p (sound=true)",
        "seedance-2-mini 720p (sound=true)",
        "seedance-2.5 1080p (sound=false)",
        "seedance-2.5 1080p (sound=true)",
        "seedance-2.5 720p (sound=true)",
        // BytePlus ModelArk's published per-token price, 2026-11-06; no receipt yet.
        "seedance-2.5-byteplus 1080p (sound=false)",
        "seedance-2.5-byteplus 1080p (sound=true)",
        "seedance-2.5-byteplus 480p (sound=false)",
        "seedance-2.5-byteplus 480p (sound=true)",
        "seedance-2.5-byteplus 720p (sound=false)",
        "seedance-2.5-byteplus 720p (sound=true)",
        "wan-3.0 1080P (sound=true)",
        "wan-3.0 720P (sound=true)",
      ],
    );
  });

  it("offers exactly these pairs", () => {
    // Pinned as a set rather than a count, so retiring an unpaid tier (one
    // measured render flips its provenance to "receipt" with no code change)
    // shows up here as a named addition rather than a number nobody reads.
    //
    // Published rates are sold by owner decision; this pins the full offered set.
    const offered = [false, true].flatMap((withSound) =>
      offerable(withSound).map((o) => `${o.model.id} ${o.resolution} sound=${withSound}`),
    );

    // SIX SINCE 2026-09-04, and the new one is the pair production has been
    // rendering all along. seedance 480p sound=true was missing not because
    // nobody had paid for it but because all six of its receipts were filed
    // under sound=false, so rateFor -- which has no fallback by design --
    // answered nothing every time the worker asked. Four consecutive
    // production renders were submitted with estimated_cost_usd=unknown
    // before anyone read the log.
    expect(offered.sort()).toEqual(
      [
        "gemini-omni-1.2 360p sound=false",
        "gemini-omni-1.2 360p sound=true",
        "gemini-omni-1.2 720p sound=false",
        "gemini-omni-1.2 720p sound=true",
        "gemini-omni-1.2 1080p sound=false",
        "gemini-omni-1.2 1080p sound=true",
        "gemini-omni-1.2 4k sound=false",
        "gemini-omni-1.2 4k sound=true",
        // Receipt 2026-09-14: 63 credits for 4s. One price schedule and native
        // audio (no switch in kie's payload), so sound mode shares it.
        "gemini-omni-video 720p sound=false",
        "gemini-omni-video 720p sound=true",
        "hailuo-2.3-pro 768P sound=false",
        "kling-3.0-pro 1080p sound=false",
        "kling-3.0-pro 1080p sound=true",
        // NINTH AND TENTH, 2026-09-10: kie's std mode, the receipts that let
        // /ugc offer Kling at a cheaper tier than pro/1080p (20 cr/s against
        // 27 with sound) and that let the scripted wizard's B-roll
        // (non-talking-head) scenes price a std/720p Kling project at all
        // (14 cr/s silent, rather than +Infinity with no rate on file).
        "kling-3.0-pro 720p sound=false",
        "kling-3.0-pro 720p sound=true",
        "seedance-2.5 480p sound=false",
        "seedance-2.5 480p sound=true",
        "seedance-2.5 720p sound=false",
        // SEVENTH SINCE 2026-09-04. seedance-2-fast 480p was measured at
        // 11.7 cr/s -- 175.5 credits for one 15s render with audio on -- and
        // /ugc is now pinned to it: the same 4s 480p clip for $0.234 instead
        // of $0.56. Its 720p tier and both seedance-2 tiers are still
        // published-only, so they are correctly absent from this list.
        "seedance-2-fast 480p sound=true",
        // Accepted by name in ACCEPTED_PUBLISHED_RATES so /ugc's model picker
        // can offer it beside 2.5 and 2.0 Fast without a measuring render
        // first. One measured render retires the acceptance.
        "seedance-2 480p sound=true",
        // Accepted by name 2026-10-25, published rates, no receipt yet.
        "seedance-2-mini 480p sound=true",
        "wan-3.0 480P sound=true",
        "kling-4.0 720p sound=false",
        "kling-4.0 720p sound=true",
        "kling-4.0-reference 720p sound=false",
        "kling-4.0-reference 720p sound=true",
        // Published rates, sold on kie's documentation since 2026-10-30.
        "gemini-omni-video 1080p sound=false",
        "gemini-omni-video 1080p sound=true",
        "gemini-omni-video 4k sound=false",
        "gemini-omni-video 4k sound=true",
        "kling-4.0 1080p sound=false",
        "kling-4.0 1080p sound=true",
        "kling-4.0-reference 1080p sound=false",
        "kling-4.0-reference 1080p sound=true",
        "seedance-2 1080p sound=true",
        "seedance-2 720p sound=true",
        "seedance-2.5 1080p sound=false",
        "seedance-2.5 720p sound=true",
        "seedance-2.5 1080p sound=true",
        "seedance-2-fast 720p sound=true",
        "seedance-2-mini 720p sound=true",
        "wan-3.0 1080P sound=true",
        "wan-3.0 720P sound=true",
        // BytePlus ModelArk's published per-token price, 2026-11-06.
        "seedance-2.5-byteplus 480p sound=false",
        "seedance-2.5-byteplus 480p sound=true",
        "seedance-2.5-byteplus 720p sound=false",
        "seedance-2.5-byteplus 720p sound=true",
        "seedance-2.5-byteplus 1080p sound=false",
        "seedance-2.5-byteplus 1080p sound=true",
      ].sort(),
    );
  });

  it("offers 480p on its receipt, and 1080p on kie's current published price", () => {
    // 480p is the tier the competitor's editors actually run, and it is
    // CHEAPER per second than the 720p this route used to default to — 28
    // against 63, $0.56 against $1.26 for a 4-second clip. It was held back by
    // one thing: nobody had rendered at it and read the credit balance either
    // side. Somebody has now — 112 credits for a 4s clip, the published rate
    // to the credit — so it is offered on a receipt rather than on an
    // accepted risk, and the acceptance it needed has been deleted.
    //
    // 1080p was held back while its stored price was a promotion that lapsed
    // on 2026-09-17. It now carries kie's current 158 cr/s (rates.ts), so it
    // is sold like any other published rate.
    const offered = offerable(false).map((o) => `${o.model.id} ${o.resolution}`);
    expect(offered).toContain("seedance-2.5 480p");
    expect(offered).toContain("seedance-2.5 1080p");
  });
});

describe("the default this route lands on is not its cheapest option", () => {
  it("defaults to the first offer, which costs more per second than two others", () => {
    // app/(app)/ugc/[id]/page.tsx takes options[0] as the default. Worth
    // stating out loud rather than leaving in the ordering of a list: the
    // default is the most expensive pair on offer, and Hailuo is a seventh of
    // its per-second rate.
    const offers = offerable(false);
    const first = offers[0];
    // Thrown rather than expect()ed: an assertion does not narrow the type,
    // and tsc rejects passing Offer | undefined to rateOf below.
    if (!first) throw new Error("nothing is offered at all");

    const rateOf = (o: (typeof offers)[number]) =>
      rateFor(o.model.id, o.resolution, false)?.creditsPerSecond ?? 0;

    const cheapest = offers.reduce((a, b) => (rateOf(a) <= rateOf(b) ? a : b));
    expect(
      rateOf(first),
      "the default is no longer the priciest offer — if that was deliberate, delete this test; it exists to make the ordering a decision rather than an accident",
    ).toBeGreaterThan(rateOf(cheapest));
  });
});
