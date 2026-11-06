"use client";

// Per-account weekly allowance override, from /users (actions/account.ts's
// setWeeklyCapOverride, profiles.weekly_cap_override_usd).
//
// The column has existed since 0031_account_allowances.sql and, like
// profiles.role before setTrustedEditor, was read in four places and
// written nowhere in the app — the only way to give one editor a different
// weekly allowance was a hand-written UPDATE in the Supabase dashboard.
//
// Input is in CREDITS, because that is the unit everyone now reads
// allowances in (lib/format-usd.ts) and asking an admin to divide by 200 in
// their head to type a number they just read as "5,000 cr" is exactly the
// mismatch the credits change existed to remove. The conversion happens
// once, here, on submit; the Server Action and the column stay in USD.

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PendingButton } from "@/components/pending-button";
import { setDailyCapOverride, setHourlyCapOverride, setWeeklyCapOverride } from "@/actions/account";
import { dailyCapOverrideError, weeklyCapOverrideError } from "@/lib/allowance";
import { formatUsd } from "@/lib/format-usd";

// ponytail: still named WeeklyAllowanceDialog though it now edits both
// windows. Renaming means touching /users and this file's test while
// another branch is editing both — not worth a merge conflict over a name.
// Rename to AccountAllowanceDialog when this area is otherwise quiet.

export function WeeklyAllowanceDialog({
  userId,
  email,
  /** The account's CURRENT effective weekly cap in USD — its override if it
   * has one, otherwise its role default. Pre-fills the input, so an admin
   * edits the number they were just looking at in the row. */
  effectiveWeeklyCapUsd,
  /** True when this account already carries an override, which is the only
   * thing that makes "Use role default" meaningful — offering a reset to an
   * account that has nothing to reset is a button that does nothing. */
  hasOverride,
  /** ADMIN_WEEKLY_CAP_USD, resolved server-side. The page reads it through
   * its existing dynamic import of lib/spend, never a client import — that
   * module throws at load on a malformed cap env var. */
  maxWeeklyCapUsd,
  /** The account's CURRENT effective daily burst guard in USD — already
   * clamped to the weekly figure by resolveAccountCaps, so it is the number
   * shown in the row rather than the raw stored column. */
  effectiveDailyCapUsd,
  /** True when daily_cap_override_usd is set on this account. */
  hasDailyOverride,
  /** ADMIN_DAILY_CAP_USD, resolved server-side — same route as the weekly ceiling. */
  maxDailyCapUsd,
  effectiveHourlyCapUsd,
  hasHourlyOverride,
  dailyCapEnabled = true,
  /**
   * Controlled open state, for a caller that supplies its own trigger —
   * components/user-row-actions.tsx opens this from a dropdown item, where
   * a nested DialogTrigger would be unmounted by the menu closing before the
   * dialog could mount. Omit both and the dialog owns its own button, which
   * is how it is used anywhere a row menu is not involved.
   */
  open,
  onOpenChange,
}: {
  userId: string;
  email: string;
  effectiveWeeklyCapUsd: number;
  hasOverride: boolean;
  maxWeeklyCapUsd: number;
  effectiveDailyCapUsd: number;
  hasDailyOverride: boolean;
  maxDailyCapUsd: number;
  effectiveHourlyCapUsd: number | null;
  hasHourlyOverride: boolean;
  /** The INSTALLATION default (app_settings.user_daily_cap_enabled). Decides what "Follow the default" means below, and whether the amount field is worth showing at all. */
  dailyCapEnabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}): JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = open !== undefined;
  const dialogOpen = isControlled ? open : uncontrolledOpen;
  const setOpen = (next: boolean): void => {
    if (isControlled) onOpenChange?.(next);
    else setUncontrolledOpen(next);
  };
  const [credits, setCredits] = useState(String(effectiveWeeklyCapUsd));
  const [dailyCredits, setDailyCredits] = useState(String(effectiveDailyCapUsd));
  const [hourlyCredits, setHourlyCredits] = useState(
    effectiveHourlyCapUsd === null ? "" : String(effectiveHourlyCapUsd),
  );
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /**
   * Writes whichever windows the admin actually changed.
   *
   * Two Server Actions rather than one that takes both, because the weekly
   * one carries behaviour the daily one must not: a zero weekly revokes the
   * account's grants (actions/account.ts's ZERO MEANS ZERO), a zero daily
   * deliberately does not. Folding them into a single setAccountCaps would
   * mean one action with two different zero semantics inside it.
   *
   * Both are written on every Save, including unchanged ones. Re-sending an
   * unchanged weekly zero can only revoke grants issued SINCE that zero was
   * set — an account that is already paused and has since been granted more
   * is a contradiction an admin re-saving the pause is entitled to resolve.
   */
  function submit(
    weeklyCapUsd: number | null,
    dailyCapUsd: number | null,
    hourlyCapUsd: number | null,
    clearOverrides = false,
  ): void {
    setErrorMessage(null);
    startTransition(async () => {
      try {
        // Weekly first: it is the one that can revoke grants, and if it
        // fails there is nothing to unwind. The reverse order could write a
        // daily guard against a weekly figure that never landed.
        const weekly = await setWeeklyCapOverride(userId, weeklyCapUsd);
        if (weekly?.error) {
          setErrorMessage(weekly.error);
          return;
        }
        if (dailyCapEnabled || clearOverrides) {
          const daily = await setDailyCapOverride(userId, dailyCapUsd);
          if (daily?.error) {
            setErrorMessage(daily.error);
            return;
          }
        }
        const hourly = await setHourlyCapOverride(userId, hourlyCapUsd);
        if (hourly?.error) {
          setErrorMessage(hourly.error);
          return;
        }
        setOpen(false);
      } catch (error) {
        unstable_rethrow(error);
        setErrorMessage(error instanceof Error ? error.message : "Failed to set that allowance.");
      }
    });
  }

  function handleSave(): void {
    const entered = Number(credits);
    if (!Number.isFinite(entered) || entered < 0) {
      setErrorMessage("Enter zero or a positive dollar amount.");
      return;
    }
    // Convert once, then validate in the unit the rule is written in — the
    // same functions the Server Actions re-run, so the dialog can never
    // accept something the server then refuses.
    const weeklyCapUsd = entered;
    const error = weeklyCapOverrideError(weeklyCapUsd, maxWeeklyCapUsd);
    if (error) {
      setErrorMessage(error);
      return;
    }
    let dailyCapUsd: number | null = null;
    if (dailyCapEnabled) {
      const enteredDaily = Number(dailyCredits);
      if (!Number.isFinite(enteredDaily) || enteredDaily < 0) {
        setErrorMessage("Enter zero or a positive daily guard.");
        return;
      }
      dailyCapUsd = enteredDaily;
      const dailyError = dailyCapOverrideError(dailyCapUsd, maxDailyCapUsd);
      if (dailyError) {
        setErrorMessage(dailyError);
        return;
      }
    }
    const enteredHourly = hourlyCredits.trim() === "" ? null : Number(hourlyCredits);
    if (enteredHourly !== null && (!Number.isFinite(enteredHourly) || enteredHourly < 0)) {
      setErrorMessage("Enter zero or a positive hourly cap, or leave it blank for no cap.");
      return;
    }
    submit(weeklyCapUsd, dailyCapUsd, enteredHourly === null ? null : enteredHourly);
  }

  return (
    <Dialog open={dialogOpen} onOpenChange={setOpen}>
      {isControlled ? null : (
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">
            Allowance<span className="sr-only"> for {email}</span>
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Allowance for {email}</DialogTitle>
          <DialogDescription>
            This replaces their role&apos;s default allowance every week, until it is cleared. It is
            not a one-off top-up — for that, approve an allowance request instead, which expires on
            its own. Set it to 0 to stop this account spending: that also revokes any active grant,
            since a grant would otherwise sit on top of the zero and keep renders running.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label htmlFor="weekly-allowance-credits">USD per week</Label>
          <Input
            id="weekly-allowance-credits"
            type="number"
            min={0}
            step={0.01}
            value={credits}
            onChange={(event) => setCredits(event.target.value)}
            disabled={isPending}
          />
          <p className="text-xs text-muted-foreground">
            {hasOverride
              ? `Currently ${formatUsd(effectiveWeeklyCapUsd)}, set on this account.`
              : `Currently ${formatUsd(effectiveWeeklyCapUsd)}, from their role.`}{" "}
            Up to {formatUsd(maxWeeklyCapUsd)}.
          </p>
        </div>

        {dailyCapEnabled ? (
          <>
            {/* The daily guard, which until now had no control anywhere in the
            app despite being read on this very row (profiles.
            daily_cap_override_usd, 0031_account_allowances.sql). Shown UNDER
            the weekly field, not beside it, because that is the relationship:
            it limits how much of the week can go in one day, and a figure at
            or above the weekly allowance simply never fires. */}
            <div className="grid gap-2">
              <Label htmlFor="daily-allowance-credits">USD per day</Label>
              <Input
                id="daily-allowance-credits"
                type="number"
                min={0}
                step={0.01}
                value={dailyCredits}
                onChange={(event) => setDailyCredits(event.target.value)}
                disabled={isPending}
              />
              <p className="text-xs text-muted-foreground">
                {hasDailyOverride
                  ? `Currently ${formatUsd(effectiveDailyCapUsd)}, set on this account.`
                  : `Currently ${formatUsd(effectiveDailyCapUsd)}, from their role.`}{" "}
                A burst guard, not a second budget — it is capped at the weekly figure above, so
                anything larger has no effect. Up to {formatUsd(maxDailyCapUsd)}.
              </p>
            </div>
          </>
        ) : null}

        <div className="grid gap-2">
          <Label htmlFor="hourly-allowance-credits">USD per rolling hour</Label>
          <Input
            id="hourly-allowance-credits"
            type="number"
            min={0}
            step={0.01}
            value={hourlyCredits}
            onChange={(event) => setHourlyCredits(event.target.value)}
            disabled={isPending}
            placeholder="No hourly cap"
          />
          <p className="text-xs text-muted-foreground">
            {hasHourlyOverride
              ? `Currently ${formatUsd(effectiveHourlyCapUsd ?? 0)}, set on this account.`
              : "Optional per-account limit; usage rolls off after 60 minutes."}
          </p>
        </div>

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          {/* Only offered when there is an override to remove. Passing null
              is the clear — see setWeeklyCapOverride's own doc. */}
          {hasOverride || hasDailyOverride || hasHourlyOverride ? (
            <PendingButton
              variant="outline"
              onClick={() => submit(null, null, null, true)}
              pending={isPending}
            >
              Clear overrides
            </PendingButton>
          ) : null}
          <PendingButton onClick={handleSave} pending={isPending}>
            Save
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
