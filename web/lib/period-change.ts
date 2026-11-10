// Change-versus-previous-period and the "near weekly cap" rule — pure
// arithmetic, no I/O, no lib/spend import (that module throws at load on a
// malformed cap env var, and the admin dashboards must still render then).
// Every input is a sum of runs.cost_usd; nothing here is a balance.

import { manilaWeekPosition } from "@/lib/burn";

export type ChangeDirection = "up" | "down" | "flat";

export interface PeriodChange {
  direction: ChangeDirection;
  /** current - previous, in dollars. */
  deltaUsd: number;
  /** Percent change; null when the previous period was $0 (no base to divide by). */
  pct: number | null;
}

/** Below half a cent either way reads as no change — formatUsd would print the same number. */
const FLAT_EPSILON_USD = 0.005;

export function periodChange(currentUsd: number, previousUsd: number): PeriodChange {
  const deltaUsd = currentUsd - previousUsd;
  const direction: ChangeDirection =
    Math.abs(deltaUsd) < FLAT_EPSILON_USD ? "flat" : deltaUsd > 0 ? "up" : "down";
  const pct =
    previousUsd >= FLAT_EPSILON_USD && direction !== "flat"
      ? (deltaUsd / previousUsd) * 100
      : null;
  return { direction, deltaUsd: direction === "flat" ? 0 : deltaUsd, pct };
}

/**
 * This Manila week so far against the SAME number of days at the start of
 * last week (Monday..today vs last Monday..same weekday) — like for like, so
 * a Tuesday is never compared with a whole previous week. `days` is per-day
 * spend, oldest first, ending today; it needs at least 14 entries.
 */
export function weekToDateChange(
  days: readonly number[],
  now: Date,
): { currentUsd: number; previousUsd: number; change: PeriodChange } {
  if (days.length < 14) throw new Error("weekToDateChange needs at least 14 days");
  const { dayOfWeek } = manilaWeekPosition(now);
  const sum = (xs: readonly number[]): number => xs.reduce((s, v) => s + v, 0);
  const currentUsd = sum(days.slice(days.length - dayOfWeek));
  const previousUsd = sum(days.slice(days.length - 7 - dayOfWeek, days.length - 7));
  return { currentUsd, previousUsd, change: periodChange(currentUsd, previousUsd) };
}

/** At or above this share of the weekly total (cap + active grants) counts as near the cap. */
export const NEAR_CAP_RATIO = 0.8;

/**
 * Near (or over) the weekly cap: spent at least 80% of cap + active grants.
 * An account that spent nothing is never near, so a $0 cap with no spend is
 * not flagged; one that spent anything against a $0 total is over it.
 */
export function isNearWeeklyCap(spentThisWeekUsd: number, weeklyTotalUsd: number): boolean {
  return spentThisWeekUsd > 0 && spentThisWeekUsd >= NEAR_CAP_RATIO * weeklyTotalUsd;
}
