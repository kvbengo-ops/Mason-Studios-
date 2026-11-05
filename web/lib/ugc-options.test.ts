// Pins the rule that replaced "resolution === 480p" and then
// "resolution === defaultResolution": each model enters the picker at its
// CHEAPEST offerable tier under the given sound setting, not a fixed
// resolution. Kling is the case that tells the two rules apart — with sound
// on it now enters at std/720p (20 cr/s), cheaper than its own
// defaultResolution pro/1080p (27) — so `cheapestResolutionFor` below is
// typed by hand against the real rate table, not derived from ugcOptions'
// own implementation, and a mutation reverting the rule to defaultResolution
// must fail against it.

import { describe, expect, it } from "vitest";
import { ugcOptions } from "./ugc-options";

describe("ugcOptions(true) — the sound picker", () => {
  const options = ugcOptions(true);

  it("returns every sound-priced pair, in model and tier order", () => {
    expect(options.map((o) => `${o.modelId}/${o.resolution}`)).toEqual([
      "seedance-2.5/480p",
      "seedance-2.5/720p",
      "seedance-2.5/1080p",
      "seedance-2/480p",
      "seedance-2/720p",
      "seedance-2/1080p",
      "seedance-2-fast/480p",
      "seedance-2-fast/720p",
      "seedance-2-mini/480p",
      "seedance-2-mini/720p",
      "kling-3.0-pro/720p",
      "kling-3.0-pro/1080p",
      "kling-4.0/720p",
      "kling-4.0/1080p",
      "kling-4.0-reference/720p",
      "kling-4.0-reference/1080p",
      "wan-3.0/480P",
      "wan-3.0/720P",
      "wan-3.0/1080P",
      "gemini-omni-video/720p",
      "gemini-omni-video/1080p",
      "gemini-omni-video/4k",
    ]);
  });

  it("prices videoCreditsPerSecond off videoRateFor, null where no video receipt exists", () => {
    // Each model's first (cheapest) tier: the one the bar opens on.
    const firsts = options.filter((o, i) => options.findIndex((x) => x.modelId === o.modelId) === i);
    const bySecond = Object.fromEntries(firsts.map((o) => [o.modelId, o.videoCreditsPerSecond]));
    expect(bySecond).toEqual({
      "seedance-2.5": 17,
      "seedance-2": null,
      "seedance-2-fast": null,
      "seedance-2-mini": null,
      "kling-3.0-pro": null,
      "kling-4.0": null,
      "kling-4.0-reference": null,
      "wan-3.0": null,
      "gemini-omni-video": null,
    });
  });

  it("prices Kling at its cheaper std/720p receipt, not pro/1080p, over its full duration range, and sellable", () => {
    const kling = options.find((o) => o.modelId === "kling-3.0-pro");
    expect(kling).toBeTruthy();
    expect(kling!.label).toBe("Kling 3.0");
    expect(kling!.resolution).toBe("720p");
    expect(kling!.creditsPerSecond).toBe(20);
    expect(kling!.durationsS).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(kling!.unpaid).toBe(false);
  });

  it("never offers Hailuo — it has no sound rate at all", () => {
    expect(options.some((o) => o.modelId === "hailuo-2.3-pro")).toBe(false);
  });

  it("offers Kling Reference at its 720p receipt and its published 1080p, warning on the latter", () => {
    const reference = options.filter((o) => o.modelId === "kling-4.0-reference");
    expect(reference.map((o) => [o.resolution, o.creditsPerSecond, o.unpaid])).toEqual([
      ["720p", 28.5, false],
      ["1080p", 42.5, true],
    ]);
    expect(reference.every((o) => o.nativeAudio === false)).toBe(true);
  });

  it("flags Kling nativeAudio true, and carries BOTH its sound and silent rates regardless of this route's own withSound", () => {
    // The column's Sound On/Off control (ugc-column.tsx) has to be able to
    // quote either rate for Kling, whichever way this option's own
    // creditsPerSecond was built — see UgcOption.soundCreditsPerSecond's own
    // comment for why that has to be a second, separate number.
    const kling = options.find((o) => o.modelId === "kling-3.0-pro")!;
    expect(kling.nativeAudio).toBe(true);
    expect(kling.soundCreditsPerSecond).toBe(20);
    expect(kling.silentCreditsPerSecond).toBe(14);
  });

  it("flags every Seedance/Hailuo nativeAudio false, with no sound/silent rate to read", () => {
    for (const option of options) {
      if (option.modelId === "kling-3.0-pro" || option.modelId === "kling-4.0") continue;
      expect(option.nativeAudio, `${option.modelId} should not be nativeAudio`).toBe(false);
    }
  });

  it("sells published Seedance 2.5 tiers and marks them unpaid", () => {
    expect(
      options
        .filter((o) => o.modelId === "seedance-2.5" && o.resolution !== "480p")
        .map((o) => [o.resolution, o.creditsPerSecond, o.unpaid]),
    ).toEqual([
      ["720p", 63, true],
      ["1080p", 158, true],
    ]);
  });

  it("each model starts at its cheapest offerable tier", () => {
    // cheapestResolutionFor is a hardcoded switch, deliberately — see its own
    // comment below. It still asserts the RULE (each model's cheapest tier,
    // not a fixed resolution) rather than merely pinning today's resolutions
    // a second time, because it is typed by hand against what each model's
    // rate table IS, not read back from ugcOptions' own implementation. A
    // mutation reverting the cheapest-tier rule to defaultResolution moves
    // Kling to 1080p here while this switch still says 720p, so this test
    // goes red.
    for (const o of options.filter(
      (candidate, i) => options.findIndex((other) => other.modelId === candidate.modelId) === i,
    )) {
      expect(o.resolution).toBe(cheapestResolutionFor(o.modelId, true));
    }
  });
});

describe("ugcOptions(false) — the silent picker", () => {
  const options = ugcOptions(false);

  it("prices the Kling option (if present) at its cheaper silent std/720p receipt, not pro/1080p", () => {
    // std/720p (14 cr/s) undercuts pro/1080p (18) silent too, as of the
    // 2026-09-10 silent receipt that let the scripted wizard's B-roll
    // scenes price a std/720p Kling project at all.
    const kling = options.find((o) => o.modelId === "kling-3.0-pro");
    expect(kling).toBeTruthy();
    expect(kling!.resolution).toBe("720p");
    expect(kling!.creditsPerSecond).toBe(14);
  });

  // The silent route also has measured receipts for seedance-2.5 at 480p
  // (28 cr/s) and 720p (63 cr/s), so the cheapest-tier assertion below checks
  // tier selection against receipts as well as the published sound rates.
  it("returns every silent-priced pair, in model and tier order", () => {
    expect(options.map((o) => `${o.modelId}/${o.resolution}/${o.creditsPerSecond}`)).toEqual([
      "seedance-2.5/480p/28",
      "seedance-2.5/720p/63",
      "seedance-2.5/1080p/158",
      "kling-3.0-pro/720p/14",
      "kling-3.0-pro/1080p/18",
      "kling-4.0/720p/28.5",
      "kling-4.0/1080p/42.5",
      "kling-4.0-reference/720p/28.5",
      "kling-4.0-reference/1080p/42.5",
      "hailuo-2.3-pro/768P/9",
      "gemini-omni-video/720p/15.75",
      "gemini-omni-video/1080p/15.75",
      "gemini-omni-video/4k/36.75",
    ]);
  });

  it("offers seedance-2.5 at 720p because its silent price has a receipt", () => {
    expect(options.some((o) => o.modelId === "seedance-2.5" && o.resolution === "720p")).toBe(
      true,
    );
  });

  it("each model starts at its cheapest offerable tier", () => {
    for (const o of options.filter(
      (candidate, i) => options.findIndex((other) => other.modelId === candidate.modelId) === i,
    )) {
      expect(o.resolution).toBe(cheapestResolutionFor(o.modelId, false));
    }
  });
});

// Small local lookup rather than importing KIE_MODELS/KIE_RATES directly —
// keeps this file honest about testing ugcOptions' OUTPUT (what the
// implementation returns) rather than re-reading lib/kie/rates.ts (what the
// implementation itself reads) for the answer. Hardcoded on purpose, per
// (id, withSound) pair, below — the cheapest tier each model's real rate
// table gives today, read off lib/kie/rates.ts by hand.
function cheapestResolutionFor(modelId: string, _withSound: boolean): string {
  switch (modelId) {
    case "seedance-2.5":
    case "seedance-2":
    case "seedance-2-fast":
    case "seedance-2-mini":
      return "480p";
    case "wan-3.0":
      return "480P";
    case "kling-4.0":
    case "kling-4.0-reference":
      return "720p";
    case "kling-3.0-pro":
      // std/720p undercuts pro/1080p both ways since the 2026-09-10 silent
      // receipt: 20 against 27 with sound, 14 against 18 without — so the
      // answer no longer depends on _withSound at all.
      return "720p";
    case "hailuo-2.3-pro":
      return "768P";
    case "gemini-omni-video":
      return "720p";
    default:
      throw new Error(`no known cheapest resolution for ${modelId}`);
  }
}
