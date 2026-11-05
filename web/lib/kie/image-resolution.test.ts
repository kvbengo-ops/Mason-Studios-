import { describe, expect, it } from "vitest";
import { IMAGE_MODELS, imageCostUsd } from "@/lib/models";
import { SEEDREAM_PRO_TEXT_ID } from "./seedream-image";
import { GPT_IMAGE_2_5_IDS } from "./gpt-image-2-5";
import { NANO_BANANA_2_ID, kieImageInput } from "./image-input";

const input = (model: string, resolution?: "1K" | "2K" | "4K") =>
  kieImageInput(model, "a fox", "1:1", [], resolution);

describe("the image resolution tier on kie's payload", () => {
  it("leaves the nano-banana 2 request untouched at 1K — the receipts were taken without it", () => {
    expect(input(NANO_BANANA_2_ID)).toEqual({ prompt: "a fox", aspect_ratio: "1:1" });
    expect(input(NANO_BANANA_2_ID, "1K")).toEqual({ prompt: "a fox", aspect_ratio: "1:1" });
  });

  it("sends `resolution` above 1K on nano-banana 2", () => {
    expect(input(NANO_BANANA_2_ID, "4K")).toMatchObject({ resolution: "4K" });
  });

  it("sends GPT Image 2.5's tier as `resolution`", () => {
    expect(input(GPT_IMAGE_2_5_IDS.flare.text)).toMatchObject({ resolution: "1K" });
    expect(input(GPT_IMAGE_2_5_IDS.sunburst.text, "2K")).toMatchObject({ resolution: "2K" });
  });

  it("maps Seedream's tiers onto `quality`, and has no 4K", () => {
    expect(input(SEEDREAM_PRO_TEXT_ID, "1K")).toMatchObject({ quality: "basic" });
    expect(input(SEEDREAM_PRO_TEXT_ID, "2K")).toMatchObject({ quality: "high" });
    expect(() => input(SEEDREAM_PRO_TEXT_ID, "4K")).toThrow(/4K/);
  });

  it("refuses a tier on a model kie documents none for, since kie would drop it and still bill", () => {
    expect(() => input("google/nano-banana", "2K")).toThrow(/resolution/);
  });
});

describe("what a tier costs", () => {
  const nb2 = IMAGE_MODELS.find((m) => m.id === "nano-banana-2")!;

  it("is the model's measured price at 1K", () => {
    expect(imageCostUsd(nb2)).toBe(nb2.costUsd);
    expect(imageCostUsd(nb2, "1K")).toBe(nb2.costUsd);
  });

  it("is kie's published price above 1K, and null where none is recorded", () => {
    for (const model of IMAGE_MODELS) {
      for (const tier of model.resolutions ?? []) {
        if (tier === "1K") continue;
        expect(imageCostUsd(model, tier)).toBe(model.resolutionCostsUsd?.[tier] ?? null);
      }
    }
    // kie.ai/nano-banana-2's card: 18 credits at 4K.
    expect(imageCostUsd(nb2, "4K")).toBe(0.09);
  });

  it("is null for a tier the model does not offer", () => {
    const plain = IMAGE_MODELS.find((m) => m.id === "nano-banana")!;
    expect(imageCostUsd(plain, "2K")).toBeNull();
  });
});
