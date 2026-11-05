import { describe, expect, it } from "vitest";
import {
  addUtcDays,
  addUtcMonths,
  defaultSpendRange,
  parseDateParam,
  startOfUtcDay,
  startOfUtcMonth,
  toDateInputValue,
} from "./date-range";

describe("startOfUtcDay", () => {
  it("zeroes the time-of-day in UTC", () => {
    const start = startOfUtcDay(new Date("2026-08-14T23:59:59.999Z"));
    expect(start.toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });
});

describe("addUtcDays", () => {
  it("adds a positive number of days", () => {
    const result = addUtcDays(new Date("2026-08-14T00:00:00.000Z"), 5);
    expect(result.toISOString()).toBe("2026-08-19T00:00:00.000Z");
  });

  it("subtracts for a negative count", () => {
    const result = addUtcDays(new Date("2026-08-14T00:00:00.000Z"), -14);
    expect(result.toISOString()).toBe("2026-07-31T00:00:00.000Z");
  });

  it("rolls over a month/year boundary", () => {
    const result = addUtcDays(new Date("2025-12-30T00:00:00.000Z"), 5);
    expect(result.toISOString()).toBe("2026-01-04T00:00:00.000Z");
  });
});

describe("startOfUtcMonth", () => {
  it("returns the 1st of the month at UTC midnight", () => {
    const start = startOfUtcMonth(new Date("2026-08-14T12:34:56.000Z"));
    expect(start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("addUtcMonths", () => {
  it("adds a month, rolling into the next year", () => {
    const result = addUtcMonths(new Date("2026-12-01T00:00:00.000Z"), 1);
    expect(result.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("toDateInputValue", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    expect(toDateInputValue(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026-01-05");
  });
});

describe("parseDateParam", () => {
  const fallback = new Date("2020-01-01T00:00:00.000Z");

  it("parses a well-formed YYYY-MM-DD value", () => {
    const result = parseDateParam("2026-08-14", fallback);
    expect(result.toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });

  it("falls back for a missing value", () => {
    expect(parseDateParam(undefined, fallback)).toBe(fallback);
  });

  it("falls back for a malformed value", () => {
    expect(parseDateParam("not-a-date", fallback)).toBe(fallback);
    expect(parseDateParam("2026/08/14", fallback)).toBe(fallback);
  });

  it("falls back for a calendar date that doesn't exist (Date.UTC would otherwise silently roll it forward)", () => {
    expect(parseDateParam("2026-02-30", fallback)).toBe(fallback);
  });

  it("takes the first value when Next hands back an array (repeated query key)", () => {
    const result = parseDateParam(["2026-08-14", "2026-08-15"], fallback);
    expect(result.toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });
});

describe("defaultSpendRange", () => {
  it("spans the last 30 calendar days, today included", () => {
    const range = defaultSpendRange(new Date("2026-08-14T15:00:00.000Z"));
    expect(toDateInputValue(range.to)).toBe("2026-08-14");
    expect(toDateInputValue(range.from)).toBe("2026-07-16");
  });
});
