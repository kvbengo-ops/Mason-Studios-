// GPT Image 2.5 carries references in `input_urls` — not image_urls, not
// image_input. kie drops an unknown field and bills anyway, so the key is
// pinned here, along with the two refusals in front of it.
import { describe, expect, it } from "vitest";
import { GPT_IMAGE_2_5_IDS, gptImage25Input } from "./gpt-image-2-5";
import { kieImageInput } from "./image-input";

const REF = "https://signed.example/previous.png";

describe("gptImage25Input", () => {
  it("sends references as input_urls on the image-to-image id", () => {
    expect(kieImageInput(GPT_IMAGE_2_5_IDS.sunburst.edit, "a mug", "9:16", [REF])).toEqual({
      prompt: "a mug",
      aspect_ratio: "9:16",
      resolution: "1K",
      input_urls: [REF],
    });
  });

  it("refuses references on the text-to-image id, which would ignore them", () => {
    expect(() => gptImage25Input(GPT_IMAGE_2_5_IDS.flare.text, "a mug", "9:16", [REF])).toThrow(
      "GPT Image 2.5 references require the image-to-image endpoint.",
    );
  });

  it("refuses 4:5, which kie does not document for this model", () => {
    expect(() => gptImage25Input(GPT_IMAGE_2_5_IDS.flare.text, "a mug", "4:5")).toThrow(
      "GPT Image 2.5 does not support this aspect ratio.",
    );
  });
});
