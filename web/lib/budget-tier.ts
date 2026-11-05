// Pure sidebar-budget colour-tier decision, split into its own zero-
// dependency module so components/sidebar-budget.tsx — a plain Server
// Component app/(app)/layout.tsx renders on EVERY route — can import it
// unconditionally. lib/spend.ts is not safe for that: it throws at module
// load on a malformed *_CAP_USD env var (see lib/sidebar-budget.ts's own
// header), and pulling that into every route's layout would turn a
// render.yaml typo into a site-wide 500 instead of the scoped "rendering is
// unavailable" failure it's supposed to be. This file has no imports and no
// module-scope side effects, so there is nothing here that can throw at
// load time.
//
// budgetPressure (below, added alongside budgetTier) lives here for the
// same reason, not in lib/sidebar-budget.ts despite that file's name being
// the more obvious home: lib/sidebar-budget.ts has a real static top-level
// `import { createAdminClient } from "@/lib/supabase/server"`, which
// transitively imports `next/headers`. That's fine for its existing callers
// (Server Components only — see its header), but components/sidebar-
// budget.tsx and account-menu.tsx are rendered on the client
// (account-menu.tsx is "use client"), and account-menu.test.tsx already
// documents the exact failure mode of pulling that chain in (it mocks
// actions/auth.ts for the same reason). A pure derivation that the client
// components need at render time has to live in a module with zero
// server-only imports — this one — not in lib/sidebar-budget.ts.

export type BudgetTier = "normal" | "warning" | "critical";

/**
 * Below this fraction of the cap, remaining budget is "worth noticing"
 * (warning). At or below zero it's "already blocked" (critical). Same
 * threshold the old two-tier scale used for its single "text-destructive"
 * cutoff — only the middle tier is new.
 */
export const LOW_BUDGET_RATIO = 0.1;

/**
 * Three steps, not two: the old scale jumped straight from "fine" to
 * "too late" (text-destructive at/below LOW_BUDGET_RATIO, unweighted
 * elsewhere) — an editor with 8% of their daily cap left saw the exact same
 * colour as one already at $0.00, so there was no visual cue between
 * "slow down" and "already blocked". `warning` is the step that closes
 * that gap.
 *
 * `capUsd <= 0` reads as "nothing to measure a fraction against" (normal),
 * not a divide-by-zero critical — an uncapped or misconfigured-to-zero cap
 * shouldn't paint every figure critical just because the ratio math has no
 * denominator.
 */
export function budgetTier(remainingUsd: number, capUsd: number): BudgetTier {
  if (remainingUsd <= 0) return "critical";
  if (capUsd > 0 && remainingUsd <= capUsd * LOW_BUDGET_RATIO) return "warning";
  return "normal";
}

/**
 * One of the sidebar's two windows. `remainingUsd`/`capUsd`/`period` are the
 * only fields selectBindingMeter (below) reads or compares — the rest are
 * optional display-only breakdown data (Part 2 of the task that added them:
 * "show how it was derived, not just the answer") that components/sidebar-
 * budget.tsx's BudgetMeter renders when present and falls back to the plain
 * "$X of $Y left" line without. `grantUsd`/`grantExpiresAt` only ever apply
 * to the weekly window — a daily burst guard never has a grant (lib/spend.ts
 * documents this repeatedly: a grant raises the weekly allowance only).
 */
export interface MeterWindow {
  period: "this hour" | "today" | "this week";
  remainingUsd: number;
  capUsd: number;
  /** The plain allowance for this window, before any grant — omit to fall back to the old "$X of $Y left" line. */
  allowanceUsd?: number;
  /** What's been used against `allowanceUsd` (+ `grantUsd`) so far this window. */
  usedUsd?: number;
  /** Held for renders in flight — subtracted from `remainingUsd` alongside `usedUsd`, so the breakdown adds up. Omit or 0 when nothing is queued. */
  heldUsd?: number;
  /** Active grants folded into this window's cap, if any (weekly only). */
  grantUsd?: number;
  /** The soonest expiry among active grants, if any. */
  grantExpiresAt?: string | null;
}

/**
 * Picks which of the two sidebar windows (daily, weekly) gets the full meter
 * — "the cap that will stop the user first" — the other stays small text
 * (components/sidebar-budget.tsx). This is a DIFFERENT question from
 * lib/spend.ts's `bindingSpendCap`, which answers "which cap is refusing
 * enqueue RIGHT NOW" under a fixed global -> weekly -> daily priority and
 * doesn't care how close the other caps are. This function has no priority
 * order at all: it compares the two windows purely by how much headroom
 * each has left, AS A FRACTION OF ITS OWN CAP, so a $5 daily cap and a $10
 * weekly cap compare fairly — $2 left today (40% of $5) is closer to
 * stopping the user than $2 left this week (20% of $10) even though the
 * dollar figures are equal. Do not swap this in for bindingSpendCap or vice
 * versa; they answer different questions and happen to agree only by
 * coincidence in the common case (weekly usually has the smaller fraction
 * because $2/day vs $5/week style caps make the week exhaust first).
 *
 * A cap that is actually exhausted (remainingUsd <= 0, fraction <= 0) always
 * wins the comparison on its own — fractions below zero sort correctly
 * against a healthy fraction without any special-casing. A non-positive
 * capUsd (misconfigured or uncapped) is treated as having no fraction to
 * offer (+Infinity) so it never wins over a real cap, matching budgetTier's
 * own "no denominator" treatment of the same case.
 *
 * Ties (equal fraction, including both windows healthy at the same ratio)
 * resolve to weekly — the window sidebar-budget.tsx's own long-standing
 * comment already calls out as "the one that actually binds most of the
 * time by design", and the same order bindingSpendCap gives weekly over
 * daily.
 */
export function selectBindingMeter(first: MeterWindow, ...others: MeterWindow[]): MeterWindow {
  const fraction = (w: MeterWindow): number =>
    w.capUsd > 0 ? w.remainingUsd / w.capUsd : Number.POSITIVE_INFINITY;
  return others.reduce((best, window) => {
    const nextFraction = fraction(window);
    const bestFraction = fraction(best);
    return nextFraction < bestFraction ||
      (nextFraction === bestFraction && window.period === "this week")
      ? window
      : best;
  }, first);
}

export type BudgetPressure = "normal" | "warning" | "critical";

/**
 * Thresholds for `budgetPressure`, as a fraction of a cap CONSUMED (not
 * remaining — the inverse framing from `LOW_BUDGET_RATIO` above, chosen
 * because "70%/90% of the ceiling spent" is the sentence the product
 * requirement is written in). Kept as named constants in this one place —
 * not inlined at each of the sidebar's daily/weekly/team call sites — the
 * same reason the codebase keeps e.g. `MAX_TITLE_LENGTH` in one file rather
 * than repeating the number.
 *
 * Deliberately separate from `LOW_BUDGET_RATIO`/`budgetTier` above: that
 * pair answers "what colour should this figure be" for the existing meter
 * fill (a remaining-based 10% cutoff, two steps below zero), tuned for a
 * bar that's already being looked at. This pair answers a different
 * question — "should we proactively flag this line before anyone asks" —
 * for an unattended overnight batch that nobody is watching, which is why
 * it starts flagging much earlier (70%) and independently of the meter's
 * own colour logic. The two scales are not meant to agree and were
 * specified independently; do not try to unify them.
 */
export const BUDGET_PRESSURE_WARNING_RATIO = 0.7;
export const BUDGET_PRESSURE_CRITICAL_RATIO = 0.9;

/**
 * Pure pressure classification for a single budget line (daily, weekly, or
 * the admin-only team-wide line), given how much of it has been used and
 * what its cap is. Unit-testable with no rendering — the component this
 * feeds should only ever switch on the result, never recompute the ratio
 * itself.
 *
 * `capUsd` of `null` or `<= 0` is "normal", not a divide-by-zero and not a
 * false alarm: a missing cap (e.g. the team figure for a non-admin, before
 * this function is even called for them — see components/sidebar-
 * budget.tsx) or a genuinely uncapped/misconfigured-to-zero account has no
 * ceiling to measure pressure against, so there is nothing to warn about.
 * Same "no denominator" treatment `budgetTier` above already gives
 * `capUsd <= 0`.
 *
 * `usedUsd` can exceed `capUsd` (the account is over its cap — a grant
 * expired mid-window, or a race let one more render through). That yields
 * a ratio > 1, which is still just "critical" — an over-spent line is a
 * data point, not an error state, and this function never throws on it.
 */
export function budgetPressure(usedUsd: number, capUsd: number | null): BudgetPressure {
  if (capUsd === null || capUsd <= 0) return "normal";
  const consumedRatio = usedUsd / capUsd;
  if (consumedRatio >= BUDGET_PRESSURE_CRITICAL_RATIO) return "critical";
  if (consumedRatio >= BUDGET_PRESSURE_WARNING_RATIO) return "warning";
  return "normal";
}
