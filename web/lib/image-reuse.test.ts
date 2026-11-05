import { describe, expect, it } from "vitest";
import { nearestImageAspectRatio } from "./image-reuse";

describe("nearestImageAspectRatio", () => {
  it.each([
    [1024, 1024, "1:1"],
    [1080, 1920, "9:16"],
    [1920, 1080, "16:9"],
    [1344, 768, "16:9"], // a model's near-16:9 size
    [832, 1248, "2:3"],
    [2520, 1080, "21:9"],
  ])("%ix%i is %s", (w, h, expected) => {
    expect(nearestImageAspectRatio(w, h)).toBe(expected);
  });

  it("gives null for an unloaded image", () => {
    expect(nearestImageAspectRatio(0, 0)).toBeNull();
  });
});
