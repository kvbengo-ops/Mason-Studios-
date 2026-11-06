import { describe, expect, it } from "vitest";
import { providerLabel, runPreviewSource, sceneTimeKey } from "./accounts-control";

describe("runPreviewSource", () => {
  const images = new Map([["asset-1", "img/a.png"]]);
  const clips = new Map([
    [sceneTimeKey("scene-1", "2026-11-06T10:00:00.123456+00:00"), "clips/a.mp4"],
  ]);

  it("shows an image run's own picture", () => {
    expect(
      runPreviewSource({ asset_id: "asset-1", scene_id: null, created_at: "x" }, images, clips),
    ).toEqual({ kind: "image", storageKey: "img/a.png" });
  });

  it("matches a video run to the clip written in the same transaction", () => {
    expect(
      runPreviewSource(
        { asset_id: null, scene_id: "scene-1", created_at: "2026-11-06T10:00:00.123456+00:00" },
        images,
        clips,
      ),
    ).toEqual({ kind: "video", storageKey: "clips/a.mp4" });
  });

  it("does not borrow another take's clip from the same scene", () => {
    expect(
      runPreviewSource(
        { asset_id: null, scene_id: "scene-1", created_at: "2026-11-06T11:00:00+00:00" },
        images,
        clips,
      ),
    ).toBeNull();
  });
});

describe("providerLabel", () => {
  it("names BytePlus properly and leaves kie as is", () => {
    expect(providerLabel("byteplus")).toBe("BytePlus");
    expect(providerLabel("kie")).toBe("kie");
  });
});
