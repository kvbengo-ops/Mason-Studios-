import type { JSX } from "react";
import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/format-usd";
import { shortDateLabel, type BurnPace } from "@/lib/burn";

// Pace colours are the theme's own tokens (muted / warning / destructive), so
// every theme answers them; the bars are currentColor and take the class.
export const PACE_CLASS: Record<BurnPace, string> = {
  none: "text-muted-foreground",
  normal: "text-muted-foreground",
  amber: "text-warning",
  red: "text-destructive",
};

export const PACE_LABEL: Record<BurnPace, string> = {
  none: "no spend",
  normal: "normal pace",
  amber: "on pace to pass the weekly total",
  red: "at or over the weekly total",
};

/** One bar per day, oldest first. Inline SVG, scaled to the busiest day. */
export function BurnSparkline({
  dates,
  values,
  pace,
  colorClass,
  barWidth = 6,
  height = 20,
  className,
}: {
  /** Manila day keys (`YYYY-MM-DD`), same length as `values`. */
  dates: readonly string[];
  values: readonly number[];
  pace: BurnPace;
  /** Replaces the pace colour, for a chart that has no weekly total to be paced against. */
  colorClass?: string;
  barWidth?: number;
  height?: number;
  className?: string;
}): JSX.Element {
  const max = Math.max(...values, 0);
  const gap = Math.max(2, Math.round(barWidth / 3));
  const width = values.length * (barWidth + gap) - gap;
  const label = `Daily spend, oldest first: ${values
    .map((usd, i) => `${shortDateLabel(dates[i]!)} ${formatUsd(usd)}`)
    .join(", ")}`;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("shrink-0", colorClass ?? PACE_CLASS[pace], className)}
    >
      {values.map((usd, i) => {
        // A day with no spend keeps a 1px stub so the row of 7 always reads as 7.
        const h = max > 0 && usd > 0 ? Math.max((usd / max) * height, 2) : 1;
        return (
          <rect
            key={dates[i]}
            x={i * (barWidth + gap)}
            y={height - h}
            width={barWidth}
            height={h}
            rx={1}
            fill="currentColor"
            opacity={usd > 0 ? 1 : 0.35}
          />
        );
      })}
    </svg>
  );
}

export interface UserBurn {
  dates: string[];
  days: number[];
  avgPerDay: number;
  pace: BurnPace;
}

/** The Burn cell: sparkline plus "$10.00/day", or "—" when there is no spend. */
export function BurnCell({ burn }: { burn: UserBurn | null }): JSX.Element {
  if (!burn || burn.pace === "none") {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center justify-end gap-2 tabular-nums",
        PACE_CLASS[burn.pace],
      )}
      title={PACE_LABEL[burn.pace]}
    >
      <BurnSparkline dates={burn.dates} values={burn.days} pace={burn.pace} />
      <span className="whitespace-nowrap">{formatUsd(burn.avgPerDay)}/day</span>
      <span className="sr-only">, {PACE_LABEL[burn.pace]}</span>
    </span>
  );
}
