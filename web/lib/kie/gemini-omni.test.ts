import { describe, expect, it } from "vitest";
import { quoteClip } from "./cost";
import { geminiOmniCredits, geminiOmniVideoInputPaid, offerRateFor } from "./rates";
import { offerable } from "./offerable";
import { KIE_MODELS } from "./models";
import { VIDEO_MODELS } from "@/lib/models";
import { ugcTierLabel } from "@/lib/ugc-tier-label";
import { clipCostUsd, getModel, isModelAvailableForSelection, priceForSecond } from "@/lib/models";

describe("Gemini Omni Video's non-linear published prices", () => {
  it.each([
    ["720p", 4, 63],
    ["720p", 6, 84],
    ["720p", 8, 105],
    ["720p", 10, 126],
    ["1080p", 4, 63],
    ["1080p", 6, 84],
    ["1080p", 8, 105],
    ["1080p", 10, 126],
    ["4k", 4, 147],
    ["4k", 6, 168],
    ["4k", 8, 189],
    ["4k", 10, 210],
  ])("quotes %s %ss as %s credits", (resolution, durationS, credits) => {
    expect(geminiOmniCredits(resolution, durationS, false)).toBe(credits);
  });

  it("uses fixed video-input pricing regardless of requested duration", () => {
    expect(geminiOmniCredits("720p", 4, true)).toBe(168);
    expect(geminiOmniCredits("720p", 10, true)).toBe(168);
    expect(geminiOmniCredits("4k", 4, true)).toBe(252);
  });

  it("refuses durations and resolutions outside the published table", () => {
    expect(geminiOmniCredits("720p", 5, false)).toBeNull();
    expect(geminiOmniCredits("480p", 4, false)).toBeNull();
  });

  it("prices Gemini at its one schedule when the global sound setting is on", () => {
    expect(offerRateFor("gemini-omni-video", "720p", true)?.provenance).toBe("receipt");
    const quote = quoteClip(
      { modelId: "gemini-omni-video", resolution: "720p", durationS: 4, withSound: true },
      new Date("2026-09-14T00:00:00Z"),
    );
    expect(quote.ok && quote.quote.credits).toBe(63);
    expect(quote.ok && quote.quote.note).not.toMatch(/silent/i);
  });

  it("offers Gemini 720p on its receipt, video input still gated", () => {
    expect(offerable(false).some((offer) => offer.model.id === "gemini-omni-video")).toBe(true);
    expect(offerable(true).some((offer) => offer.model.id === "gemini-omni-video")).toBe(true);
    expect(isModelAvailableForSelection("gemini-omni-video", "720p")).toBe(true);
    expect(geminiOmniVideoInputPaid("720p")).toBe(false);
  });

  it("keeps Gemini in the UGC registry, not the generic scripted registry", () => {
    expect(KIE_MODELS.some((model) => model.id === "gemini-omni-video")).toBe(true);
    expect(VIDEO_MODELS.some((model) => model.id === "gemini-omni-video")).toBe(false);
  });

  it("does not reshape its exact schedule into credits per second", () => {
    const quoted = quoteClip(
      { modelId: "gemini-omni-video", resolution: "720p", durationS: 6, withSound: false },
      new Date("2026-09-14T00:00:00Z"),
    );
    expect(quoted.ok && quoted.quote.credits).toBe(84);
    expect(quoted.ok && quoted.quote.creditsPerSecond).toBeNull();
    expect(quoted.ok && quoted.quote.unpaid).toBe(false);
  });

  it("refuses generic per-second pricing rather than returning a Gemini gate marker", () => {
    expect(priceForSecond(getModel("gemini-omni-video"), "720p")).toBe(Number.POSITIVE_INFINITY);
  });

  it("shows 480p but preserves Gemini's actual 720p value", () => {
    expect(ugcTierLabel("gemini-omni-video", "720p")).toBe("480p");
  });

  it("uses the same fixed video price in the spend-cap resolver", () => {
    const model = getModel("gemini-omni-video");
    expect(
      clipCostUsd(model, { resolution: "720p", durationS: 10, referenceVideoInputSecondsS: 4 }),
    ).toBeCloseTo(168 / 200, 6);
    expect(
      clipCostUsd(model, {
        resolution: "720p",
        durationS: 10,
        referenceVideoInputSecondsS: Number.POSITIVE_INFINITY,
      }),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});
