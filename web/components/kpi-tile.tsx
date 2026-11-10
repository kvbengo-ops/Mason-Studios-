import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from "lucide-react";
import { formatUsd } from "@/lib/format-usd";
import type { PeriodChange } from "@/lib/period-change";
import { cn } from "@/lib/utils";

export const PANEL = "min-w-0 rounded-2xl border border-border/70 bg-card";

/**
 * A dashboard number: label + icon, the value, a sub line, optional extra
 * content (an avatar stack) and an optional link. With `href` the whole tile
 * is the link; `active` marks it as the filter currently applied.
 */
export function KpiTile({
  label,
  value,
  sub,
  alert = false,
  icon: Icon,
  href,
  active = false,
  compact = false,
  children,
}: {
  label: string;
  value: string;
  sub: ReactNode;
  alert?: boolean;
  icon: LucideIcon;
  href?: string;
  active?: boolean;
  /** Smaller padding and number, for a row of secondary stats. */
  compact?: boolean;
  children?: ReactNode;
}): JSX.Element {
  const className = cn(
    PANEL,
    "relative flex flex-col",
    compact ? "gap-2 p-4" : "gap-3 p-5 sm:p-6",
    alert && "border-destructive/40",
    href &&
      "transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active && "ring-2 ring-primary",
  );
  const body = (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        <span
          className={cn(
            "grid place-items-center rounded-xl",
            compact ? "size-7" : "size-9",
            alert ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary",
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
        </span>
      </div>
      <span
        className={cn(
          "font-semibold tracking-tight tabular-nums",
          compact ? "text-2xl" : "text-3xl",
        )}
      >
        {value}
      </span>
      {children}
      <span
        className={cn(
          "text-xs tabular-nums",
          alert ? "font-medium text-destructive" : "text-muted-foreground",
        )}
      >
        {sub}
      </span>
    </>
  );
  return href ? (
    <Link href={href} className={className} aria-current={active ? "true" : undefined}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/**
 * "↑ 12% vs last week". Spend going up is red, down is green, flat is muted —
 * the honest direction for a cost, not a growth metric.
 */
export function ChangeLine({
  change,
  vs,
}: {
  change: PeriodChange | null;
  /** "last week", "yesterday"… */
  vs: string;
}): JSX.Element {
  if (change === null) return <span className="text-muted-foreground">No comparison available</span>;
  if (change.direction === "flat") {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Minus aria-hidden="true" className="size-3" />
        No change vs {vs}
      </span>
    );
  }
  const up = change.direction === "up";
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  const amount =
    change.pct !== null
      ? `${Math.abs(change.pct).toFixed(Math.abs(change.pct) < 10 ? 1 : 0)}%`
      : formatUsd(Math.abs(change.deltaUsd));
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-medium",
        up ? "text-destructive" : "text-success",
      )}
    >
      <Arrow aria-hidden="true" className="size-3" />
      <span className="sr-only">{up ? "Up" : "Down"}</span>
      {amount} vs {vs}
    </span>
  );
}
