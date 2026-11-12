import { describe, expect, it } from "vitest";
import { compareSceneOrder, reassignPositions } from "./scene-position";

const scenes = [
  { id: "a", idx: 1, position: null },
  { id: "b", idx: 2, position: null },
  { id: "c", idx: 5, position: null },
];

describe("scene order", () => {
  it("orders by position, falling back to idx", () => {
    const rows = [
      { id: "x", idx: 1, position: 9 },
      { id: "y", idx: 2, position: null },
      { id: "z", idx: 3, position: 2 },
    ];
    expect([...rows].sort(compareSceneOrder).map((r) => r.id)).toEqual(["y", "z", "x"]);
  });

  it("reuses the scenes' own keys so the new order reads back", () => {
    const next = reassignPositions(scenes, ["c", "a", "b"])!;
    expect(next).toEqual([
      { id: "c", position: 1 },
      { id: "a", position: 2 },
      { id: "b", position: 5 },
    ]);
    const after = scenes.map((s) => ({ ...s, position: next.find((n) => n.id === s.id)!.position }));
    expect([...after].sort(compareSceneOrder).map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("keeps keys strictly increasing when two scenes share one", () => {
    const tied = [
      { id: "a", idx: 1, position: 3 },
      { id: "b", idx: 3, position: null },
    ];
    expect(reassignPositions(tied, ["b", "a"])).toEqual([
      { id: "b", position: 3 },
      { id: "a", position: 4 },
    ]);
  });

  it("refuses an order that is not exactly these scenes", () => {
    expect(reassignPositions(scenes, ["a", "b"])).toBeNull();
    expect(reassignPositions(scenes, ["a", "b", "b"])).toBeNull();
    expect(reassignPositions(scenes, ["a", "b", "zzz"])).toBeNull();
  });
});
