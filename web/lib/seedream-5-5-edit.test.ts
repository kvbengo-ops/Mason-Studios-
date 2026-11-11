import { describe, expect, it } from "vitest";
import { IMAGE_MODELS, imageCostUsd } from "@/lib/models";
import { kieImageInput, SEEDREAM_5_5_EDIT_ID } from "@/lib/kie/image-input";

const seedream55 = IMAGE_MODELS.find((model) => model.id === "seedream-5.5")!;

describe("Seedream 5.5 · Kie reference edits", () => {
  it("offers edits through seedream/5-5-image-to-image", () => {
    expect(seedream55.editId).toBe(SEEDREAM_5_5_EDIT_ID);
    expect(seedream55.referenceDisabledReason).toBeUndefined();
  });

  it("adds $0.0072 per input image to the output price (kie's own example: 2K + 1 input = 7.74 cr)", () => {
    expect(imageCostUsd(seedream55, "1K")).toBeCloseTo(0.018, 10);
    expect(imageCostUsd(seedream55, "2K", 1)).toBeCloseTo(7.74 / 200, 10);
    expect(imageCostUsd(seedream55, "1.5K", 3)).toBeCloseTo(0.018 + 3 * 0.0072, 10);
  });

  it("leaves models with no input charge unchanged by references", () => {
    const other = IMAGE_MODELS.find((model) => model.inputImageCostUsd === undefined && model.costUsd !== null)!;
    expect(imageCostUsd(other, "1K", 4)).toBe(other.costUsd);
  });

  it("sends references in image_urls with the size tier", () => {
    expect(kieImageInput(SEEDREAM_5_5_EDIT_ID, "edit it", "16:9", ["https://x/a.png"], "2K")).toEqual({
      prompt: "edit it",
      image_urls: ["https://x/a.png"],
      aspect_ratio: "16:9",
      size: "2K",
    });
  });
});
