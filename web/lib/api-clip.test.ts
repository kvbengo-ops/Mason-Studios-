import { describe, expect, it } from "vitest";
import { apiClipQuote, parseApiClipInput } from "./api-clip";
import { referenceLimitsFor } from "./ugc-references";

const base = {
  prompt: "A cinematic scene",
  model_id: "seedance-2.5-byteplus",
  resolution: "480p",
  duration_s: 4,
};

describe("API clip input", () => {
  it("uses the shared 20,000 character prompt cap", () => {
    expect(parseApiClipInput({ ...base, prompt: "x".repeat(20_000) })).toMatchObject({
      prompt: "x".repeat(20_000),
    });
    expect(parseApiClipInput({ ...base, prompt: "x".repeat(20_001) })).toMatchObject({
      ok: false,
      status: 422,
      code: "prompt_too_long",
    });
  });

  it("accepts Kie Seedance as its own model and limits BytePlus to 480p", () => {
    // Kie Seedance 2.5 is an ordinary choice again (owner, 2026-11-09), at its own tiers.
    expect(
      parseApiClipInput({ ...base, model_id: "seedance-2.5", resolution: "720p" }),
    ).toMatchObject({ modelId: "seedance-2.5", resolution: "720p" });
    expect(parseApiClipInput({ ...base, resolution: "720p" })).toMatchObject({
      ok: false,
      code: "unsupported_resolution",
    });
  });

  it("stores the default ratio and sound decision and refuses silent Seedance", () => {
    expect(parseApiClipInput(base)).toMatchObject({ aspectRatio: "9:16", isTalkingHead: false });
    expect(
      parseApiClipInput({ ...base, model_id: "kling-3.0-pro", resolution: "720p", duration_s: 4 }),
    ).toMatchObject({ isTalkingHead: true });
    expect(parseApiClipInput({ ...base, sound: false })).toMatchObject({
      ok: false,
      code: "unsupported_sound",
    });
  });

  it("sets model-specific reference limits", () => {
    expect(referenceLimitsFor("seedance-2.5-byteplus")).toMatchObject({
      image: 8,
      video: 1,
      audio: 3,
      total: 12,
    });
    expect(referenceLimitsFor("kling-4.0")).toMatchObject({
      image: 2,
      video: 0,
      audio: 0,
      total: 2,
    });
    expect(referenceLimitsFor("gemini-omni-1.2")).toMatchObject({
      image: 6,
      video: 0,
      audio: 0,
      total: 6,
    });
  });

  it("does not expose internal pricing notes", () => {
    const quote = apiClipQuote({
      input: { modelId: "seedance-2.5-byteplus", resolution: "480p", durationS: 4 },
      quote: {
        usd: 0.1,
        provenance: "published",
        unpaid: true,
        stale: false,
        pricedAt: "2026-11-09",
        note: "internal task id",
      },
      estimatedCostUsd: 0.1,
      references: { videoReferenceDurationsS: [] },
    } as never);
    expect(quote).not.toHaveProperty("note");
  });
});
