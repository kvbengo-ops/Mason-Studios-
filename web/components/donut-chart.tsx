import type { JSX } from "react";
import { formatUsd } from "@/lib/format-usd";
import { cn } from "@/lib/utils";

// Literal class names so Tailwind generates them; colours cycle past five.
const DONUT_STROKES = [
  "stroke-chart-1",
  "stroke-chart-2",
  "stroke-chart-3",
  "stroke-chart-4",
  "stroke-chart-5",
];
const DONUT_DOTS = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];

export interface DonutSlice {
  label: string;
  valueUsd: number;
  /** Small line under the value in the legend ("12 runs"). */
  sub?: string;
}

/** Dollar share as a donut, total in the centre, legend beside it. */
export function DonutChart({
  slices,
  centreSub,
  ariaLabel,
}: {
  slices: readonly DonutSlice[];
  /** Small line under the centre total. */
  centreSub?: string;
  /** Prefix for the chart's accessible name; the numbers are appended. */
  ariaLabel: string;
}): JSX.Element {
  const totalUsd = slices.reduce((sum, s) => sum + s.valueUsd, 0);
  const shares = slices.map((s) => (totalUsd > 0 ? (s.valueUsd / totalUsd) * 100 : 0));
  const label = `${ariaLabel}: ${formatUsd(totalUsd)} total${slices
    .map((s, i) => `, ${s.label} ${formatUsd(s.valueUsd)} (${Math.round(shares[i] ?? 0)}%)`)
    .join("")}`;
  return (
    <div className="flex flex-col items-center gap-8 sm:flex-row sm:items-center">
      {/* r = 15.915 makes the circumference 100, so a dash length is a percentage. */}
      <div role="img" aria-label={label} className="relative size-48 shrink-0">
        <svg aria-hidden="true" viewBox="0 0 42 42" className="size-full -rotate-90">
          <circle cx={21} cy={21} r={15.915} fill="none" strokeWidth={6} className="stroke-muted" />
          {slices.map((s, i) => {
            const share = shares[i] ?? 0;
            // ponytail: O(n²) prefix sum, n is a handful of slices.
            const offset = -shares.slice(0, i).reduce((sum, v) => sum + v, 0);
            return share > 0 ? (
              <circle
                key={s.label}
                cx={21}
                cy={21}
                r={15.915}
                fill="none"
                strokeWidth={6}
                strokeDasharray={`${share} ${100 - share}`}
                strokeDashoffset={offset}
                className={DONUT_STROKES[i % DONUT_STROKES.length]}
              />
            ) : null;
          })}
        </svg>
        <div
          aria-hidden="true"
          className="absolute inset-0 flex flex-col items-center justify-center text-center"
        >
          <span className="text-2xl font-semibold tracking-tight tabular-nums">
            {formatUsd(totalUsd)}
          </span>
          {centreSub ? <span className="text-xs text-muted-foreground">{centreSub}</span> : null}
        </div>
      </div>
      <ul className="grid w-full grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
        {slices.map((s, i) => (
          <li key={s.label} className="flex min-w-0 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn("size-2 shrink-0 rounded-full", DONUT_DOTS[i % DONUT_DOTS.length])}
              />
              <span className="truncate" title={s.label}>
                {s.label}
              </span>
            </span>
            <span className="text-base font-semibold tabular-nums">{formatUsd(s.valueUsd)}</span>
            {s.sub ? (
              <span className="text-[11px] tabular-nums text-muted-foreground">{s.sub}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
