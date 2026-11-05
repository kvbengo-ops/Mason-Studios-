import { describe, expect, it } from "vitest";
import { isDescriptionStale } from "./description-staleness";

describe("isDescriptionStale", () => {
  it("is stale when the edit happened AFTER the asset was generated", () => {
    expect(isDescriptionStale("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(true);
  });

  it("is not stale when the edit happened BEFORE the asset was generated", () => {
    expect(isDescriptionStale("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z")).toBe(false);
  });

  it("is not stale on an exact timestamp tie", () => {
    expect(isDescriptionStale("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(false);
  });

  it("is not stale when the text has never been edited (editedAt null)", () => {
    expect(isDescriptionStale(null, "2026-01-01T00:00:00.000Z")).toBe(false);
  });

  it("is not stale when no asset has ever been generated (assetCreatedAt null)", () => {
    expect(isDescriptionStale("2026-01-01T00:00:00.000Z", null)).toBe(false);
  });
});
