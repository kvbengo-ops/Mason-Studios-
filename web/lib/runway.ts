// Runway — Part 3 of the task that added this file: "$27 left" means
// nothing on its own; "6 days left at the current rate" is what tells an
// admin to act. This file is the pure arithmetic (burn rate -> days left),
// unit-testable without a live database or a real kie balance — the same
// reason lib/spend.ts pulls its own cap arithmetic out of the async reads
// that feed it.
//
// ---------------------------------------------------------------------------
// The trailing window — 7 days, not a calendar week
// ---------------------------------------------------------------------------
// lib/spend.ts's weekly ALLOWANCE is a calendar week (Monday reset,
// deliberately, per that file's own header) because an allowance is a
// periodic grant an editor reasons about against a fixed reset point.
// Runway is a different question — "at the CURRENT rate, how long until
// this runs out" — which wants a rolling window, not a calendar one: on a
// Tuesday, "since Monday" is one day of data and would make Monday's whole
// week's spend look like a one-day burn rate the moment the week resets.
// A trailing 7-day window is always a full week of data regardless of what
// day it is, so the rate it produces does not jump around depending on
// where "today" happens to fall in the calendar week. 7 days (not 3, not
// 30) because it is long enough to smooth over the "one big render day"
// spikes docs/architecture.md's own cost model describes (a single ad can
// be $1.46-$19+ depending on model/scene count) without being so long that
// a real, recent change in burn rate (a new editor onboarded, a project
// finished) takes weeks to show up in the number.
export const RUNWAY_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// The warning threshold — 3 days
// ---------------------------------------------------------------------------
// Half of RUNWAY_WINDOW_DAYS, not a separate arbitrary figure: an admin
// looking at a 7-day trailing burn rate has, by construction, at most a
// 7-day-old picture of spend. If runway drops under 3 days, the account can
// run dry BEFORE the measurement window that produced the estimate even
// finishes rolling over once more — there is no comfortable margin left to
// notice a further acceleration in burn before the account actually hits
// zero. 3 days is also enough real lead time for an admin to fund the
// account (a manual, human action — this is not an automated top-up) without
// being so twitchy that ordinary week-to-week variance in burn trips the
// warning every few days and trains admins to ignore it.
export const RUNWAY_WARNING_THRESHOLD_DAYS = 3;

/**
 * The three states an estimate can be in — deliberately not a single
 * `number | null`, because "the balance is unknown" (KIE_API_KEY unset,
 * or any lib/kie-balance.ts read failure) and "there has been no spend in
 * the window" (dailyBurnUsd === 0) are different facts that need different
 * words on screen: the first means "we can't tell you", the second means
 * "there is nothing to divide by" (which is NOT the same as "runway is
 * infinite" — a zero-burn window says nothing about tomorrow's burn, so
 * this deliberately does not render as "∞ days" or any other implied
 * promise). Collapsing either into a bare `null` is exactly the shape that
 * produces `Infinity`/`NaN` on screen the day someone forgets which `null`
 * meant what.
 */
export type RunwayEstimate =
  { status: "unknown" } | { status: "no-burn" } | { status: "ok"; days: number };

/**
 * `balanceUsd` — lib/kie-balance.ts's getKieAccountBalanceUsd result,
 * `null` handled as an ordinary state (see that file's header), never
 * coerced to 0.
 * `trailingSpendUsd` — team-wide `runs.cost_usd` summed over the trailing
 * `windowDays` (spend_total_usd, 0026_cost_aggregates.sql — kie's balance
 * is one account shared by the whole team, so burn is computed team-wide,
 * not per-user, to match what it's being compared against).
 *
 * Division only ever happens in the "ok" branch, once dailyBurnUsd is
 * already known to be finite and > 0 — balanceUsd is finite by construction
 * (getKieAccountBalanceUsd rejects any non-finite value before caching it,
 * see that file's own numeric check), so there is no path to Infinity or
 * NaN here.
 */
export function computeRunway(
  balanceUsd: number | null,
  trailingSpendUsd: number,
  windowDays: number = RUNWAY_WINDOW_DAYS,
): RunwayEstimate {
  if (balanceUsd === null) return { status: "unknown" };

  const dailyBurnUsd = trailingSpendUsd / windowDays;
  if (dailyBurnUsd <= 0) return { status: "no-burn" };

  return { status: "ok", days: balanceUsd / dailyBurnUsd };
}

/**
 * Whether an "ok" runway estimate is short enough to warn an admin about.
 * `< thresholdDays`, not `<=` — landing exactly on the threshold still
 * leaves the full margin the threshold was chosen to guarantee (same
 * "exactly at the boundary is fine, going past it is not" convention
 * lib/spend.ts's assertCapNotExceeded family uses). "unknown"/"no-burn"
 * never warn: there is nothing actionable to tell an admin ("fund the
 * account" is not a more useful message than "we don't know" or "nothing
 * has been spent"), and see runwayCardTone below for why "unknown" still
 * gets its own, non-alarming visual treatment rather than silence.
 */
export function isRunwayShort(
  estimate: RunwayEstimate,
  thresholdDays: number = RUNWAY_WARNING_THRESHOLD_DAYS,
): boolean {
  return estimate.status === "ok" && estimate.days < thresholdDays;
}

/**
 * Human-readable runway, for the one place this is displayed (/spend).
 * Rounds to whole days ("6 days left") — sub-day precision would imply an
 * accuracy this estimate does not have (a 7-day trailing average is
 * already a smoothed figure, not a live rate), and "<1 day" is its own
 * explicit branch rather than rounding down to "0 days", which reads as
 * "already out" when the account may still have hours of runway left.
 */
export function formatRunwayDays(estimate: RunwayEstimate): string {
  switch (estimate.status) {
    case "unknown":
      return "Unknown";
    case "no-burn":
      return `No spend in the last ${RUNWAY_WINDOW_DAYS} days`;
    case "ok": {
      if (estimate.days < 1) return "Less than 1 day";
      const rounded = Math.round(estimate.days);
      return `${rounded} ${rounded === 1 ? "day" : "days"}`;
    }
  }
}
