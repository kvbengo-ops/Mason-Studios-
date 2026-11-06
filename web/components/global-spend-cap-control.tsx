"use client";

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { SlidersHorizontal, XIcon } from "lucide-react";
import { setGlobalSpendCap } from "@/actions/account";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PendingButton } from "@/components/pending-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { creditsToUsd, formatCredits, usdToCredits } from "@/lib/format-usd";
import type { GlobalSpendCapPeriod, GlobalSpendCapSettings } from "@/lib/spend";
import { cn } from "@/lib/utils";

const GAUGE_ARC = "M8 52 A42 42 0 0 1 92 52";

/**
 * The "Team cap used" KPI tile: a half-circle gauge of team spend against the
 * global cap, with the limit's form folded inside behind a toggle.
 */
export function GlobalSpendCapControl({
  settings,
  spentUsd,
}: {
  settings: GlobalSpendCapSettings;
  spentUsd: number;
}): JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(settings.enabled);
  const [period, setPeriod] = useState<GlobalSpendCapPeriod>(settings.period);
  const [credits, setCredits] = useState(String(Math.round(usdToCredits(settings.capUsd))));
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function save(): void {
    setMessage(null);
    const amount = Number(credits);
    if (!Number.isFinite(amount) || amount < 0) {
      setMessage("Enter zero or a positive credit limit.");
      return;
    }

    startTransition(async () => {
      try {
        const result = await setGlobalSpendCap(enabled, creditsToUsd(amount), period);
        if (result?.error) {
          setMessage(result.error);
          return;
        }
        setMessage("Global cap saved.");
        router.refresh();
      } catch (error) {
        unstable_rethrow(error);
        setMessage(error instanceof Error ? error.message : "Could not save the global cap.");
      }
    });
  }

  const periodLabel = settings.period === "daily" ? "today (Manila)" : "this week (Manila)";
  const pct = settings.capUsd > 0 ? (spentUsd / settings.capUsd) * 100 : spentUsd > 0 ? 100 : 0;
  const over = settings.enabled && pct >= 100;

  return (
    <section
      aria-label="Global spend cap"
      className={cn(
        // No overflow-hidden: the form floats out below the tile.
        "relative flex min-w-0 flex-col gap-3 rounded-2xl border border-border/70 bg-card p-5 sm:p-6",
        over && "border-destructive/40",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-sans text-sm font-medium text-muted-foreground">Team cap used</h2>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="global-cap-form"
          aria-label={open ? "Close team spending limit" : "Edit team spending limit"}
          title={open ? "Close" : "Edit limit"}
          className="grid size-9 place-items-center rounded-xl bg-primary/10 text-primary transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? (
            <XIcon aria-hidden="true" className="size-4" />
          ) : (
            <SlidersHorizontal aria-hidden="true" className="size-4" />
          )}
        </button>
      </div>
      <span className="text-3xl font-semibold tracking-tight tabular-nums">
        {settings.enabled ? `${Math.round(pct)}%` : "Off"}
      </span>
      <span
        className={cn(
          "pr-24 text-xs tabular-nums",
          over ? "font-medium text-destructive" : "text-muted-foreground",
        )}
      >
        {settings.enabled
          ? `${formatCredits(spentUsd)} of ${formatCredits(settings.capUsd)} ${periodLabel}`
          : `Cap disabled · ${formatCredits(spentUsd)} ${periodLabel}`}
      </span>

      {/* Pinned to the tile's top-right band, beside the figure, so opening the
          form below never moves it. */}
      <div
        {...(settings.enabled
          ? {
              role: "progressbar",
              "aria-label": `Team spending toward ${settings.period} global cap`,
              "aria-valuemin": 0,
              "aria-valuemax": Math.max(settings.capUsd, 0.01),
              "aria-valuenow": Math.min(spentUsd, Math.max(settings.capUsd, 0.01)),
              "aria-valuetext": `${spentUsd.toFixed(2)} dollars of ${settings.capUsd.toFixed(2)} dollar ${settings.period} global cap`,
            }
          : { "aria-hidden": true })}
        className="pointer-events-none absolute right-2 top-[4.5rem] w-28"
      >
        <svg aria-hidden="true" viewBox="0 0 100 56" className="w-full">
          <path
            d={GAUGE_ARC}
            fill="none"
            strokeWidth={9}
            strokeLinecap="round"
            className="stroke-muted"
          />
          {settings.enabled && pct > 0 ? (
            <path
              d={GAUGE_ARC}
              fill="none"
              strokeWidth={9}
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${Math.min(pct, 100)} 100`}
              className={over ? "stroke-destructive" : "stroke-primary"}
            />
          ) : null}
        </svg>
      </div>

      {open ? (
        // Floats over the page instead of growing the tile, so nothing below
        // it moves. Closed only by the tile's own button: the period Select
        // portals its list outside this box, so an outside-click close would
        // fire on picking a period.
        <div
          id="global-cap-form"
          role="dialog"
          aria-label="Team spending limit"
          className="absolute right-0 top-full z-30 mt-2 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-4 rounded-2xl border border-border bg-popover p-5 text-popover-foreground shadow-xl"
        >
          <div className="grid gap-2">
            <Label htmlFor="global-cap-period">Global cap period</Label>
            <Select
              value={period}
              onValueChange={(value) => setPeriod(value as GlobalSpendCapPeriod)}
              disabled={isPending}
            >
              <SelectTrigger id="global-cap-period" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="global-cap-credits">Global cap in credits</Label>
            <Input
              id="global-cap-credits"
              type="number"
              min={0}
              step={100}
              value={credits}
              onChange={(event) => setCredits(event.target.value)}
              disabled={isPending}
            />
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-border bg-muted/20 px-3 py-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              disabled={isPending}
              className="size-4 accent-primary"
            />
            Enable global cap
          </label>
          <PendingButton type="button" onClick={save} pending={isPending} className="w-full">
            Save cap
          </PendingButton>
          {message ? (
            <p role="status" className="rounded-xl border border-border bg-muted/30 p-3 text-sm">
              {message}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
