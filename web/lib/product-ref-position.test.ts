import { describe, expect, it } from "vitest";
import {
  nextProductRefPosition,
  promotedPrimaryId,
  type PositionedAsset,
} from "./product-ref-position";

describe("nextProductRefPosition", () => {
  it("returns 0 for the first photo ever uploaded", () => {
    expect(nextProductRefPosition([])).toBe(0);
  });

  it("appends one past the current highest position", () => {
    const existing: PositionedAsset[] = [
      { id: "a", position: 0 },
      { id: "b", position: 1 },
    ];
    expect(nextProductRefPosition(existing)).toBe(2);
  });

  it("is unaffected by array order — only the max position matters", () => {
    const existing: PositionedAsset[] = [
      { id: "a", position: 3 },
      { id: "b", position: 0 },
      { id: "c", position: 1 },
    ];
    expect(nextProductRefPosition(existing)).toBe(4);
  });

  it("handles a gappy position sequence left behind by a prior removal", () => {
    // e.g. position 1 was removed and never renumbered — promotedPrimaryId
    // only ever touches the removed row's slot, not the whole sequence, so
    // gaps are expected and must not confuse the next-position calculation.
    const existing: PositionedAsset[] = [
      { id: "a", position: 0 },
      { id: "c", position: 5 },
    ];
    expect(nextProductRefPosition(existing)).toBe(6);
  });
});

describe("promotedPrimaryId", () => {
  it("returns null when no photos remain", () => {
    expect(promotedPrimaryId([])).toBeNull();
  });

  it("promotes the lowest remaining position", () => {
    const remaining: PositionedAsset[] = [
      { id: "b", position: 2 },
      { id: "c", position: 1 },
    ];
    expect(promotedPrimaryId(remaining)).toBe("c");
  });

  it("promotes the only remaining photo regardless of its position", () => {
    expect(promotedPrimaryId([{ id: "solo", position: 4 }])).toBe("solo");
  });
});
