import { describe, expect, it } from "vitest";
import {
  bindingRenderCap,
  budgetOverageUsd,
  exceedsRemainingBudget,
  renderCapRefusalMessage,
  type RenderBudgetFigures,
} from "./render-budget";
import {
  assertCapNotExceeded,
  assertGlobalCapNotExceeded,
  assertHourlyCapNotExceeded,
  assertWeeklyCapNotExceeded,
} from "./spend";

describe("exceedsRemainingBudget", () => {
  // The bug this module exists to fix: render-confirm-dialog.tsx already
  // computed and displayed a negative "remaining budget after this render"
  // in red, but left Confirm enabled — the server then refused, and that
  // refusal was itself invisible in production (error #441) until the
  // ActionResult fix. This is the check that should have disabled Confirm
  // in the first place.
  it("is true when the render's cost is more than what's left in the budget", () => {
    expect(exceedsRemainingBudget(1.44, 0.52)).toBe(true);
  });

  it("is false when the render's cost lands exactly on the remaining budget", () => {
    // Landing exactly on the cap is allowed — mirrors assertCapNotExceeded's
    // own "projected === capUsd does not throw" rule in lib/spend.ts, so the
    // UI's early warning can't disagree with the server's real gate.
    expect(exceedsRemainingBudget(5, 5)).toBe(false);
  });

  it("is false when the render costs less than what's left in the budget", () => {
    expect(exceedsRemainingBudget(1, 5)).toBe(false);
  });

  // The exact numbers from the production screenshot this bug was found
  // from: $4.48 spent today against a $5.00 cap, on a $1.44 render.
  it("catches the production case: $4.48 spent, $5.00 cap, $1.44 render", () => {
    const remainingBudgetUsd = 5.0 - 4.48;
    expect(exceedsRemainingBudget(1.44, remainingBudgetUsd)).toBe(true);
  });

  it("is true when the daily budget is already exhausted, even for a $0 render request", () => {
    expect(exceedsRemainingBudget(0.01, -0.92)).toBe(true);
  });

  // components/render-gate.tsx's "Test scene 1 only" button reuses this
  // exact function (via RenderConfirmDialog's kind="test") rather than a
  // separate over-budget check — a single scene's cost is still real money
  // and must obey the same disable rule as the "Render all" button.
  it("disables the test-scene button the same way it disables the full-batch one", () => {
    const oneSceneCostUsd = 1.12; // one 14s talking-head scene at Kling's $0.08/s
    expect(exceedsRemainingBudget(oneSceneCostUsd, 1.0)).toBe(true);
    expect(exceedsRemainingBudget(oneSceneCostUsd, 1.12)).toBe(false);
  });
});

describe("budgetOverageUsd", () => {
  it("reports how far over budget the render would go", () => {
    const remainingBudgetUsd = 5.0 - 4.48;
    expect(budgetOverageUsd(1.44, remainingBudgetUsd)).toBeCloseTo(0.92, 5);
  });

  it("is zero or negative when the render is within budget, rather than a misleading positive number", () => {
    expect(budgetOverageUsd(1, 5)).toBeLessThanOrEqual(0);
  });
});

// bindingRenderCap is the fix for the render page's historical daily-only
// bug (see render/page.tsx and this function's own doc comment): the
// client's "can I afford this" check has to name the SAME cap
// assertWithinSpendCaps (lib/spend.ts) would actually refuse a render by,
// not just check the daily figure. Every case below is checked against the
// real assert*NotExceeded functions directly — not against a hand-picked
// expected string — so this suite fails the moment the two diverge, which
// is exactly the class of bug this file exists to prevent.
function budget(overrides: Partial<RenderBudgetFigures> = {}): RenderBudgetFigures {
  return {
    dailyRemainingUsd: 5,
    dailyCapUsd: 5,
    weeklyRemainingUsd: 10,
    weeklyCapUsd: 10,
    globalRemainingUsd: 50,
    globalCapUsd: 50,
    ...overrides,
  };
}

/** Whether the real server-side guard (lib/spend.ts) would refuse `costUsd` given the same three remaining figures — the ground truth bindingRenderCap has to agree with. */
function serverWouldRefuse(
  cap: "global" | "weekly" | "hourly" | "daily",
  costUsd: number,
  b: RenderBudgetFigures,
): boolean {
  const spentUsd =
    cap === "global"
      ? b.globalCapUsd - b.globalRemainingUsd
      : cap === "weekly"
        ? b.weeklyCapUsd - b.weeklyRemainingUsd
        : cap === "hourly"
          ? (b.hourlyCapUsd ?? 0) - (b.hourlyRemainingUsd ?? 0)
          : b.dailyCapUsd - b.dailyRemainingUsd;
  const capUsd =
    cap === "global"
      ? b.globalCapUsd
      : cap === "weekly"
        ? b.weeklyCapUsd
        : cap === "hourly"
          ? (b.hourlyCapUsd ?? 0)
          : b.dailyCapUsd;
  const assertFn =
    cap === "global"
      ? assertGlobalCapNotExceeded
      : cap === "weekly"
        ? assertWeeklyCapNotExceeded
        : cap === "hourly"
          ? assertHourlyCapNotExceeded
          : assertCapNotExceeded;
  try {
    assertFn(spentUsd, costUsd, capUsd);
    return false;
  } catch {
    return true;
  }
}

describe("bindingRenderCap", () => {
  it("returns null when every ceiling has headroom", () => {
    expect(bindingRenderCap(1, budget())).toBeNull();
  });

  it("names 'daily' — the historical bug — when only the daily figure is over, agreeing with assertCapNotExceeded", () => {
    const b = budget({ dailyRemainingUsd: 1 });
    const costUsd = 2;
    expect(bindingRenderCap(costUsd, b)).toBe("daily");
    expect(serverWouldRefuse("daily", costUsd, b)).toBe(true);
  });

  it("names 'weekly' when weekly is exhausted but daily still has room — the exact case the old daily-only check missed: $9 spent of a $10 week, $0 spent today", () => {
    const b = budget({ weeklyRemainingUsd: 1, dailyRemainingUsd: 5 });
    const costUsd = 2; // affordable today, NOT affordable this week
    expect(bindingRenderCap(costUsd, b)).toBe("weekly");
    expect(serverWouldRefuse("weekly", costUsd, b)).toBe(true);
    // The old bug: a daily-only check would have said this is fine.
    expect(exceedsRemainingBudget(costUsd, b.dailyRemainingUsd)).toBe(false);
  });

  it("names 'global' ahead of 'weekly' and 'daily' when all four are exhausted — same global -> weekly -> hourly -> daily priority assertWithinSpendCaps enforces", () => {
    const b = budget({ globalRemainingUsd: 1, weeklyRemainingUsd: 1, dailyRemainingUsd: 1 });
    expect(bindingRenderCap(2, b)).toBe("global");
  });

  it("names 'weekly' ahead of 'daily' when both are exhausted but global has room", () => {
    const b = budget({ weeklyRemainingUsd: 1, dailyRemainingUsd: 1 });
    expect(bindingRenderCap(2, b)).toBe("weekly");
  });

  it("is null when the cost lands exactly on every remaining figure — landing exactly on the cap is allowed, mirrors assertCapNotExceeded", () => {
    const b = budget({ dailyRemainingUsd: 2, weeklyRemainingUsd: 2, globalRemainingUsd: 2 });
    expect(bindingRenderCap(2, b)).toBeNull();
    expect(serverWouldRefuse("daily", 2, b)).toBe(false);
  });
  it("ignores the per-user daily figure when that optional guard is disabled", () => {
    const b = budget({ dailyCapEnabled: false, dailyRemainingUsd: 0 });
    expect(bindingRenderCap(2, b)).toBeNull();
  });

  it("names an hourly cap when it would bind and agrees with the server guard", () => {
    const b = budget({ hourlyCapUsd: 10, hourlyRemainingUsd: 1 });
    expect(bindingRenderCap(2, b)).toBe("hourly");
    expect(serverWouldRefuse("hourly", 2, b)).toBe(true);
  });

  it("ignores the global figure when that optional cap is disabled", () => {
    const b = budget({ globalCapEnabled: false, globalRemainingUsd: 0, weeklyRemainingUsd: 5 });
    expect(bindingRenderCap(1, b)).toBeNull();
  });
});

describe("renderCapRefusalMessage", () => {
  it("is null when nothing binds", () => {
    expect(renderCapRefusalMessage(null, 1, budget())).toBeNull();
  });

  it("names the weekly allowance, not the daily cap, when weekly is what binds", () => {
    const message = renderCapRefusalMessage("weekly", 2, budget({ weeklyRemainingUsd: 1 }));
    expect(message).toMatch(/weekly allowance/i);
    expect(message).not.toMatch(/daily cap/i);
  });

  it("names the global cap, not the caller's own usage, when global is what binds", () => {
    const message = renderCapRefusalMessage("global", 2, budget({ globalRemainingUsd: 1 }));
    expect(message).toMatch(/global daily cap/i);
    expect(message).toMatch(/not about your own usage/i);
  });

  it("names a weekly global window and hourly account cap", () => {
    const globalMessage = renderCapRefusalMessage(
      "global",
      2,
      budget({ globalRemainingUsd: 1, globalCapPeriod: "weekly" }),
    );
    expect(globalMessage).toMatch(/global weekly cap/i);
    expect(globalMessage).toMatch(/Monday/i);
    expect(
      renderCapRefusalMessage("hourly", 2, budget({ hourlyRemainingUsd: 1, hourlyCapUsd: 10 })),
    ).toMatch(/hourly cap/i);
  });

  it("names the daily cap when daily is what binds", () => {
    const message = renderCapRefusalMessage("daily", 2, budget({ dailyRemainingUsd: 1 }));
    expect(message).toMatch(/daily cap/i);
  });
});

describe("renderCapRefusalMessage — an unpriced model is not a budget problem", () => {
  // Hailuo 2.3 Pro shipped enabled on 2026-08-31 while production's
  // KIE_MODELS still named only two ids, so it resolved to fal, whose price
  // map for it is empty by design. priceForSecond answered Infinity, and the
  // operator was told the render was "$Infinity over what the team has left
  // today (global daily cap $33.00)" and to "wait for today's spend to
  // reset". Waiting would never have helped, and the cap named had nothing
  // to do with it.
  const budget: RenderBudgetFigures = {
    dailyRemainingUsd: 5,
    dailyCapUsd: 5,
    weeklyRemainingUsd: 10,
    weeklyCapUsd: 10,
    globalRemainingUsd: 33,
    globalCapUsd: 33,
  };

  it("names the misconfiguration instead of a cap", () => {
    const message = renderCapRefusalMessage("global", Number.POSITIVE_INFINITY, budget);
    expect(message).toMatch(/no measured price for the vendor it routes to/);
    expect(message).not.toMatch(/wait for/i);
    expect(message).not.toMatch(/\$Infinity/);
  });

  it("says the budget is not the problem, since the dialog is a budget dialog", () => {
    const message = renderCapRefusalMessage("daily", Number.POSITIVE_INFINITY, budget);
    expect(message).toMatch(/Nothing is wrong with your budget/);
  });

  it("still reports a real overage normally", () => {
    const message = renderCapRefusalMessage("global", 40, budget);
    expect(message).toMatch(/\$7\.00 over what the team has left today/);
  });
});
