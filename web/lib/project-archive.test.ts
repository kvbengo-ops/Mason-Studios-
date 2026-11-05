import { describe, expect, it } from "vitest";
import { buildProjectAssetEntries } from "./project-archive";

describe("buildProjectAssetEntries", () => {
  it("sorts assets and places their IDs before a sanitized storage basename", () => {
    expect(
      buildProjectAssetEntries([
        { id: "b", kind: "ref_frame", storageKey: "p\\frames\\start frame.png" },
        { id: "a", kind: "clip", storageKey: "p/clip/scene.mp4" },
      ]),
    ).toEqual([
      { name: "assets/clip/a-scene.mp4", storageKey: "p/clip/scene.mp4" },
      { name: "assets/ref_frame/b-start frame.png", storageKey: "p\\frames\\start frame.png" },
    ]);
  });
});
