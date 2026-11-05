// The three refusals in seedreamProInput, none of which had a test.
//
// They are the whole safety story for this endpoint: the payload it builds
// goes straight to a paid vendor call, and each guard exists because the
// vendor's failure mode for that mistake is worse than a refusal. A wrong
// aspect_ratio is a 422 the operator pays nothing for but learns nothing
// from; references sent to the text-to-image endpoint are IGNORED (lib/kie.ts
// documents this), which bills a full generation for an image that used none
// of them and says so nowhere.
//
// Deleting any of the three `throw`s below must fail this file. That is the
// point of it — a guard nothing pins is a guard that can be tidied away by
// someone who reads it as defensive noise.
import { describe, expect, it } from "vitest";
import {
  SEEDREAM_PRO_ASPECT_RATIOS,
  SEEDREAM_PRO_EDIT_ID,
  SEEDREAM_PRO_TEXT_ID,
  seedreamProInput,
} from "./seedream-image";

const REF = "https://signed.example/previous.png";

describe("seedreamProInput refuses what the vendor would take money for", () => {
  it("rejects a ratio this model does not offer, even though it is a real one", () => {
    // 4:5 is a genuine ImageAspectRatio and both Nano Banana models accept it.
    // It is absent from SEEDREAM_PRO_ASPECT_RATIOS, so this is the case that
    // passes every type-level check and can only be caught here — a test that
    // fed it garbage would miss exactly this.
    expect(SEEDREAM_PRO_ASPECT_RATIOS).not.toContain("4:5");
    expect(() => seedreamProInput(SEEDREAM_PRO_TEXT_ID, "a mug", "4:5")).toThrow(
      "Seedream 5.0 Pro does not support this aspect ratio.",
    );
  });

  it("rejects an endpoint it does not know", () => {
    expect(() => seedreamProInput("seedream/5-pro-video", "a mug", "9:16")).toThrow(
      "Unknown Seedream 5.0 Pro endpoint.",
    );
  });

  it("rejects references sent to the text-to-image endpoint", () => {
    // The expensive one. kie ignores image_urls on a text-to-image call rather
    // than refusing it, so without this the operator is billed in full for a
    // picture their references never touched.
    expect(() => seedreamProInput(SEEDREAM_PRO_TEXT_ID, "a mug", "9:16", [REF])).toThrow(
      "Seedream 5.0 Pro references require the image-to-image endpoint.",
    );
  });

  it("rejects the image-to-image endpoint with nothing to edit", () => {
    // The other half of the same XOR, and the half easily lost if anyone
    // rewrites the condition as a one-directional check.
    expect(() => seedreamProInput(SEEDREAM_PRO_EDIT_ID, "a mug", "9:16", [])).toThrow(
      "Seedream 5.0 Pro references require the image-to-image endpoint.",
    );
  });
});

describe("seedreamProInput builds the payload the receipts were measured at", () => {
  it("pins the priced tier, because the picker quotes that price", () => {
    // quality/output_format are fixed deliberately: docs/seedream-pro-
    // integration.md's $0.035 is a receipt for basic/1K, and a change here
    // silently makes the quoted figure wrong rather than failing.
    expect(seedreamProInput(SEEDREAM_PRO_TEXT_ID, "a red ceramic mug", "16:9")).toEqual({
      prompt: "a red ceramic mug",
      aspect_ratio: "16:9",
      quality: "basic",
      output_format: "png",
    });
  });

  it("omits image_urls entirely rather than sending an empty array", () => {
    expect(seedreamProInput(SEEDREAM_PRO_TEXT_ID, "a mug", "9:16")).not.toHaveProperty(
      "image_urls",
    );
  });

  it("carries references through on the endpoint that can use them", () => {
    expect(seedreamProInput(SEEDREAM_PRO_EDIT_ID, "a mug", "1:1", [REF])).toEqual({
      prompt: "a mug",
      aspect_ratio: "1:1",
      quality: "basic",
      output_format: "png",
      image_urls: [REF],
    });
  });

  it("accepts every ratio the model advertises", () => {
    // Guards against the list and the check drifting apart — an entry added to
    // SEEDREAM_PRO_ASPECT_RATIOS that the function then rejects.
    for (const ratio of SEEDREAM_PRO_ASPECT_RATIOS) {
      expect(() => seedreamProInput(SEEDREAM_PRO_TEXT_ID, "a mug", ratio)).not.toThrow();
    }
  });
});
