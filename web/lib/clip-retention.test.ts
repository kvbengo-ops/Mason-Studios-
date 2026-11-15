import { describe, expect, it } from "vitest";
import { clipExpiryLabel, clipExpiryWarnCutoff, daysUntilClipExpiry } from "./clip-retention";

const NOW = Date.parse("2026-11-20T00:00:00Z");
const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

describe("clip retention (14 days, warning from 3 days out)", () => {
  it("counts whole days left and never goes negative", () => {
    expect(daysUntilClipExpiry(daysAgo(0), NOW)).toBe(14);
    expect(daysUntilClipExpiry(daysAgo(11.5), NOW)).toBe(3);
    expect(daysUntilClipExpiry(daysAgo(14), NOW)).toBe(0);
    expect(daysUntilClipExpiry(daysAgo(30), NOW)).toBe(0);
  });

  it("puts the warning cutoff 11 days back", () => {
    expect(clipExpiryWarnCutoff(NOW)).toBe(daysAgo(11));
  });

  it("labels a kept clip as kept whatever its age", () => {
    expect(clipExpiryLabel(true, daysAgo(40), NOW)).toBe("Kept");
    expect(clipExpiryLabel(false, daysAgo(12), NOW)).toBe("Moves to the bin in 2d");
    expect(clipExpiryLabel(false, daysAgo(20), NOW)).toBe("Moves to the bin today");
  });
});
