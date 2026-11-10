import Link from "next/link";
import type { JSX } from "react";
import { BurnSparkline } from "@/components/burn-cell";
import { formatUsd } from "@/lib/format-usd";
import { manilaWeekPosition, weekSpentFromDays } from "@/lib/burn";

/**
 * "$412 this week · $59/day avg · on pace for $640 by Sunday", with the team's
 * last 7 days as bars. The whole strip is one link to Accounts Control. Same
 * shell as UserPresenceStrip, right above it. `days` is null when the read
 * failed (never rendered as $0).
 */
export function TeamBurnStrip({
  dates,
  days,
  now,
}: {
  /** Manila day keys, oldest first, ending today. */
  dates: readonly string[];
  /** Whole-team spend per day, archived accounts included. */
  days: readonly number[] | null;
  now: Date;
}): JSX.Element {
  const shell =
    "flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card px-5 py-4 sm:min-h-20 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6";
  if (days === null) {
    return (
      <div className="rounded-lg border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
        Team spend is temporarily unavailable.
      </div>
    );
  }

  const weekSpentUsd = weekSpentFromDays(days, now);
  const avgPerDay = days.reduce((sum, usd) => sum + usd, 0) / days.length;
  const projectedUsd = weekSpentUsd + avgPerDay * manilaWeekPosition(now).daysLeft;

  return (
    <Link
      href="/accounts-control"
      className={`${shell} transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm tabular-nums">
          <span className="font-semibold text-foreground">{formatUsd(weekSpentUsd)} this week</span>
          <span className="text-muted-foreground">
            {" · "}
            {formatUsd(avgPerDay)}/day avg
            {" · "}
            on pace for {formatUsd(projectedUsd)} by Sunday
          </span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Whole team, last 7 days · deactivated accounts included
        </p>
      </div>
      <BurnSparkline
        dates={dates}
        values={days}
        pace="normal"
        colorClass="text-chart-1"
        barWidth={14}
        height={32}
      />
    </Link>
  );
}
