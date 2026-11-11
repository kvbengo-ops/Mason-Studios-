import { describe, expect, it } from "vitest";
import {
  BIN_RETENTION_MS,
  binExpiryLabel,
  extractArchivedStorageKeys,
  isBinEntryExpired,
  pickSceneClipSource,
  pickSceneThumbnailSource,
  versionClipThumbnailSource,
} from "./bin-thumbnails";

describe("pickSceneThumbnailSource", () => {
  it("returns null when the archived assets array is empty", () => {
    expect(pickSceneThumbnailSource([])).toBeNull();
  });

  it("returns null when assetsJson is not an array (defends the Array.isArray guard)", () => {
    expect(pickSceneThumbnailSource(null)).toBeNull();
    expect(pickSceneThumbnailSource(undefined)).toBeNull();
  });

  it("prefers the poster over a ref_frame when both are present", () => {
    const result = pickSceneThumbnailSource([
      { kind: "ref_frame", storage_key: "ref-1" },
      { kind: "poster", storage_key: "poster-1" },
    ]);
    expect(result).toEqual({ kind: "image", storageKey: "poster-1" });
  });

  it("falls back to the ref_frame when there is no poster", () => {
    const result = pickSceneThumbnailSource([
      { kind: "character_ref", storage_key: "char-1" },
      { kind: "ref_frame", storage_key: "ref-1" },
    ]);
    expect(result).toEqual({ kind: "image", storageKey: "ref-1" });
  });

  // Any other image-kind asset wins when neither the poster nor the
  // ref_frame is present — each of the four remaining IMAGE_ASSET_KINDS
  // entries reaches this branch on its own.
  it.each([
    ["character_ref", "char-1"],
    ["product_ref", "product-1"],
    ["composite_ref", "composite-1"],
    ["generated_image", "generated-1"],
  ])("falls back to a bare %s when there is no poster or ref_frame", (kind, storageKey) => {
    const result = pickSceneThumbnailSource([{ kind, storage_key: storageKey }]);
    expect(result).toEqual({ kind: "image", storageKey });
  });

  it("falls back to the clip, tagged video, only when no image of any kind exists", () => {
    const result = pickSceneThumbnailSource([{ kind: "clip", storage_key: "clip-1" }]);
    expect(result).toEqual({ kind: "video", storageKey: "clip-1" });
  });

  it("still prefers any image kind over a clip when both are present", () => {
    const result = pickSceneThumbnailSource([
      { kind: "clip", storage_key: "clip-1" },
      { kind: "character_ref", storage_key: "char-1" },
    ]);
    expect(result).toEqual({ kind: "image", storageKey: "char-1" });
  });

  it("returns null when the only assets present are kinds outside every branch (e.g. audio)", () => {
    expect(pickSceneThumbnailSource([{ kind: "audio", storage_key: "audio-1" }])).toBeNull();
  });

  // The shadowing case, and the reason `usable()` is applied INSIDE each
  // find predicate rather than after one. A row matching on `kind` but
  // carrying no storage_key is not merely unrenderable — left unchecked it
  // stops `find` dead and hides a perfectly good fallback standing behind
  // it in the same array. The cost is not a missing picture, it is a missing
  // picture that did not have to be missing.
  it("skips a keyless poster and falls back to the usable ref_frame behind it", () => {
    const result = pickSceneThumbnailSource([
      { kind: "poster" }, // no storage_key
      { kind: "ref_frame", storage_key: "ref-1" },
    ]);
    expect(result).toEqual({ kind: "image", storageKey: "ref-1" });
  });

  it("returns null when every candidate row is missing its storage_key", () => {
    expect(pickSceneThumbnailSource([{ kind: "poster" }, { kind: "clip" }])).toBeNull();
  });

  it("treats an empty-string storage_key as unusable, not as a key", () => {
    const result = pickSceneThumbnailSource([
      { kind: "poster", storage_key: "" },
      { kind: "ref_frame", storage_key: "ref-1" },
    ]);
    expect(result).toEqual({ kind: "image", storageKey: "ref-1" });
  });
});

describe("versionClipThumbnailSource", () => {
  it("returns the clip tagged video", () => {
    const result = versionClipThumbnailSource({ kind: "clip", storage_key: "clip-1" });
    expect(result).toEqual({ kind: "video", storageKey: "clip-1" });
  });

  it("returns null for a null clip_asset", () => {
    expect(versionClipThumbnailSource(null)).toBeNull();
  });

  // Same rule as the scene picker, simpler here because there is only one
  // candidate and so nothing to shadow — but a source with no key would
  // still send `undefined` into signedUrl, so it is null instead.
  it("returns null for a clip_asset missing its storage_key", () => {
    expect(versionClipThumbnailSource({ kind: "clip" })).toBeNull();
  });
});

describe("pickSceneClipSource", () => {
  it("returns null when no clip asset is present", () => {
    expect(pickSceneClipSource([{ kind: "poster", storage_key: "poster-1" }])).toBeNull();
    expect(pickSceneClipSource(null)).toBeNull();
  });

  it("returns the clip and pairs it with the poster when both exist", () => {
    expect(
      pickSceneClipSource([
        { kind: "ref_frame", storage_key: "ref-1" },
        { kind: "poster", storage_key: "poster-1" },
        { kind: "clip", storage_key: "clip-1" },
      ]),
    ).toEqual({ clipStorageKey: "clip-1", posterStorageKey: "poster-1" });
  });

  it("falls back to ref_frame as the poster when no poster exists", () => {
    expect(
      pickSceneClipSource([
        { kind: "ref_frame", storage_key: "ref-1" },
        { kind: "clip", storage_key: "clip-1" },
      ]),
    ).toEqual({ clipStorageKey: "clip-1", posterStorageKey: "ref-1" });
  });

  it("returns null posterStorageKey when only a clip exists", () => {
    expect(pickSceneClipSource([{ kind: "clip", storage_key: "clip-1" }])).toEqual({
      clipStorageKey: "clip-1",
      posterStorageKey: null,
    });
  });
});

describe("extractArchivedStorageKeys", () => {
  it("collects unique non-empty storage keys from scene assets and version clip_asset", () => {
    expect(
      extractArchivedStorageKeys(
        [
          { kind: "poster", storage_key: "poster-1" },
          { kind: "clip", storage_key: "clip-1" },
          { kind: "clip", storage_key: "" },
        ],
        { kind: "clip", storage_key: "clip-1" },
      ),
    ).toEqual(["poster-1", "clip-1"]);
  });
});

describe("isBinEntryExpired and binExpiryLabel", () => {
  it("marks entries at or past 3 days as expired", () => {
    const now = Date.parse("2026-10-31T00:00:00.000Z");
    const exactCutoff = new Date(now - BIN_RETENTION_MS).toISOString();
    const recent = new Date(now - BIN_RETENTION_MS + 1000).toISOString();
    expect(isBinEntryExpired(exactCutoff, now)).toBe(true);
    expect(isBinEntryExpired(recent, now)).toBe(false);
    expect(binExpiryLabel(recent, now)).toBe("1d left in bin");
  });
});
