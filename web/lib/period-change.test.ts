import { describe, expect, it } from "vitest";
import { isNearWeeklyCap, periodChange, weekToDateChange } from "./period-change";

describe("periodChange", () => {
  it("reports up with a percentage of the previous period", () => {
    expect(periodChange(150, 100)).toEqual({ direction: "up", deltaUsd: 50, pct: 50 });
  });

  it("reports down", () => {
    expect(periodChange(75, 100)).toEqual({ direction: "down", deltaUsd: -25, pct: -25 });
  });

  it("treats a change under half a cent as flat", () => {
    expect(periodChange(10.004, 10)).toEqual({ direction: "flat", deltaUsd: 0, pct: null });
    expect(periodChange(0, 0).direction).toBe("flat");
  });

  it("has no percentage when the previous period was $0", () => {
    expect(periodChange(12, 0)).toEqual({ direction: "up", deltaUsd: 12, pct: null });
  });
});

describe("weekToDateChange", () => {
  // 14 days ending Wednesday 2026-11-11 (Manila): index 13 is today.
  const wednesday = new Date("2026-11-11T04:00:00Z");

  it("compares Monday..today with the same days last week", () => {
    const days = Array.from({ length: 14 }, () => 100);
    days[4] = days[5] = days[6] = 10; // Mon-Wed last week
    days[11] = days[12] = days[13] = 15; // Mon-Wed this week
    const result = weekToDateChange(days, wednesday);
    expect(result.currentUsd).toBe(45);
    expect(result.previousUsd).toBe(30);
    expect(result.change).toEqual({ direction: "up", deltaUsd: 15, pct: 50 });
  });

  it("compares two whole weeks on a Sunday", () => {
    const days = [...Array.from({ length: 7 }, () => 2), ...Array.from({ length: 7 }, () => 1)];
    const result = weekToDateChange(days, new Date("2026-11-15T04:00:00Z"));
    expect(result.currentUsd).toBe(7);
    expect(result.previousUsd).toBe(14);
    expect(result.change.direction).toBe("down");
  });

  it("uses the Manila week, not the UTC one", () => {
    const days = Array.from({ length: 14 }, (_, i) => i);
    // 2026-11-08 16:30 UTC is Monday 00:30 in Manila: only today counts.
    expect(weekToDateChange(days, new Date("2026-11-08T16:30:00Z")).currentUsd).toBe(13);
    // An hour earlier is still Sunday in Manila: the whole week counts.
    expect(weekToDateChange(days, new Date("2026-11-08T15:30:00Z")).currentUsd).toBe(
      7 + 8 + 9 + 10 + 11 + 12 + 13,
    );
  });

  it("refuses fewer than 14 days", () => {
    expect(() => weekToDateChange([1, 2, 3], wednesday)).toThrow();
  });
});

describe("isNearWeeklyCap", () => {
  it("flags 80% or more of cap + grants", () => {
    expect(isNearWeeklyCap(20, 25)).toBe(true);
    expect(isNearWeeklyCap(19.99, 25)).toBe(false);
    expect(isNearWeeklyCap(30, 25)).toBe(true);
  });

  it("never flags an account that spent nothing, even on a $0 cap", () => {
    expect(isNearWeeklyCap(0, 0)).toBe(false);
    expect(isNearWeeklyCap(0, 25)).toBe(false);
  });

  it("flags any spend against a $0 total", () => {
    expect(isNearWeeklyCap(1, 0)).toBe(true);
  });
});
