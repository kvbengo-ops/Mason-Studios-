/** Cookie holding when this admin last cleared the Accounts Control runs table. */
export const RUNS_CLEARED_COOKIE = "ac_runs_cleared_at";

/** The cleared-at timestamp, or null when unset or not a date. */
export function parseRunsClearedAt(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}
