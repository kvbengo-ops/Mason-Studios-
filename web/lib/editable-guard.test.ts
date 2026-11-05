import { describe, expect, it } from "vitest";
import {
  EDITABLE_STATUSES,
  assertLockedOrderPreserved,
  isEditable,
  isSceneInFlight,
} from "./editable-guard";
import type { SceneStatus } from "@/types/db";

// Every SceneStatus the enum defines (types/db.ts), so a new status added
// there without a decision here fails this test instead of silently
// falling through to whichever branch happens to match.
const ALL_STATUSES: readonly SceneStatus[] = [
  "draft",
  "frame_ready",
  "queued",
  "rendering",
  "done",
  "failed",
];

describe("isEditable", () => {
  it("allows draft and frame_ready", () => {
    expect(isEditable("draft")).toBe(true);
    expect(isEditable("frame_ready")).toBe(true);
  });

  it("refuses every status past frame_ready", () => {
    expect(isEditable("queued")).toBe(false);
    expect(isEditable("rendering")).toBe(false);
    expect(isEditable("done")).toBe(false);
    expect(isEditable("failed")).toBe(false);
  });

  it("agrees with EDITABLE_STATUSES for every status in the enum", () => {
    for (const status of ALL_STATUSES) {
      expect(isEditable(status)).toBe(EDITABLE_STATUSES.includes(status));
    }
  });
});

describe("isSceneInFlight", () => {
  // The narrow concurrency-only predicate actions/render-settings.ts uses —
  // deliberately NOT the same set as isEditable's complement. 'done' and
  // 'failed' have nothing in flight for the worker to disturb, even though
  // neither is "editable" either.
  it("is true only for 'queued'/'rendering'", () => {
    expect(isSceneInFlight("queued")).toBe(true);
    expect(isSceneInFlight("rendering")).toBe(true);
  });

  it("is false for every other status, including 'done'/'failed'", () => {
    expect(isSceneInFlight("draft")).toBe(false);
    expect(isSceneInFlight("frame_ready")).toBe(false);
    expect(isSceneInFlight("done")).toBe(false);
    expect(isSceneInFlight("failed")).toBe(false);
  });

  it("agrees with EDITABLE_STATUSES for every status in the enum: never true where isEditable is true", () => {
    for (const status of ALL_STATUSES) {
      if (isEditable(status)) {
        expect(isSceneInFlight(status)).toBe(false);
      }
    }
  });
});

describe("assertLockedOrderPreserved", () => {
  // The per-scene editability rule this guard exists to enforce for
  // reorderScenes specifically: a test render must not lock the whole
  // brief, but it must lock what "scene 1" (or whichever scene rendered)
  // means in the final assembly.
  const existing = [
    { id: "a", status: "done" as SceneStatus },
    { id: "b", status: "draft" as SceneStatus },
    { id: "c", status: "frame_ready" as SceneStatus },
  ];

  it("allows pre-render scenes to be freely reordered around a locked one", () => {
    // "c" and "b" swap; "a" (done) stays first — its relative position vs.
    // itself is trivially unchanged since there's only one locked scene.
    expect(() => assertLockedOrderPreserved(existing, ["a", "c", "b"])).not.toThrow();
  });

  it("allows a locked scene to shift index as scenes around it move, as long as locked-vs-locked order holds", () => {
    const twoLocked = [
      { id: "a", status: "done" as SceneStatus },
      { id: "b", status: "draft" as SceneStatus },
      { id: "c", status: "queued" as SceneStatus },
    ];
    // b (pre-render) moves to the front; a and c (both locked) keep their
    // relative order — a still before c.
    expect(() => assertLockedOrderPreserved(twoLocked, ["b", "a", "c"])).not.toThrow();
  });

  it("refuses a reorder that changes two locked scenes' order relative to each other", () => {
    const twoLocked = [
      { id: "a", status: "done" as SceneStatus },
      { id: "b", status: "draft" as SceneStatus },
      { id: "c", status: "queued" as SceneStatus },
    ];
    // a and c (both locked) swap — this is the case that would silently
    // change what "scene 1" means in the assembled video without
    // re-rendering anything.
    expect(() => assertLockedOrderPreserved(twoLocked, ["c", "b", "a"])).toThrow(
      /already rendered/i,
    );
  });

  it("allows any reorder when nothing has rendered yet", () => {
    const allPreRender = [
      { id: "a", status: "draft" as SceneStatus },
      { id: "b", status: "frame_ready" as SceneStatus },
    ];
    expect(() => assertLockedOrderPreserved(allPreRender, ["b", "a"])).not.toThrow();
  });
});
