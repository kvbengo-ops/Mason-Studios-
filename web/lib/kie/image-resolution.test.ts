import { describe, expect, it } from "vitest";
import { IMAGE_MODELS, imageCostUsd } from "@/lib/models";
import {
  GPT_IMAGE_2_6_ECONOMY_EDIT,
  GPT_IMAGE_2_6_ECONOMY_TEXT,
  GPT_IMAGE_2_6_SUNBURST_EDIT,
  GPT_IMAGE_2_6_SUNBURST_TEXT,
  NANO_BANANA_2_ID,
  kieImageInput,
} from "./image-input";

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

  it("sends GPT Image 2.6 Sunburst the same 1K shape as Economy", () => {
    expect(input(GPT_IMAGE_2_6_SUNBURST_TEXT)).toEqual({ prompt: "a fox", aspect_ratio: "1:1" });
    expect(
      kieImageInput(GPT_IMAGE_2_6_SUNBURST_EDIT, "edit", "9:16", ["https://example.com/a.png"]),
    ).toEqual({ prompt: "edit", aspect_ratio: "9:16", input_urls: ["https://example.com/a.png"] });
    expect(() => input(GPT_IMAGE_2_6_SUNBURST_TEXT, "2K")).toThrow(/1K only/);
  });

  it("sends GPT Image 2.6 Economy's documented 1K shape and refuses other tiers", () => {
    expect(input(GPT_IMAGE_2_6_ECONOMY_TEXT)).toEqual({ prompt: "a fox", aspect_ratio: "1:1" });
    expect(
      kieImageInput(GPT_IMAGE_2_6_ECONOMY_EDIT, "edit", "9:16", ["https://example.com/a.png"]),
    ).toEqual({ prompt: "edit", aspect_ratio: "9:16", input_urls: ["https://example.com/a.png"] });
    expect(() => input(GPT_IMAGE_2_6_ECONOMY_TEXT, "2K")).toThrow(/1K only/);
    expect(() =>
      kieImageInput(GPT_IMAGE_2_6_ECONOMY_TEXT, "edit", "9:16", ["https://example.com/a.png"]),
    ).toThrow(/image-to-image/);
  });

  it("refuses a tier on a model kie documents none for, since kie would drop it and still bill", () => {
    expect(() => input("google/nano-banana", "2K")).toThrow(/resolution/);
  });
});

describe("what a tier costs", () => {
  const nb2 = IMAGE_MODELS.find((m) => m.id === "nano-banana-2-1")!;

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
    // kie.ai/nano-banana-2-1's card: 9 credits at 4K.
    expect(imageCostUsd(nb2, "4K")).toBe(0.045);
  });

  it("is null for a tier the model does not offer", () => {
    // No remaining model lacks tiers, so strip them from one to model "offers none".
    const plain = { ...IMAGE_MODELS[0]!, resolutions: undefined, resolutionCostsUsd: undefined };
    expect(imageCostUsd(plain, "2K")).toBeNull();
  });
});
