import { describe, expect, it } from "vitest";
import { MAX_REFERENCES, maxReferencesFor, referenceLimitsFor } from "./ugc-references";

describe("reference limits", () => {
  it("gives Seedance 2.5 on BOTH routes 12 references: up to 12 images, 1 video, 3 voices", () => {
    for (const id of ["seedance-2.5", "seedance-2.5-byteplus"]) {
      expect(referenceLimitsFor(id), id).toMatchObject({
        image: 12,
        video: 1,
        audio: 3,
        total: 12,
        videoSeconds: 30,
        audioSeconds: 30,
      });
      expect(maxReferencesFor(id), id).toBe(12);
    }
  });

  it("gives Wan 3.0 kie's 10 images, 5 videos, 5 audio at 15 s", () => {
    expect(referenceLimitsFor("wan-3.0")).toEqual({
      image: 10,
      video: 5,
      audio: 5,
      total: 10,
      videoSeconds: 15,
      audioSeconds: 15,
    });
  });

  it("keeps the original ten for every other model's box, Kling included", () => {
    for (const id of [
      "wan-3.0",
      "gemini-omni-video",
      "seedance-2-mini",
      "kling-4.0",
      "kling-4.0-reference",
    ]) {
      expect(maxReferencesFor(id), id).toBe(MAX_REFERENCES);
    }
  });
});
