import { describe, expect, it } from "vitest";
import {
  BUDGET_PRESSURE_CRITICAL_RATIO,
  BUDGET_PRESSURE_WARNING_RATIO,
  LOW_BUDGET_RATIO,
  budgetPressure,
  budgetTier,
  selectBindingMeter,
} from "./budget-tier";
import type { MeterWindow } from "./budget-tier";

// The sidebar budget colour scale — the fix this file exists for was going
// from two steps (normal, text-destructive at/below LOW_BUDGET_RATIO) to
// three (normal, warning, critical), so the two thresholds below — the
// LOW_BUDGET_RATIO boundary and the zero boundary — are the whole point of
// this suite, not incidental.
describe("budgetTier", () => {
  it("is normal well above the low-budget threshold", () => {
    expect(budgetTier(5, 10)).toBe("normal");
  });

  it("is warning at exactly LOW_BUDGET_RATIO of the cap", () => {
    expect(budgetTier(10 * LOW_BUDGET_RATIO, 10)).toBe("warning");
  });

  it("is warning just above zero but under the ratio threshold", () => {
    expect(budgetTier(0.5, 10)).toBe("warning");
  });

  it("is normal just above the ratio threshold, not warning", () => {
    // 10% of 10 is 1.00 — 1.01 remaining is just outside the warning band.
    expect(budgetTier(1.01, 10)).toBe("normal");
  });

  it("is critical at exactly zero remaining", () => {
    expect(budgetTier(0, 10)).toBe("critical");
  });

  it("is critical when remaining has gone negative", () => {
    expect(budgetTier(-0.5, 10)).toBe("critical");
  });

  it("treats a non-positive cap as normal rather than dividing by zero into critical", () => {
    expect(budgetTier(5, 0)).toBe("normal");
    expect(budgetTier(5, -1)).toBe("normal");
  });

  it("still reports critical for a non-positive cap once remaining itself is non-positive — the zero check comes first", () => {
    expect(budgetTier(0, 0)).toBe("critical");
  });
});

// selectBindingMeter — "the cap that will stop the user first", compared as
// a FRACTION of each window's own cap, not raw dollars. A $5 daily cap and
// a $10 weekly cap must compare fairly: equal dollar figures at unequal caps
// are not equally close to stopping the user.
describe("selectBindingMeter", () => {
  const daily = (remainingUsd: number, capUsd = 5): MeterWindow => ({
    period: "today",
    remainingUsd,
    capUsd,
  });
  const weekly = (remainingUsd: number, capUsd = 10): MeterWindow => ({
    period: "this week",
    remainingUsd,
    capUsd,
  });

  it("picks the window with the smaller remaining fraction, not the smaller dollar figure", () => {
    // $2 left of $5 daily (40%) vs $2 left of $10 weekly (20%) — equal
    // dollars, but weekly has less headroom as a fraction of its own cap.
    expect(selectBindingMeter(daily(2), weekly(2))).toEqual(weekly(2));
  });

  it("picks daily when daily's fraction is smaller", () => {
    // $0.50 of $5 daily (10%) vs $5 of $10 weekly (50%).
    expect(selectBindingMeter(daily(0.5), weekly(5))).toEqual(daily(0.5));
  });

  it("picks whichever cap is actually exhausted, regardless of the other's fraction", () => {
    expect(selectBindingMeter(daily(0), weekly(8))).toEqual(daily(0));
    expect(selectBindingMeter(daily(4), weekly(0))).toEqual(weekly(0));
  });

  it("picks the more negative (further over cap) window when both are exhausted", () => {
    expect(selectBindingMeter(daily(-1, 5), weekly(-0.5, 10))).toEqual(daily(-1, 5));
  });

  it("breaks an exact fraction tie in favor of weekly", () => {
    // 50% remaining on both: $2.50 of $5 daily, $5 of $10 weekly.
    expect(selectBindingMeter(daily(2.5), weekly(5))).toEqual(weekly(5));
  });

  it("never selects a non-positive cap over a real one", () => {
    expect(selectBindingMeter(daily(1, 0), weekly(1))).toEqual(weekly(1));
    expect(selectBindingMeter(daily(1), weekly(1, 0))).toEqual(daily(1));
  });
});

// budgetPressure — the overnight-drain early-warning this file's own header
// comment now explains is a DIFFERENT scale from budgetTier above: 70%/90%
// of the cap CONSUMED, not a remaining-based 10% cutoff, so exercising it
// against a $100 cap keeps the arithmetic legible.
describe("budgetPressure", () => {
  it("is normal below the warning threshold", () => {
    expect(budgetPressure(69, 100)).toBe("normal");
    expect(budgetPressure(0, 100)).toBe("normal");
  });

  it("is warning at exactly the warning ratio", () => {
    expect(budgetPressure(100 * BUDGET_PRESSURE_WARNING_RATIO, 100)).toBe("warning");
  });

  it("stays warning up to just under the critical ratio", () => {
    expect(budgetPressure(89, 100)).toBe("warning");
  });

  it("is critical at exactly the critical ratio", () => {
    expect(budgetPressure(100 * BUDGET_PRESSURE_CRITICAL_RATIO, 100)).toBe("critical");
  });

  it("is critical above 100% consumed, not an error or a fifth state", () => {
    expect(budgetPressure(150, 100)).toBe("critical");
  });

  it("is critical when usedUsd exceeds capUsd — the negative-remaining case, expressed as used > cap", () => {
    // remainingUsd = capUsd - usedUsd would be -20 here; budgetPressure
    // takes (used, cap) directly per its signature, so this is the same
    // over-spent line, not a throw.
    expect(budgetPressure(120, 100)).toBe("critical");
  });

  it("treats a null cap as normal, not a divide-by-zero or a false alarm", () => {
    expect(budgetPressure(50, null)).toBe("normal");
  });

  it("treats a non-positive cap as normal, same as budgetTier's own no-denominator case", () => {
    expect(budgetPressure(50, 0)).toBe("normal");
    expect(budgetPressure(50, -10)).toBe("normal");
  });
});
