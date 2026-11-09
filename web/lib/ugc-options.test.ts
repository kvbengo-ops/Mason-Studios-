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
      "seedance-2.5-byteplus/480p",
      "kling-4.0/720p",
      "kling-4.0-reference/720p",
      "wan-3.0/480P",
      "wan-3.0/720P",
      "gemini-omni-video/360p",
      "gemini-omni-video/720p",
      "gemini-omni-1.2/360p",
      "gemini-omni-1.2/720p",
    ]);
  });

  it("prices videoCreditsPerSecond off videoRateFor, null where no video receipt exists", () => {
    // Each model's first (cheapest) tier: the one the bar opens on.
    const firsts = options.filter(
      (o, i) => options.findIndex((x) => x.modelId === o.modelId) === i,
    );
    const bySecond = Object.fromEntries(firsts.map((o) => [o.modelId, o.videoCreditsPerSecond]));
    expect(bySecond).toEqual({
      "seedance-2.5": 17,
      "seedance-2.5-byteplus": 12.2976,
      "kling-4.0": null,
      "kling-4.0-reference": null,
      "wan-3.0": null,
      "gemini-omni-video": null,
      "gemini-omni-1.2": null,
    });
  });

  it("never shows a hidden model, even one offerable() still prices", () => {
    for (const id of ["seedance-2", "kling-3.0-pro", "hailuo-2.3-pro"]) {
      expect(
        options.some((o) => o.modelId === id),
        id,
      ).toBe(false);
    }
  });

  it("labels Kie Seedance as Kie, and offers BytePlus Seedance at 480p only", () => {
    expect(options[0]?.label).toBe("Seedance 2.5 · Kie");
    expect(
      options.filter((o) => o.modelId === "seedance-2.5-byteplus").map((o) => o.resolution),
    ).toEqual(["480p"]);
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

  it("flags every Seedance/Hailuo nativeAudio false, with no sound/silent rate to read", () => {
    for (const option of options) {
      if (option.modelId === "kling-3.0-pro" || option.modelId === "kling-4.0") continue;
      expect(option.nativeAudio, `${option.modelId} should not be nativeAudio`).toBe(false);
    }
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

describe("ugcOptions — role access and the prompt cap", () => {
  it("hides Wan 3.0 from a Hybrid Editor and shows it to an AI Animator or any other role", () => {
    const ids = (role: Parameters<typeof ugcOptions>[1]): string[] =>
      ugcOptions(true, role).map((o) => o.modelId);
    expect(ids("hybrid_editor")).not.toContain("wan-3.0");
    expect(ids("hybrid_editor")).toContain("kling-4.0");
    expect(ids("ai_animator")).toContain("wan-3.0");
    expect(ids("editor")).toContain("wan-3.0");
  });

  it("carries the lower of the vendor cap and the 20,000 character cap", () => {
    const byId = (id: string): number | undefined =>
      ugcOptions(true).find((o) => o.modelId === id)?.maxPromptChars;
    expect(byId("seedance-2.5-byteplus")).toBe(20_000);
    expect(byId("kling-4.0")).toBeLessThanOrEqual(20_000);
  });
});

describe("ugcOptions(false) — the silent picker", () => {
  const options = ugcOptions(false);

  it("returns every silent-priced pair, in model and tier order", () => {
    expect(options.map((o) => `${o.modelId}/${o.resolution}/${o.creditsPerSecond}`)).toEqual([
      "seedance-2.5/480p/28",
      "seedance-2.5-byteplus/480p/20.56005",
      "kling-4.0/720p/28.5",
      "kling-4.0-reference/720p/28.5",
      "gemini-omni-video/360p/15.75",
      "gemini-omni-video/720p/15.75",
      "gemini-omni-1.2/360p/4",
      "gemini-omni-1.2/720p/9",
    ]);
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
    case "seedance-2.5-byteplus":
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
      return "360p";
    case "gemini-omni-1.2":
      return "360p";
    default:
      throw new Error(`no known cheapest resolution for ${modelId}`);
  }
}
