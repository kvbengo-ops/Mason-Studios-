"use client";

// Click the allowance box → the caller's own spending, run by run. Defaults to
// this allowance week (Monday 00:00 Manila, the window the box counts), so the
// total shown first is exactly what the box has used.

import type { JSX, ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  loadMySpendBreakdown,
  type SpendKind,
  type SpendRow,
} from "@/actions/spend-breakdown";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/spinner";
import { dateTimeFormatter } from "@/lib/datetime";
import { formatAllowanceAmount, type AllowanceDisplayUnit } from "@/lib/format-usd";

type Period = "week" | "last-week" | "30d" | "custom";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A yyyy-mm-dd date input, read as a Manila calendar day. */
function manilaDay(date: string, plusDays = 0): string {
  return new Date(new Date(`${date}T00:00:00+08:00`).getTime() + plusDays * DAY_MS).toISOString();
}

export function SpendBreakdownDialog({
  children,
  weekStartIso,
  unit,
}: {
  children: ReactNode;
  /** Start of this allowance week, from the server (startOfManilaWeekIso). */
  weekStartIso: string;
  unit: AllowanceDisplayUnit;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // "Last 30 days" is measured from when the dialog opened, so the range (and
  // the fetch keyed on it) holds still while it is open.
  const [openedAt, setOpenedAt] = useState(0);
  const [period, setPeriod] = useState<Period>("week");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [kind, setKind] = useState<SpendKind | "all">("all");
  const [model, setModel] = useState("all");
  const [result, setResult] = useState<{ rows: SpendRow[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const weekStart = new Date(weekStartIso).getTime();
  const range: [string, string] | null =
    period === "week"
      ? [weekStartIso, new Date(weekStart + 7 * DAY_MS).toISOString()]
      : period === "last-week"
        ? [new Date(weekStart - 7 * DAY_MS).toISOString(), weekStartIso]
        : period === "30d"
          ? [new Date(openedAt - 30 * DAY_MS).toISOString(), new Date(openedAt + DAY_MS).toISOString()]
          : customFrom && customTo && customFrom <= customTo
            ? [manilaDay(customFrom), manilaDay(customTo, 1)]
            : null;
  const [fromIso, toIso] = range ?? ["", ""];

  /* eslint-disable react-hooks/set-state-in-effect -- clear the last range's rows before fetching the next. */
  useEffect(() => {
    if (!open || !fromIso) return;
    let current = true;
    setResult(null);
    setError(null);
    loadMySpendBreakdown(fromIso, toIso)
      .then((next) => current && setResult(next))
      .catch(() => current && setError("Could not load your spending. Try again."));
    return () => {
      current = false;
    };
  }, [open, fromIso, toIso]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const money = (usd: number): string => formatAllowanceAmount(usd, unit);
  const rows = (result?.rows ?? []).filter(
    (row) => (kind === "all" || row.kind === kind) && (model === "all" || row.model === model),
  );
  const total = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  const models = [...new Set((result?.rows ?? []).map((r) => r.model))].sort();

  const select =
    "h-9 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpenedAt(Date.now());
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="rounded-xl text-left transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Show my spending breakdown"
        >
          {children}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle>Your spending</DialogTitle>
        <DialogDescription>Weeks reset Monday, Manila time.</DialogDescription>

        <div className="flex flex-wrap gap-2">
          <select
            className={`${select} text-foreground`}
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
            aria-label="Period"
          >
            <option value="week" className="bg-popover text-popover-foreground">This week</option>
            <option value="last-week" className="bg-popover text-popover-foreground">Last week</option>
            <option value="30d" className="bg-popover text-popover-foreground">Last 30 days</option>
            <option value="custom" className="bg-popover text-popover-foreground">Custom dates</option>
          </select>
          {period === "custom" ? (
            <>
              <input
                type="date"
                className={select}
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                aria-label="From"
              />
              <input
                type="date"
                className={select}
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                aria-label="To"
              />
            </>
          ) : null}
          <select
            className={`${select} text-foreground`}
            value={kind}
            onChange={(e) => setKind(e.target.value as SpendKind | "all")}
            aria-label="Type"
          >
            <option value="all" className="bg-popover text-popover-foreground">All types</option>
            <option value="image" className="bg-popover text-popover-foreground">Images</option>
            <option value="video" className="bg-popover text-popover-foreground">Videos</option>
            <option value="other" className="bg-popover text-popover-foreground">Other</option>
          </select>
          <select
            className={`${select} text-foreground`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label="Model"
          >
            <option value="all" className="bg-popover text-popover-foreground">All models</option>
            {models.map((m) => (
              <option key={m} value={m} className="bg-popover text-popover-foreground">
                {m}
              </option>
            ))}
          </select>
        </div>

        {!range ? (
          <p className="text-sm text-muted-foreground">Pick a start and end date.</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !result ? (
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">Total spent</span>
              <span className="text-2xl font-semibold tabular-nums">{money(total)}</span>
            </p>

            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No spending in this period.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {rows.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-3 p-2 text-sm">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">
                        {row.model}
                        {row.failed ? " · Failed" : ""}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {dateTimeFormatter.format(new Date(row.createdAt))}
                      </span>
                    </div>
                    <span className="shrink-0 tabular-nums">
                      {row.costUsd !== null ? money(row.costUsd) : "Not billed"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {result.truncated ? (
              <p className="text-xs text-muted-foreground">
                Showing the newest 1,000 runs. Pick a shorter period to see the rest.
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
