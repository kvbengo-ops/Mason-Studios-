"use client";

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { setGlobalSpendCap } from "@/actions/account";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PendingButton } from "@/components/pending-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { creditsToUsd, formatCredits, usdToCredits } from "@/lib/format-usd";
import type { GlobalSpendCapPeriod, GlobalSpendCapSettings } from "@/lib/spend";

export function GlobalSpendCapControl({
  settings,
  spentUsd,
}: {
  settings: GlobalSpendCapSettings;
  spentUsd: number;
}): JSX.Element {
  const router = useRouter();
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
  const progress = settings.enabled
    ? settings.capUsd > 0
      ? Math.max(0, Math.min(100, (spentUsd / settings.capUsd) * 100))
      : spentUsd > 0
        ? 100
        : 0
    : 0;

  return (
    <section aria-label="Global spend cap" className="flex flex-col gap-3 rounded-2xl border border-border bg-card px-5 py-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-48 gap-1">
          <Label htmlFor="global-cap-period">Global cap period</Label>
          <Select
            value={period}
            onValueChange={(value) => setPeriod(value as GlobalSpendCapPeriod)}
            disabled={isPending}
          >
            <SelectTrigger id="global-cap-period" className="min-w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid min-w-48 gap-1">
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
        <label className="flex h-9 items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            disabled={isPending}
            className="size-4 accent-primary"
          />
          Enable global cap
        </label>
        <PendingButton type="button" onClick={save} pending={isPending}>
          Save cap
        </PendingButton>
      </div>
      {settings.enabled ? (
        <>
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">Team spend {periodLabel}</span>
            <span className="tabular-nums text-foreground">
              {formatCredits(spentUsd)} / {formatCredits(settings.capUsd)}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={`Team spending toward ${settings.period} global cap`}
            aria-valuemin={0}
            aria-valuemax={Math.max(settings.capUsd, 0.01)}
            aria-valuenow={Math.min(spentUsd, Math.max(settings.capUsd, 0.01))}
            aria-valuetext={`${spentUsd.toFixed(2)} dollars of ${settings.capUsd.toFixed(2)} dollar ${settings.period} global cap`}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              aria-hidden="true"
              className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground">
            ${spentUsd.toFixed(2)} of ${settings.capUsd.toFixed(2)} {settings.period} cap
          </span>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Global cap disabled. Current {periodLabel} spend: ${spentUsd.toFixed(2)}.</p>
      )}
      {message ? <p role="status" className="text-xs text-muted-foreground">{message}</p> : null}
    </section>
  );
}
