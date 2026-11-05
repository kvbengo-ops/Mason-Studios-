// UTC-day-aligned date range helpers for /spend's date filter. Everything
// here works in UTC, matching this codebase's existing convention for "what
// day is it" (lib/spend.ts's own startOfTodayIso, spend/page.tsx's
// isSameUtcDay/isSameUtcMonth) — a spend total that flipped which day a run
// belonged to depending on the server's local timezone would be a much
// worse bug than the one this file is part of fixing.
//
// Pure date arithmetic, no Supabase/Next imports, so every case (a bad
// `?from=`, a range that spans a DST-observing local timezone the server
// might be running in, month rollover) is unit-testable without a request.

/** Midnight UTC on the same calendar day as `date`. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** `date` shifted by `days` (may be negative), preserving UTC-midnight alignment if `date` already was. */
export function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/** Midnight UTC on the first of `date`'s month. */
export function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** `date` shifted by `months` (may be negative), preserving day-of-month where possible. */
export function addUtcMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

/** Formats a Date as the `YYYY-MM-DD` string an `<input type="date">` expects, in UTC. */
export function toDateInputValue(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Parses a `?from=`/`?to=` search-param value (expected `YYYY-MM-DD`) into a
 * UTC-midnight Date. Anything that doesn't parse to a valid calendar date —
 * missing, malformed, the array Next.js hands back for a repeated key —
 * falls back to `fallback` rather than throwing or silently using an
 * `Invalid Date`, the same "don't 400 a hand-edited URL" reasoning as
 * lib/pagination.ts's parsePage.
 */
export function parseDateParam(raw: string | string[] | undefined, fallback: Date): Date {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return fallback;
  }
  // Fixed-position slicing, not `.split("-").map(Number)` destructuring —
  // with noUncheckedIndexedAccess on, TS types every element of a
  // variable-length array access as possibly `undefined` even right after
  // the regex test above proves there are exactly 3 numeric parts. Slicing
  // a string always returns `string`, so this sidesteps that without a
  // non-null assertion.
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC silently rolls an out-of-range day/month into the next
  // month/year (e.g. 2026-02-30 becomes March 2nd) instead of failing —
  // round-tripping back through toDateInputValue and comparing catches
  // that instead of accepting a range boundary the user never typed.
  return toDateInputValue(parsed) === value ? parsed : fallback;
}

export interface DateRange {
  /** Inclusive, UTC-midnight-aligned. */
  from: Date;
  /** Inclusive, UTC-midnight-aligned — the LAST day included, not an exclusive bound. */
  to: Date;
}

/** The default /spend range: the last 30 calendar days, today included. */
export function defaultSpendRange(now: Date): DateRange {
  const today = startOfUtcDay(now);
  return { from: addUtcDays(today, -29), to: today };
}
