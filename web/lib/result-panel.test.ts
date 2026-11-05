import { describe, expect, it } from "vitest";
import { resultPanelState, workingVersionId } from "./result-panel";

// The regression this file exists for, stated plainly: v2 is rendering, the
// operator presses "Make current" on v1 to get back to a take that worked, and
// the canvas must show v1's clip — not a spinner about v2.
describe("resultPanelState", () => {
  it("plays a version that has a clip while a newer one renders", () => {
    const state = resultPanelState({ hasClip: true, hasVersion: true, status: "rendering" });

    expect(state.kind).toBe("clip");
    // ...and the render in flight is still announced, or the page goes silent
    // on the operator watching it.
    expect(state).toMatchObject({ renderInFlight: true, queued: false });
  });

  it("says queued rather than rendering when that is what it is", () => {
    expect(resultPanelState({ hasClip: true, hasVersion: true, status: "queued" })).toMatchObject({
      kind: "clip",
      renderInFlight: true,
      queued: true,
    });
  });

  it("shows no in-flight note once the scene is done", () => {
    expect(resultPanelState({ hasClip: true, hasVersion: true, status: "done" })).toMatchObject({
      kind: "clip",
      renderInFlight: false,
    });
  });

  // The spinner still has to appear for the version actually being worked on —
  // the fix must not have traded one wrong state for another.
  it("spins for a version with no clip while the worker holds it", () => {
    expect(resultPanelState({ hasClip: false, hasVersion: true, status: "rendering" })).toEqual({
      kind: "working",
      queued: false,
    });
    expect(resultPanelState({ hasClip: false, hasVersion: true, status: "queued" })).toEqual({
      kind: "working",
      queued: true,
    });
  });

  it("reports a finished attempt that produced nothing as failed", () => {
    expect(resultPanelState({ hasClip: false, hasVersion: true, status: "failed" })).toEqual({
      kind: "failed",
    });
  });

  it("is empty before there is any attempt to show", () => {
    expect(resultPanelState({ hasClip: false, hasVersion: false, status: null })).toEqual({
      kind: "empty",
    });
  });

  // A scene queued for its FIRST render has no version yet — that is a spinner,
  // not the empty "the clip lands here" state.
  it("spins on a first render before any version exists", () => {
    expect(resultPanelState({ hasClip: false, hasVersion: false, status: "queued" })).toEqual({
      kind: "working",
      queued: true,
    });
  });
});

describe("workingVersionId", () => {
  const V = [
    { id: "a", n: 1, clipAssetId: "clip-1" },
    { id: "b", n: 2, clipAssetId: null },
  ];

  it("names the newest attempt while the worker holds the scene", () => {
    expect(workingVersionId(V, "rendering")).toBe("b");
    expect(workingVersionId(V, "queued")).toBe("b");
  });

  it("names nobody once the scene is finished", () => {
    expect(workingVersionId(V, "done")).toBeNull();
    expect(workingVersionId(V, "failed")).toBeNull();
    expect(workingVersionId(V, null)).toBeNull();
  });

  // The status row and the version rows are two reads. A callback landing
  // between them leaves a scene still marked rendering whose newest version
  // already has its clip — and calling that finished take "rendering" would be
  // a fresh lie in place of the one this function exists to remove.
  it("refuses to guess when the newest attempt already has a clip", () => {
    expect(workingVersionId([{ id: "a", n: 1, clipAssetId: "clip-1" }], "rendering")).toBeNull();
  });

  it("reads newest by version number, not by array order", () => {
    expect(
      workingVersionId(
        [
          { id: "b", n: 2, clipAssetId: null },
          { id: "a", n: 1, clipAssetId: "clip-1" },
        ],
        "rendering",
      ),
    ).toBe("b");
  });

  it("names nobody when there are no versions at all", () => {
    expect(workingVersionId([], "queued")).toBeNull();
  });
});
