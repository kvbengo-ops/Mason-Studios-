import { describe, expect, it } from "vitest";
import {
  computeRunway,
  formatRunwayDays,
  isRunwayShort,
  RUNWAY_WARNING_THRESHOLD_DAYS,
  RUNWAY_WINDOW_DAYS,
} from "./runway";

describe("computeRunway", () => {
  it("is 'unknown' when the balance is null, regardless of burn", () => {
    expect(computeRunway(null, 100)).toEqual({ status: "unknown" });
    expect(computeRunway(null, 0)).toEqual({ status: "unknown" });
  });

  it("is 'no-burn' when trailing spend is zero, regardless of balance", () => {
    expect(computeRunway(31.17, 0)).toEqual({ status: "no-burn" });
    expect(computeRunway(0, 0)).toEqual({ status: "no-burn" });
  });

  it("divides balance by the trailing daily burn rate over the given window", () => {
    // $70 spent over 7 days = $10/day; $30 balance / $10/day = 3 days.
    const result = computeRunway(30, 70, 7);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.days).toBeCloseTo(3, 5);
  });

  it("defaults the window to RUNWAY_WINDOW_DAYS when not given explicitly", () => {
    const withDefault = computeRunway(30, 70);
    const withExplicit = computeRunway(30, 70, RUNWAY_WINDOW_DAYS);
    expect(withDefault).toEqual(withExplicit);
  });

  it("never produces NaN or Infinity for any finite, non-negative input", () => {
    // The whole point of this file: a null balance or a zero burn must
    // short-circuit to an explicit state, not fall through into a division
    // that produces one of these two values on screen.
    for (const balance of [null, 0, 0.01, 1000]) {
      for (const spend of [0, 0.01, 1000]) {
        const result = computeRunway(balance, spend);
        if (result.status === "ok") {
          expect(Number.isFinite(result.days)).toBe(true);
          expect(Number.isNaN(result.days)).toBe(false);
        }
      }
    }
  });
});

describe("isRunwayShort", () => {
  it("is false for 'unknown' and 'no-burn' — nothing actionable to warn about", () => {
    expect(isRunwayShort({ status: "unknown" })).toBe(false);
    expect(isRunwayShort({ status: "no-burn" })).toBe(false);
  });

  it("is false when days is exactly at the threshold (landing on the boundary is fine)", () => {
    expect(isRunwayShort({ status: "ok", days: RUNWAY_WARNING_THRESHOLD_DAYS })).toBe(false);
  });

  it("is true when days is under the threshold", () => {
    expect(isRunwayShort({ status: "ok", days: RUNWAY_WARNING_THRESHOLD_DAYS - 0.01 })).toBe(true);
  });

  it("is false when days is comfortably above the threshold", () => {
    expect(isRunwayShort({ status: "ok", days: 30 })).toBe(false);
  });

  it("honors a custom threshold", () => {
    expect(isRunwayShort({ status: "ok", days: 5 }, 10)).toBe(true);
    expect(isRunwayShort({ status: "ok", days: 15 }, 10)).toBe(false);
  });
});

describe("formatRunwayDays", () => {
  it("renders 'unknown' as Unknown, never $0.00 or a bare number", () => {
    expect(formatRunwayDays({ status: "unknown" })).toBe("Unknown");
  });

  it("renders 'no-burn' with an explicit explanation, never Infinity", () => {
    const formatted = formatRunwayDays({ status: "no-burn" });
    expect(formatted).not.toMatch(/infinity/i);
    expect(formatted).toContain(String(RUNWAY_WINDOW_DAYS));
  });

  it("renders sub-day runway as 'Less than 1 day', not '0 days'", () => {
    expect(formatRunwayDays({ status: "ok", days: 0.4 })).toBe("Less than 1 day");
  });

  it("rounds to whole days with correct singular/plural", () => {
    expect(formatRunwayDays({ status: "ok", days: 1.2 })).toBe("1 day");
    expect(formatRunwayDays({ status: "ok", days: 6.4 })).toBe("6 days");
    expect(formatRunwayDays({ status: "ok", days: 6.6 })).toBe("7 days");
  });

  it("never renders NaN or Infinity text for any 'ok' estimate", () => {
    for (const days of [0, 0.5, 1, 3, 100, 10000]) {
      const formatted = formatRunwayDays({ status: "ok", days });
      expect(formatted).not.toMatch(/nan|infinity/i);
    }
  });
});
