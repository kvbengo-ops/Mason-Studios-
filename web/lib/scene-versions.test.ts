import { describe, expect, it } from "vitest";
import { buildSceneVersions, activeClipIdByScene } from "./scene-versions";

// 0058_scene_versions.sql pairs each version with the clip it produced by
// deriving the link from time — the worker that inserts clips knows nothing
// about versions. But the migration's OWN backfill breaks that pairing: it
// named the clip each pre-existing scene already had directly on the
// version row (clip_asset_id), and it did so at migration time, so the
// version's created_at is NEWER than the clip it names. A pairing that
// trusted the time window alone would put that clip outside every version's
// window and return an empty final cut for every project that existed
// before 0058 — the bug these tests exist to keep dead.

describe("buildSceneVersions", () => {
  it("numbers versions v1, v2, v3 in creation order regardless of input order", () => {
    const versions = [
      {
        id: "v3",
        n: 3,
        created_at: "2026-08-03T00:00:00.000Z",
        video_prompt: "c",
        ref_frame_asset_id: null,
      },
      {
        id: "v1",
        n: 1,
        created_at: "2026-08-01T00:00:00.000Z",
        video_prompt: "a",
        ref_frame_asset_id: null,
      },
      {
        id: "v2",
        n: 2,
        created_at: "2026-08-02T00:00:00.000Z",
        video_prompt: "b",
        ref_frame_asset_id: null,
      },
    ];

    const views = buildSceneVersions(versions, []);

    // Newest first (the picker's own order), but n climbs with age, not
    // with position in the returned array.
    expect(views.map((v) => [v.id, v.n])).toEqual([
      ["v3", 3],
      ["v2", 2],
      ["v1", 1],
    ]);
  });

  it("attaches a clip via the named clip_asset_id even though the clip predates the version — the 0058 backfill shape", () => {
    // Exactly the backfill's own shape: the version row (created by the
    // migration) is newer than the clip it names (rendered long before
    // 0058 existed). A time-window pairing alone would miss this entirely.
    const versions = [
      {
        id: "v1",
        n: 1,
        created_at: "2026-08-20T00:00:00.000Z", // backfilled — after the clip
        video_prompt: "old prompt",
        ref_frame_asset_id: null,
        clip_asset_id: "clip-1",
      },
    ];
    const clips = [{ id: "clip-1", created_at: "2026-01-01T00:00:00.000Z" }]; // long before v1

    const views = buildSceneVersions(versions, clips);

    expect(views).toHaveLength(1);
    expect(views[0]!.clipAssetId).toBe("clip-1");
  });

  it("does NOT let the time-window fallback null out a clip_asset_id pairing (negative control for the rule ordering)", () => {
    // Two versions where the naive time window would attach clip-1 to v2
    // (the newest version at-or-before the clip's time), but v1's own
    // clip_asset_id explicitly claims it. The named pairing must win.
    const versions = [
      {
        id: "v1",
        n: 1,
        created_at: "2026-08-01T00:00:00.000Z",
        video_prompt: "a",
        ref_frame_asset_id: null,
        clip_asset_id: "clip-1",
      },
      {
        id: "v2",
        n: 2,
        created_at: "2026-08-02T00:00:00.000Z",
        video_prompt: "b",
        ref_frame_asset_id: null,
      },
    ];
    // Clip lands after both versions were opened — inside a naive window
    // this would fall to v2 (the last version at-or-before it), not v1.
    const clips = [{ id: "clip-1", created_at: "2026-08-03T00:00:00.000Z" }];

    const views = buildSceneVersions(versions, clips);

    const v1 = views.find((v) => v.id === "v1")!;
    const v2 = views.find((v) => v.id === "v2")!;
    expect(v1.clipAssetId).toBe("clip-1");
    expect(v2.clipAssetId).toBeNull();
  });

  it("falls back to the time window for a clip with no clip_asset_id claim, attaching it to the newest version at or before it", () => {
    const versions = [
      {
        id: "v1",
        n: 1,
        created_at: "2026-08-01T00:00:00.000Z",
        video_prompt: "a",
        ref_frame_asset_id: null,
      },
      {
        id: "v2",
        n: 2,
        created_at: "2026-08-02T00:00:00.000Z",
        video_prompt: "b",
        ref_frame_asset_id: null,
      },
    ];
    const clips = [{ id: "clip-1", created_at: "2026-08-02T12:00:00.000Z" }];

    const views = buildSceneVersions(versions, clips);

    expect(views.find((v) => v.id === "v2")!.clipAssetId).toBe("clip-1");
    expect(views.find((v) => v.id === "v1")!.clipAssetId).toBeNull();
  });

  it("shows the NEWEST clip in a version's window — what 'Update this version' re-renders into", () => {
    // Update re-uses v1, and MarkDone never names the new clip, so v1's window
    // holds the clip it replaced and the one that replaced it. Taking the
    // first kept previewing the old take after the new one had rendered.
    const versions = [
      {
        id: "v1",
        n: 1,
        created_at: "2026-08-01T00:00:00.000Z",
        video_prompt: "a",
        ref_frame_asset_id: null,
      },
    ];
    const clips = [
      { id: "clip-new", created_at: "2026-08-01T02:00:00.000Z" },
      { id: "clip-old", created_at: "2026-08-01T01:00:00.000Z" },
    ];

    const views = buildSceneVersions(versions, clips);

    expect(views[0]!.clipAssetId).toBe("clip-new");
  });

  it("attaches a clip older than every version to the earliest version, not to none", () => {
    const versions = [
      {
        id: "v1",
        n: 1,
        created_at: "2026-08-05T00:00:00.000Z",
        video_prompt: "a",
        ref_frame_asset_id: null,
      },
    ];
    const clips = [{ id: "clip-1", created_at: "2026-01-01T00:00:00.000Z" }];

    const views = buildSceneVersions(versions, clips);

    expect(views[0]!.clipAssetId).toBe("clip-1");
  });

  it("ignores a clip_asset_id that names a clip not present in `clips` — falls through to the window instead of a dangling reference", () => {
    const versions = [
      {
        id: "v1",
        n: 1,
        created_at: "2026-08-01T00:00:00.000Z",
        video_prompt: "a",
        ref_frame_asset_id: null,
        clip_asset_id: "clip-does-not-exist",
      },
    ];

    const views = buildSceneVersions(versions, []);

    expect(views[0]!.clipAssetId).toBeNull();
  });
});

describe("activeClipIdByScene", () => {
  const scenes = [{ id: "scene-1", active_version_id: "v1" }];

  it("picks the active version's clip via clip_asset_id even when it falls outside the time window (the 0058 backfill case)", () => {
    const versions = [
      {
        id: "v1",
        n: 1,
        scene_id: "scene-1",
        created_at: "2026-08-20T00:00:00.000Z", // backfilled, after the clip
        video_prompt: "p",
        ref_frame_asset_id: null,
        clip_asset_id: "clip-1",
      },
    ];
    const clips = [{ id: "clip-1", scene_id: "scene-1", created_at: "2026-01-01T00:00:00.000Z" }];

    const result = activeClipIdByScene(scenes, versions, clips);

    expect(result.get("scene-1")).toBe("clip-1");
  });

  it("does not fall back to 'newest clip' when the active version names a different, valid clip", () => {
    const versions = [
      {
        id: "v1",
        n: 1,
        scene_id: "scene-1",
        created_at: "2026-08-01T00:00:00.000Z",
        video_prompt: "p",
        ref_frame_asset_id: null,
        clip_asset_id: "clip-1",
      },
    ];
    // clip-2 is newer than clip-1 and would win a plain "last one wins"
    // pick, but it belongs to a superseded attempt, not the active one.
    const clips = [
      { id: "clip-1", scene_id: "scene-1", created_at: "2026-08-01T01:00:00.000Z" },
      { id: "clip-2", scene_id: "scene-1", created_at: "2026-08-05T00:00:00.000Z" },
    ];

    const result = activeClipIdByScene(scenes, versions, clips);

    expect(result.get("scene-1")).toBe("clip-1");
  });

  it("falls back to the time window when the active version has no clip_asset_id", () => {
    const versions = [
      {
        id: "v1",
        n: 1,
        scene_id: "scene-1",
        created_at: "2026-08-01T00:00:00.000Z",
        video_prompt: "p",
        ref_frame_asset_id: null,
      },
      {
        id: "v2",
        n: 2,
        scene_id: "scene-1",
        created_at: "2026-08-03T00:00:00.000Z",
        video_prompt: "p2",
        ref_frame_asset_id: null,
      },
    ];
    const clips = [{ id: "clip-1", scene_id: "scene-1", created_at: "2026-08-02T00:00:00.000Z" }];

    // scene-1's active_version_id is "v1" (fixture above); v1's window is
    // [08-01, 08-03) so clip-1 (08-02) falls inside it.
    const result = activeClipIdByScene(scenes, versions, clips);

    expect(result.get("scene-1")).toBe("clip-1");
  });

  it("falls back to the newest clip when the scene has no active version at all (pre-0058 behaviour)", () => {
    const noVersionScenes = [{ id: "scene-1", active_version_id: null }];
    const clips = [
      { id: "clip-1", scene_id: "scene-1", created_at: "2026-08-01T00:00:00.000Z" },
      { id: "clip-2", scene_id: "scene-1", created_at: "2026-08-02T00:00:00.000Z" },
    ];

    const result = activeClipIdByScene(noVersionScenes, [], clips);

    expect(result.get("scene-1")).toBe("clip-2");
  });

  it("leaves a scene with no clips at all out of the map", () => {
    const result = activeClipIdByScene(scenes, [], []);
    expect(result.has("scene-1")).toBe(false);
  });
});
