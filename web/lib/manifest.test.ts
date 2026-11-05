import { describe, expect, it } from "vitest";
import { buildManifest, filenameForClip } from "./manifest";

// Deliberately self-consistent with the 1-based filename convention:
// `idx` is the raw 0-based column, so idx 0 is scene-01.mp4 and idx 1 is
// scene-02.mp4 — exactly what filenameForClip produces. A fixture that
// disagrees with the convention would let a regression in either direction
// pass unnoticed.
const fixtureScenes = [
  {
    idx: 1,
    script_line: "Second line.",
    video_prompt: "wide shot of product on table",
    is_talking_head: false,
    duration_s: 4,
    filename: "scene-02.mp4",
    signed_url: "https://example.com/scene-02.mp4?sig=b",
  },
  {
    idx: 0,
    script_line: "First line.",
    video_prompt: "closeup of actor speaking",
    is_talking_head: true,
    duration_s: 6,
    filename: "scene-01.mp4",
    signed_url: "https://example.com/scene-01.mp4?sig=a",
  },
];

describe("buildManifest", () => {
  it("carries project-level fields through", () => {
    const manifest = buildManifest({
      projectTitle: "Summer Launch",
      characterDescription: "mid-30s woman, brown hair, casual",
      scenes: [],
    });

    expect(manifest.project_title).toBe("Summer Launch");
    expect(manifest.character_description).toBe("mid-30s woman, brown hair, casual");
    expect(manifest.scenes).toEqual([]);
  });

  it("allows a null character description", () => {
    const manifest = buildManifest({
      projectTitle: "Summer Launch",
      characterDescription: null,
      scenes: [],
    });

    expect(manifest.character_description).toBeNull();
  });

  it("sorts scenes by idx regardless of input order", () => {
    const manifest = buildManifest({
      projectTitle: "Summer Launch",
      characterDescription: null,
      scenes: fixtureScenes,
    });

    expect(manifest.scenes.map((scene) => scene.idx)).toEqual([0, 1]);
  });

  it("carries every field through per scene, unmodified", () => {
    const manifest = buildManifest({
      projectTitle: "Summer Launch",
      characterDescription: null,
      scenes: fixtureScenes,
    });

    expect(manifest.scenes[0]).toEqual({
      // scene_number is derived, not carried: it is idx + 1, and it must
      // always agree with `filename`. A human reads this file, and "scene 1"
      // has to mean scene-01.mp4 to them.
      scene_number: 1,
      idx: 0,
      script_line: "First line.",
      video_prompt: "closeup of actor speaking",
      is_talking_head: true,
      duration_s: 6,
      filename: "scene-01.mp4",
      signed_url: "https://example.com/scene-01.mp4?sig=a",
    });
  });

  it("does not mutate the input array", () => {
    const copy = [...fixtureScenes];
    buildManifest({ projectTitle: "x", characterDescription: null, scenes: fixtureScenes });
    expect(fixtureScenes).toEqual(copy);
  });
});

describe("filenameForClip", () => {
  // scenes.idx is 0-based (same as every other call site in this codebase),
  // but every screen shows the operator idx + 1 (scene-table.tsx,
  // frame-grid.tsx, render-progress.tsx). The filename must match that, not
  // the raw column — the first scene on screen ("Scene 1") is scene-01.mp4,
  // not scene-00.mp4, or "re-render scene 4" hands an editor scene-03.mp4.
  it("numbers the first scene (idx 0) as scene-01, not scene-00", () => {
    expect(filenameForClip(0, "projects/p/clip/uuid.mp4")).toBe("scene-01.mp4");
  });

  it("numbers a later scene one above its 0-based idx", () => {
    expect(filenameForClip(3, "projects/p/clip/uuid.mp4")).toBe("scene-04.mp4");
  });

  // Zero-padding must be computed from the 1-based number, not the raw idx
  // — idx 8 is the 9th scene (single digit, "09"), and idx 9 is the 10th
  // (double digit, "10"); getting the padding from idx instead would put
  // scene-10 (an idx-9 scene misnumbered) ahead of scene-09 in a sorted file
  // browser instead of after it.
  it("zero-pads the 1-based number so double digits sort correctly", () => {
    expect(filenameForClip(8, "projects/p/clip/uuid.mp4")).toBe("scene-09.mp4");
    expect(filenameForClip(9, "projects/p/clip/uuid.mp4")).toBe("scene-10.mp4");
  });

  it("takes the extension from the storage key", () => {
    expect(filenameForClip(0, "projects/p/clip/uuid.mov")).toBe("scene-01.mov");
  });

  it("falls back to mp4 when the storage key has no extension", () => {
    expect(filenameForClip(0, "projects/p/clip/uuid")).toBe("scene-01.mp4");
  });
});
