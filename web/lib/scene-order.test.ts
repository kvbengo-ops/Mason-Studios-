import { describe, expect, it } from "vitest";
import { insertAfter, removeSceneId, repackIds } from "./scene-order";

describe("repackIds", () => {
  it("assigns contiguous 0-based indices preserving order", () => {
    expect(repackIds(["a", "b", "c"])).toEqual([
      { id: "a", idx: 0 },
      { id: "b", idx: 1 },
      { id: "c", idx: 2 },
    ]);
  });

  it("handles an empty list", () => {
    expect(repackIds([])).toEqual([]);
  });

  it("closes a gap left by a prior removal", () => {
    // e.g. ["a", "c"] after "b" (idx 1) was deleted from ["a", "b", "c"]
    expect(repackIds(["a", "c"])).toEqual([
      { id: "a", idx: 0 },
      { id: "c", idx: 1 },
    ]);
  });
});

describe("removeSceneId", () => {
  it("removes the target id and leaves order intact", () => {
    expect(removeSceneId(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("is a no-op when the id is not present", () => {
    expect(removeSceneId(["a", "b"], "z")).toEqual(["a", "b"]);
  });

  it("removing every id yields an empty list", () => {
    expect(removeSceneId(["a"], "a")).toEqual([]);
  });
});

describe("insertAfter", () => {
  it("inserts after the given position", () => {
    expect(insertAfter(["a", "b", "c"], 0, "x")).toEqual(["a", "x", "b", "c"]);
    expect(insertAfter(["a", "b", "c"], 1, "x")).toEqual(["a", "b", "x", "c"]);
  });

  it("inserts at the start when afterIdx is null", () => {
    expect(insertAfter(["a", "b"], null, "x")).toEqual(["x", "a", "b"]);
  });

  it("appends at the end when afterIdx is the last index", () => {
    expect(insertAfter(["a", "b", "c"], 2, "x")).toEqual(["a", "b", "c", "x"]);
  });

  it("clamps a negative afterIdx to the start", () => {
    expect(insertAfter(["a", "b"], -1, "x")).toEqual(["x", "a", "b"]);
  });

  it("clamps an out-of-range afterIdx to the end", () => {
    expect(insertAfter(["a", "b"], 99, "x")).toEqual(["a", "b", "x"]);
  });

  it("inserting into an empty list yields a single-item list", () => {
    expect(insertAfter([], null, "x")).toEqual(["x"]);
  });

  it("composes with repackIds to produce final positions", () => {
    const withInsert = insertAfter(["a", "b"], 0, "x");
    expect(repackIds(withInsert)).toEqual([
      { id: "a", idx: 0 },
      { id: "x", idx: 1 },
      { id: "b", idx: 2 },
    ]);
  });
});
