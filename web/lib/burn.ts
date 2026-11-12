// Burn rate and pace — pure arithmetic, no I/O, no lib/spend import (that module
// throws at load on a malformed cap env var, and /users must still render then).
//
// Burn = average spend per Asia/Manila day over a window of days that ends today.
// Pace = that rate carried to the end of the current Manila week (Monday 00:00 to
// the next Monday 00:00) and compared with the account's weekly total (weekly cap
// plus active grants). All inputs are sums of runs.cost_usd; nothing here is a
// balance.
//
// Manila is a fixed UTC+8 with no DST (same reasoning as lib/spend.ts), so a day
// key is the instant shifted by +8h, read back as a UTC date.

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A spend day runs 05:00 to 05:00 Manila (0138, 0141). `spendDay(now)` is the
 * instant to hand to the day and week helpers below so they answer for the
 * spend day `now` is in: 03:00 Tuesday is still Monday.
 */
export const SPEND_DAY_SHIFT_MS = 5 * 60 * 60 * 1000;
export function spendDay(now: Date): Date {
  return new Date(now.getTime() - SPEND_DAY_SHIFT_MS);
}

export type BurnPace = "none" | "normal" | "amber" | "red";

/** `YYYY-MM-DD` of the Manila calendar day `instant` falls on. */
export function manilaDayKey(instant: Date): string {
  return new Date(instant.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

function keyToUtcMs(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

function addDaysToKey(key: string, days: number): string {
  return new Date(keyToUtcMs(key) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The last `days` Manila day keys, oldest first, the last one being today. */
export function manilaDayKeys(now: Date, days: number): string[] {
  const today = manilaDayKey(now);
  return Array.from({ length: days }, (_, i) => addDaysToKey(today, i - (days - 1)));
}

/** UTC instant of Manila midnight on the first of the last `days` days. */
export function manilaWindowStartIso(now: Date, days: number): string {
  const first = manilaDayKeys(now, days)[0]!;
  return new Date(keyToUtcMs(first) - MANILA_OFFSET_MS).toISOString();
}

/** UTC instant of Manila midnight tomorrow: the exclusive end of every window. */
export function manilaWindowEndIso(now: Date): string {
  return new Date(keyToUtcMs(addDaysToKey(manilaDayKey(now), 1)) - MANILA_OFFSET_MS).toISOString();
}

/** Where `now` sits in its Manila week: Monday is 1, Sunday is 7. */
export function manilaWeekPosition(now: Date): {
  weekStartKey: string;
  /** 1-7, today included. */
  dayOfWeek: number;
  /** Whole days after today up to and including Sunday. */
  daysLeft: number;
} {
  const today = manilaDayKey(now);
  const weekday = new Date(keyToUtcMs(today)).getUTCDay(); // 0 = Sunday
  const dayOfWeek = ((weekday + 6) % 7) + 1;
  return { weekStartKey: addDaysToKey(today, 1 - dayOfWeek), dayOfWeek, daysLeft: 7 - dayOfWeek };
}

/** Spend per day over `keys`; a day with no row is 0. */
export function fillDays(
  rows: readonly { day: string; total_usd: number }[],
  keys: readonly string[],
): number[] {
  const byDay = new Map<string, number>();
  for (const row of rows) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.total_usd);
  return keys.map((key) => byDay.get(key) ?? 0);
}

/** Spend since Monday, from per-day values that end today (needs at least a week's worth, or whatever is there). */
export function weekSpentFromDays(days: readonly number[], now: Date): number {
  return days.slice(-manilaWeekPosition(now).dayOfWeek).reduce((sum, usd) => sum + usd, 0);
}

export interface BurnFigures {
  /** Average spend per day over the window. */
  avgPerDay: number;
  /** Spend so far this week plus the average for each day still to come. */
  projectedWeekUsd: number;
  /** The Manila day (`YYYY-MM-DD`) the weekly total is reached at this pace; null = not this week. */
  reachKey: string | null;
  pace: BurnPace;
}

/**
 * `days`: spend per Manila day, oldest first, ending today. `weekSpentUsd`:
 * spend since Monday. `weekTotalUsd`: weekly cap plus active grants, null when
 * it could not be resolved (the pace is then "normal", never a guess).
 *
 * ponytail: today counts as a whole day in the average and the days still to
 * come are whole days, so a part-way day is neither pro-rated nor extrapolated.
 */
export function computeBurn({
  days,
  weekSpentUsd,
  weekTotalUsd,
  now,
}: {
  days: readonly number[];
  weekSpentUsd: number;
  weekTotalUsd: number | null;
  now: Date;
}): BurnFigures {
  const windowTotal = days.reduce((sum, usd) => sum + usd, 0);
  const avgPerDay = days.length > 0 ? windowTotal / days.length : 0;
  const { daysLeft } = manilaWeekPosition(now);
  const projectedWeekUsd = weekSpentUsd + avgPerDay * daysLeft;
  const today = manilaDayKey(now);

  let reachKey: string | null = null;
  if (weekTotalUsd !== null) {
    if (weekSpentUsd >= weekTotalUsd) {
      reachKey = today;
    } else if (avgPerDay > 0) {
      const daysNeeded = Math.ceil((weekTotalUsd - weekSpentUsd) / avgPerDay);
      if (daysNeeded <= daysLeft) reachKey = addDaysToKey(today, daysNeeded);
    }
  }

  let pace: BurnPace = "normal";
  if (windowTotal <= 0 && weekSpentUsd <= 0) pace = "none";
  else if (weekTotalUsd !== null && weekSpentUsd >= weekTotalUsd) pace = "red";
  else if (weekTotalUsd !== null && projectedWeekUsd > weekTotalUsd) pace = "amber";

  return { avgPerDay, projectedWeekUsd, reachKey, pace };
}

/** "Wed" for a `YYYY-MM-DD` Manila day key. */
export function weekdayLabel(key: string): string {
  return new Date(keyToUtcMs(key)).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
}

/** "Nov 9" for a `YYYY-MM-DD` Manila day key. */
export function shortDateLabel(key: string): string {
  return new Date(keyToUtcMs(key)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
