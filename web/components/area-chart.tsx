"use client";

import { useId, useState, type JSX, type KeyboardEvent, type PointerEvent } from "react";
import { formatUsd } from "@/lib/format-usd";
import { cn } from "@/lib/utils";

export interface AreaPoint {
  /** `YYYY-MM-DD`, or any unique key when `label` is given. */
  date: string;
  /** Shown instead of the formatted date (an hour or a month bucket). */
  label?: string;
  valueUsd: number;
  /** Optional breakdown shown in the tooltip and accessible name ("Video $4.00"). */
  details?: readonly { label: string; valueUsd: number }[];
}

const detailText = (p: AreaPoint): string =>
  p.details?.length
    ? ` (${p.details.map((d) => `${d.label} ${formatUsd(d.valueUsd)}`).join(", ")})`
    : "";

const W = 600;
const H = 160;
const TOP_PAD = 8;

const dayLabel = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const fmtDate = (key: string): string => dayLabel.format(new Date(`${key}T00:00:00Z`));
const fmtDay = (p: AreaPoint): string => p.label ?? fmtDate(p.date);

/**
 * Dollars per day as a line with a soft gradient fill. The tooltip follows
 * the pointer and is keyboard reachable: focus the chart, then use the arrow
 * keys (Home/End jump to the ends). The accessible name carries every number.
 */
export function AreaChart({
  points,
  ariaLabel,
  className,
  heightClass = "h-40",
}: {
  points: readonly AreaPoint[];
  /** Prefix for the accessible name; the per-day numbers are appended. */
  ariaLabel: string;
  className?: string;
  /** Height of the plot area. */
  heightClass?: string;
}): JSX.Element {
  const gradientId = `area-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [active, setActive] = useState<number | null>(null);
  const n = points.length;
  const peak = Math.max(...points.map((p) => p.valueUsd), 0);
  const max = peak || 1;
  const xPct = (i: number): number => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const yPct = (v: number): number => ((H - (v / max) * (H - TOP_PAD)) / H) * 100;
  const coords = points.map((p, i) => `${(xPct(i) / 100) * W},${(yPct(p.valueUsd) / 100) * H}`);
  const line = `M${coords.join(" L")}`;
  const area = `M0,${H} L${coords.join(" L")} L${W},${H} Z`;
  const label = `${ariaLabel}: ${points.map((p) => `${fmtDay(p)} ${formatUsd(p.valueUsd)}${detailText(p)}`).join(", ")}`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (n === 0) return;
    const current = active ?? n - 1;
    const next =
      e.key === "ArrowLeft"
        ? Math.max(0, current - 1)
        : e.key === "ArrowRight"
          ? Math.min(n - 1, current + 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : e.key === "Escape"
                ? null
                : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    setActive(Math.min(n - 1, Math.max(0, Math.round(ratio * (n - 1)))));
  };

  const point = active !== null ? points[active] : undefined;
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div
        tabIndex={0}
        role="group"
        aria-label={`${ariaLabel}. Use the arrow keys to read each point.`}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((a) => a ?? n - 1)}
        onBlur={() => setActive(null)}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setActive(null)}
        className={cn(
          "relative w-full rounded-md text-chart-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          heightClass,
        )}
      >
        <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="size-full overflow-visible"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.35} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1={0}
              x2={W}
              y1={H * f}
              y2={H * f}
              className="stroke-border"
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {n > 0 ? (
            <>
              <path d={area} fill={`url(#${gradientId})`} />
              <path
                d={line}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </>
          ) : null}
        </svg>
        {point && active !== null ? (
          <>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 w-px bg-border"
              style={{ left: `${xPct(active)}%` }}
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-chart-1 ring-2 ring-card"
              style={{ left: `${xPct(active)}%`, top: `${yPct(point.valueUsd)}%` }}
            />
            <div
              role="status"
              className={cn(
                "pointer-events-none absolute top-0 z-10 -translate-y-full whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md",
                xPct(active) > 70
                  ? "-translate-x-full"
                  : xPct(active) > 30
                    ? "-translate-x-1/2"
                    : "",
              )}
              style={{ left: `${xPct(active)}%` }}
            >
              <span className="text-muted-foreground">{fmtDay(point)}</span>{" "}
              <span className="font-semibold tabular-nums">{formatUsd(point.valueUsd)}</span>
              {point.details?.map((d) => (
                <span key={d.label} className="block tabular-nums text-muted-foreground">
                  {d.label} {formatUsd(d.valueUsd)}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </div>
      {n > 0 ? (
        <div
          aria-hidden="true"
          className="flex justify-between text-[11px] tabular-nums text-muted-foreground"
        >
          <span>{fmtDay(points[0]!)}</span>
          <span>Peak {formatUsd(peak)}</span>
          <span>{fmtDay(points[n - 1]!)}</span>
        </div>
      ) : null}
    </div>
  );
}
