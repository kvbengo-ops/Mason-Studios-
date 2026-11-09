// The draft that survives leaving /image-generator (0088).
//
// Two things are pinned here, and the second is a money rule rather than a
// convenience one:
//
//   1. Navigation does not lose what the operator typed.
//   2. A signed preview URL is NEVER written to storage. Those expire, so a
//      restored one is a preview that works until it silently does not — and
//      the durable record of a finished beat is its ATTEMPT, whose stable key
//      returns the same picture with a fresh URL and no second charge.
//
// The round-trip test is what actually enforces (2): it serializes a beat that
// carries an image and proves the stored string does not contain it.
import { describe, expect, it } from "vitest";
import { parseImageDraft, serializeImageDraft, type ImageDraft } from "./image-draft";

const MODELS = ["nano-banana", "seedream-5.0-pro"];
const isSelectable = (id: string): boolean => MODELS.includes(id);

const DRAFT: ImageDraft = {
  prompt: "a red ceramic mug on white",
  modelId: "seedream-5.0-pro",
  aspectRatio: "1:1",
  imageCount: 4,
};

describe("image draft round trip", () => {
  it("restores everything the operator had entered", () => {
    expect(parseImageDraft(serializeImageDraft(DRAFT), isSelectable)).toEqual(DRAFT);
  });

  it("restores the selected batch size", () => {
    expect(parseImageDraft(serializeImageDraft(DRAFT), isSelectable).imageCount).toBe(4);
  });

  it("never writes a signed image URL to storage", () => {
    // Serializing named fields keeps runtime image data out of localStorage.
    const withImage = {
      ...DRAFT,
      image: { assetId: "asset-1", url: "https://storage.example/signed?token=secret" },
    } as unknown as ImageDraft;

    const stored = serializeImageDraft(withImage);
    expect(stored).not.toContain("signed?token=secret");
    expect(stored).not.toContain("storage.example");
    expect(JSON.parse(stored)).toEqual(DRAFT);
  });
});

describe("parseImageDraft", () => {
  it("treats an absent draft as no draft", () => {
    expect(parseImageDraft(null, isSelectable)).toEqual({});
  });

  it("treats an unreadable draft as no draft rather than an error", () => {
    // Whatever else is in this browser's storage under a stale key is not the
    // operator's problem to clear before they can work.
    expect(parseImageDraft("{not json", isSelectable)).toEqual({});
    expect(parseImageDraft("null", isSelectable)).toEqual({});
    expect(parseImageDraft('"a string"', isSelectable)).toEqual({});
  });

  it("drops a model this deployment no longer offers", () => {
    // A stored id can outlive the table that named it. Restoring it would leave
    // the form submitting a model the picker cannot display.
    const stored = JSON.stringify({ prompt: "hello", modelId: "retired-model" });
    const restored = parseImageDraft(stored, isSelectable);
    expect(restored.prompt).toBe("hello");
    expect(restored.modelId).toBeUndefined();
  });

  it("drops Nano Banana 2, which the picker no longer offers", () => {
    const stored = JSON.stringify({ modelId: "nano-banana-2" });
    expect(parseImageDraft(stored, isSelectable).modelId).toBeUndefined();
  });

  it.each(["7:3", "4:5", "21:9"])("drops an aspect ratio the picker does not offer: %s", (aspectRatio) => {
    const stored = JSON.stringify({ aspectRatio });
    expect(parseImageDraft(stored, isSelectable).aspectRatio).toBeUndefined();
  });

  it.each([0, 5, 1.5, "2"])("drops an invalid batch size: %s", (imageCount) => {
    const stored = JSON.stringify({ imageCount });
    expect(parseImageDraft(stored, isSelectable).imageCount).toBeUndefined();
  });
});
