// Pure "would this go over budget" arithmetic, split out of
// render-confirm-dialog.tsx and scene-rerender-dialog.tsx so it is
// unit-testable without mounting React and so the two dialogs' Confirm-button
// logic can't drift apart. Deliberately has no import of lib/spend.ts (which
// pulls in next/headers via lib/supabase/server) — both dialogs are Client
// Components, and that import would break the client bundle.
//
// The server is still the real gate (assertCapNotExceeded in lib/spend.ts,
// enforced in actions/enqueue.ts) — this only decides whether the button
// should let the operator try, mirroring the estimate the confirm screen
// already shows rather than re-deriving a second number that could disagree
// with it.

/** Whether a render estimated at `costUsd` would exceed today's remaining budget. */
export function exceedsRemainingBudget(costUsd: number, remainingBudgetUsd: number): boolean {
  return costUsd > remainingBudgetUsd;
}

/** How far over the remaining budget a render would go. Negative/zero means it's within budget. */
export function budgetOverageUsd(costUsd: number, remainingBudgetUsd: number): number {
  return costUsd - remainingBudgetUsd;
}

/**
 * Which spend ceiling — global, weekly, hourly, or daily — a render costing
 * `costUsd` would actually be refused by, checked in the exact global ->
 * weekly -> hourly -> daily priority assertWithinSpendCaps (lib/spend.ts) enforces
 * server-side. `null` means every ceiling still has headroom.
 *
 * This closes the gap render/page.tsx used to leave open: it fed every
 * confirm dialog DAILY remaining only (lib/spend.ts's getRemainingBudget),
 * so the client's "can I afford this" check and the server's actual
 * enforcement order could disagree about which cap was about to refuse a
 * render — an editor with $9 spent of a $10 week and $0 spent today saw
 * "$5.00 remaining" (their daily headroom), clicked Confirm, and was
 * refused by the weekly check the button never looked at. render/page.tsx
 * now threads the full RenderBudgetFigures picture (lib/spend.ts's
 * getAccountBudgetSnapshot) down to every dialog so this function checks
 * the same four limits the server does.
 *
 * Pure and DB-free for the same reason exceedsRemainingBudget above is: no
 * import of lib/spend.ts (would break the client bundle — every caller
 * here is a Client Component), unit-testable against the same fixtures
 * bindingSpendCap (lib/spend.ts) uses.
 *
 * `>`, via exceedsRemainingBudget, not `>=` — mirrors assertCapNotExceeded's
 * own "landing exactly on the cap is fine" rule, so this can't disable
 * Confirm on a render the server would actually allow.
 */
export type BindingSpendCap = "global" | "weekly" | "hourly" | "daily" | null;

export interface RenderBudgetFigures {
  /** False means the per-user daily threshold is informational, not enforced. */
  dailyCapEnabled?: boolean;
  dailyRemainingUsd: number;
  dailyCapUsd: number;
  weeklyRemainingUsd: number;
  weeklyCapUsd: number;
  globalRemainingUsd: number;
  globalCapUsd: number;
  globalCapEnabled?: boolean;
  globalCapPeriod?: "daily" | "weekly";
  hourlyRemainingUsd?: number | null;
  hourlyCapUsd?: number | null;
}

export function bindingRenderCap(costUsd: number, budget: RenderBudgetFigures): BindingSpendCap {
  if (
    budget.globalCapEnabled !== false &&
    exceedsRemainingBudget(costUsd, budget.globalRemainingUsd)
  ) {
    return "global";
  }
  if (exceedsRemainingBudget(costUsd, budget.weeklyRemainingUsd)) return "weekly";
  if (
    budget.hourlyCapUsd != null &&
    budget.hourlyRemainingUsd != null &&
    exceedsRemainingBudget(costUsd, budget.hourlyRemainingUsd)
  ) {
    return "hourly";
  }
  if (
    budget.dailyCapEnabled !== false &&
    exceedsRemainingBudget(costUsd, budget.dailyRemainingUsd)
  ) {
    return "daily";
  }
  return null;
}

/** The remaining figure and cap for whichever ceiling `cap` names. */
function figuresForCap(
  cap: Exclude<BindingSpendCap, null>,
  budget: RenderBudgetFigures,
): { remainingUsd: number; capUsd: number } {
  if (cap === "global") {
    return { remainingUsd: budget.globalRemainingUsd, capUsd: budget.globalCapUsd };
  }
  if (cap === "weekly") {
    return { remainingUsd: budget.weeklyRemainingUsd, capUsd: budget.weeklyCapUsd };
  }
  if (cap === "hourly") {
    return { remainingUsd: budget.hourlyRemainingUsd ?? 0, capUsd: budget.hourlyCapUsd ?? 0 };
  }
  return { remainingUsd: budget.dailyRemainingUsd, capUsd: budget.dailyCapUsd };
}

/**
 * The refusal sentence for whichever cap `bindingRenderCap` names — mirrors
 * assertCapNotExceeded/assertWeeklyCapNotExceeded/assertGlobalCapNotExceeded's
 * own wording (lib/spend.ts) so the client's early warning and the server's
 * actual refusal never tell an editor two different stories about the same
 * render. This is the "show which cap binds, not a bare number" decision —
 * a number alone says "you have money"; this answers the question an
 * editor staring at a disabled Confirm button actually has: "why can't I do
 * this right now?"
 *
 * Returns `null` when `cap` is `null` (nothing binds) — callers should only
 * invoke this once `bindingRenderCap` has already returned non-null, but a
 * null return is safer for a caller that doesn't than a thrown error would
 * be.
 */
export function renderCapRefusalMessage(
  cap: BindingSpendCap,
  costUsd: number,
  budget: RenderBudgetFigures,
): string | null {
  if (cap === null) return null;
  // A non-finite cost is a MISCONFIGURATION, not a budget problem, and every
  // sentence below would misdiagnose it. priceForSecond answers Infinity
  // when the model that will actually render has no measured rate for the
  // vendor it routes to — which on 2026-08-31 meant Hailuo 2.3 Pro shipped
  // enabled while KIE_MODELS still listed only two ids, so it resolved to
  // fal, whose price map for it is empty by design.
  //
  // The operator was told the render was "$Infinity over what the team has
  // left today" and to "wait for today's spend to reset". Waiting would
  // never have helped, and the cap named had nothing to do with it.
  if (!Number.isFinite(costUsd)) {
    return (
      "This model has no measured price for the vendor it routes to, so the cost cannot be " +
      "quoted and the render is refused. Nothing is wrong with your budget — this is a " +
      "configuration problem: the model is offered but its vendor routing or its rate is missing."
    );
  }
  const { remainingUsd, capUsd } = figuresForCap(cap, budget);
  const overageUsd = budgetOverageUsd(costUsd, remainingUsd);
  if (cap === "global") {
    const periodLabel = budget.globalCapPeriod === "weekly" ? "this week" : "today";
    const reset =
      budget.globalCapPeriod === "weekly"
        ? "5:00 AM Monday Manila time"
        : "5:00 AM Manila time tomorrow";
    return (
      `This render is $${overageUsd.toFixed(2)} over what the team has left ${periodLabel} ` +
      `(global ${budget.globalCapPeriod ?? "daily"} cap $${capUsd.toFixed(2)}). This is not about your own usage — wait until ` +
      `${reset}, or ask an admin to raise the global cap.`
    );
  }
  if (cap === "weekly") {
    return (
      `This render is $${overageUsd.toFixed(2)} over what you have left this week ` +
      `($${capUsd.toFixed(2)} weekly allowance). Wait until 5:00 AM Monday Manila time, lower the resolution, ` +
      "render fewer scenes, or ask an admin to raise your weekly allowance."
    );
  }
  if (cap === "hourly") {
    return (
      `This render is $${overageUsd.toFixed(2)} over what you have left in the last hour ` +
      `(hourly cap $${capUsd.toFixed(2)}). Wait for earlier spend to age out or ask an admin ` +
      "to raise your hourly cap."
    );
  }
  return (
    `This render is $${overageUsd.toFixed(2)} over what you have left today ` +
    `(daily cap $${capUsd.toFixed(2)}). Wait until 5:00 AM Manila time tomorrow, lower the resolution, or render ` +
    "fewer scenes."
  );
}
