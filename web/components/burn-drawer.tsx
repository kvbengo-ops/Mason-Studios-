"use client";

// The per-account burn drawer on /users: a right-hand panel, not a page, so the
// list stays visible behind it. Opened from the row's ⋯ menu (user-row-actions).
// The data is read when it opens, and again when the 14/30 switch moves, through
// getAccountBurn (admin-guarded); the header figures come from the row.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import Link from "next/link";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import {
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { RoleBadge } from "@/components/role-badge";
import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/format-usd";
import { computeBurn, shortDateLabel, weekdayLabel } from "@/lib/burn";
import { getAccountBurn, type AccountBurnDetail, type BurnWindowDays } from "@/actions/burn";
import type { ProfileRole } from "@/types/db";

export interface BurnDrawerAccount {
  userId: string;
  email: string;
  role: ProfileRole;
  /** Spend since Monday (account_spend_windows). */
  weekSpentUsd: number;
  /** Weekly cap plus active grants; null when the caps could not be resolved. */
  weekTotalUsd: number | null;
  /** The daily allowance, only when this account's daily limit is switched on. */
  dailyAllowanceUsd: number | null;
}

const CHART_W = 336;
const CHART_H = 120;

function DailyChart({
  dates,
  days,
  dailyAllowanceUsd,
}: {
  dates: readonly string[];
  days: readonly number[];
  dailyAllowanceUsd: number | null;
}): JSX.Element {
  const max = Math.max(...days, dailyAllowanceUsd ?? 0, 0);
  const step = CHART_W / days.length;
  const barW = Math.max(step - (days.length > 14 ? 2 : 4), 1);
  const y = (usd: number): number => CHART_H - (max > 0 ? (usd / max) * CHART_H : 0);
  const total = days.reduce((sum, usd) => sum + usd, 0);
  const peak = Math.max(...days, 0);
  return (
    <div className="flex flex-col gap-1">
      <svg
        role="img"
        aria-label={`Daily spend over the last ${days.length} days: ${formatUsd(total)} in total, busiest day ${formatUsd(peak)}${dailyAllowanceUsd === null ? "" : `, daily allowance ${formatUsd(dailyAllowanceUsd)}`}`}
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="h-32 w-full text-chart-1"
        preserveAspectRatio="none"
      >
        {days.map((usd, i) => (
          <rect
            key={dates[i]}
            x={i * step + (step - barW) / 2}
            y={usd > 0 ? Math.min(y(usd), CHART_H - 2) : CHART_H - 1}
            width={barW}
            height={usd > 0 ? Math.max(CHART_H - y(usd), 2) : 1}
            rx={1}
            fill="currentColor"
            opacity={usd > 0 ? 1 : 0.35}
          />
        ))}
        {dailyAllowanceUsd !== null ? (
          <line
            data-testid="daily-allowance-line"
            x1={0}
            x2={CHART_W}
            y1={y(dailyAllowanceUsd)}
            y2={y(dailyAllowanceUsd)}
            stroke="currentColor"
            strokeDasharray="4 3"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            className="text-foreground"
          />
        ) : null}
      </svg>
      <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
        <span>{shortDateLabel(dates[0]!)}</span>
        {dailyAllowanceUsd !== null ? (
          <span>- - - daily allowance {formatUsd(dailyAllowanceUsd)}</span>
        ) : null}
        <span>{shortDateLabel(dates[dates.length - 1]!)}</span>
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

/** Everything inside the drawer; pure, so it renders from fixture data. */
export function BurnDrawerBody({
  account,
  detail,
  windowDays,
  onWindowChange,
  status,
  now = new Date(),
}: {
  account: BurnDrawerAccount;
  detail: AccountBurnDetail | null;
  windowDays: BurnWindowDays;
  onWindowChange: (days: BurnWindowDays) => void;
  status: "loading" | "error" | "ready";
  now?: Date;
}): JSX.Element {
  const figures = detail
    ? computeBurn({
        days: detail.days,
        weekSpentUsd: account.weekSpentUsd,
        weekTotalUsd: account.weekTotalUsd,
        now,
      })
    : null;
  const reach =
    figures === null || account.weekTotalUsd === null
      ? "—"
      : figures.reachKey === null
        ? "not this week"
        : `${weekdayLabel(figures.reachKey)} ${shortDateLabel(figures.reachKey)}`;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1 pr-6">
        <DialogTitle className="break-all">{account.email}</DialogTitle>
        <DialogDescription asChild>
          <div className="flex flex-wrap items-center gap-2 tabular-nums">
            <RoleBadge role={account.role} />
            <span>
              {formatUsd(account.weekSpentUsd)}
              {account.weekTotalUsd === null ? "" : ` of ${formatUsd(account.weekTotalUsd)}`} this
              week
            </span>
          </div>
        </DialogDescription>
      </header>

      <section aria-label="Daily spend" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Daily spend</h3>
          <div
            role="group"
            aria-label="Chart range"
            className="flex rounded-md border border-border"
          >
            {([14, 30] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={windowDays === option}
                onClick={() => onWindowChange(option)}
                className={cn(
                  "px-3 py-1 text-xs tabular-nums first:rounded-l-md last:rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  windowDays === option
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option} days
              </button>
            ))}
          </div>
        </div>
        {status === "error" ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load this account&apos;s spend. Close the panel and try again.
          </p>
        ) : detail ? (
          <DailyChart
            dates={detail.dates}
            days={detail.days}
            dailyAllowanceUsd={account.dailyAllowanceUsd}
          />
        ) : (
          <div className="h-32 animate-pulse rounded-md bg-muted" aria-label="Loading" />
        )}
      </section>

      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Figure
          label={`Avg per day (${windowDays}d)`}
          value={figures ? formatUsd(figures.avgPerDay) : "—"}
        />
        <Figure
          label="Projected week"
          value={figures ? formatUsd(figures.projectedWeekUsd) : "—"}
        />
        <Figure label="Reaches weekly total" value={reach} />
      </dl>

      <section aria-label="Spend by model" className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Spend by model · {windowDays} days</h3>
        {detail && detail.models.length === 0 ? (
          <p className="text-sm text-muted-foreground">No spend in this window.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {(detail?.models ?? []).map((model) => (
              <li key={model.label} className="flex items-baseline justify-between gap-3 py-2">
                <span className="min-w-0 truncate text-foreground">{model.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatUsd(model.costUsd)} · {model.runs} {model.runs === 1 ? "run" : "runs"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Link
        href={`/accounts-control?view=accounts&user=${account.userId}`}
        className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
      >
        Open in Accounts Control
      </Link>
    </div>
  );
}

export function BurnDrawer({
  account,
  open,
  onOpenChange,
}: {
  account: BurnDrawerAccount;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [windowDays, setWindowDays] = useState<BurnWindowDays>(14);
  const [detail, setDetail] = useState<AccountBurnDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");

  // The panel mounts fresh for each account, so "loading" is only re-entered here.
  function changeWindow(next: BurnWindowDays): void {
    setStatus("loading");
    setWindowDays(next);
  }

  useEffect(() => {
    if (!open) return;
    let stale = false;
    getAccountBurn(account.userId, windowDays)
      .then((result) => {
        if (stale) return;
        if ("error" in result) {
          setStatus("error");
        } else {
          setDetail(result.detail);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!stale) setStatus("error");
      });
    return () => {
      stale = true;
    };
  }, [open, account.userId, windowDays]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right fixed inset-y-0 right-0 z-50 flex w-full flex-col gap-4 overflow-y-auto border-l bg-background p-6 shadow-2xl shadow-black/10 duration-200 sm:max-w-md">
          <BurnDrawerBody
            account={account}
            detail={detail}
            windowDays={windowDays}
            onWindowChange={changeWindow}
            status={status}
          />
          <DialogPrimitive.Close className="ring-offset-background focus:ring-ring absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}
