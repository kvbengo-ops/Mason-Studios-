"use client";

// Every team-wide spending limit from /users, behind one "Spending limits"
// button: the weekly allowance by role, plus an OPTIONAL daily and hourly cap,
// each behind its own switch.
//
// The copy below says out loud that this is not the role default, because
// an admin will otherwise assume it is. It writes an override onto each
// existing editor row; an account created afterwards still starts on the
// env-var default until someone runs this again. That ceiling is recorded
// on the Server Action, along with what changing it would actually cost.
//
// NOTHING APPLIES UNTIL SAVE, switches included. Turning the daily switch
// off used to be its own confirm dialog (daily-cap-switch.tsx); here the
// warning shows under the switch instead and Save is the confirmation.

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  setAllEditorsDailyCap,
  setAllEditorsHourlyCap,
  setAllEditorsWeeklyCap,
  setUserDailyCapEnabled,
} from "@/actions/account";
import {
  BULK_ALLOWANCE_SCOPE_LABELS,
  dailyCapOverrideError,
  weeklyCapOverrideError,
  type BulkAllowanceScope,
} from "@/lib/allowance";
import { creditsToUsd, formatCredits } from "@/lib/format-usd";
import { cn } from "@/lib/utils";

function Toggle({
  id,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
        checked ? "bg-primary" : "bg-muted-foreground/30",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-5 rounded-full bg-background shadow transition-transform",
          checked ? "translate-x-[1.375rem]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function AllEditorsAllowanceDialog({
  /** ADMIN_WEEKLY_CAP_USD, resolved server-side — see the per-account
   * dialog's prop doc for why this is never a client import. */
  maxWeeklyCapUsd,
  /** Accounts on the plain `editor` role. */
  editorCount,
  /** ADMIN_DAILY_CAP_USD, resolved server-side — the ceiling the daily field validates against. */
  maxDailyCapUsd,
  /** The installation-wide daily guard (app_settings, 0077) — the daily switch's starting state. */
  dailyCapEnabled = false,
  /** Accounts on `trusted_editor`. Counted separately because the scope
   * below writes to one tier or the other, and the copy names the number it
   * is about to change. */
  trustedEditorCount,
  /** Editor-tier accounts the daily on/off moves (it is installation-wide, not per role). */
  followingDefaultCount,
  /** Whether any editor-tier account has an hourly cap now — the hourly switch's starting state. */
  hourlyCapInUse = false,
}: {
  maxWeeklyCapUsd: number;
  maxDailyCapUsd: number;
  dailyCapEnabled?: boolean;
  editorCount: number;
  trustedEditorCount: number;
  followingDefaultCount: number;
  hourlyCapInUse?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [credits, setCredits] = useState("2000");
  const [dailyOn, setDailyOn] = useState(dailyCapEnabled);
  const [dailyCredits, setDailyCredits] = useState("400");
  const [hourlyOn, setHourlyOn] = useState(hourlyCapInUse);
  const [hourlyCredits, setHourlyCredits] = useState("100");
  // "all" is the default because it is what this control did before scopes
  // existed — an admin who opens it and clicks straight through gets the
  // behaviour they already knew.
  const [scope, setScope] = useState<BulkAllowanceScope>("all");
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  // What the chosen scope will actually write to, so every number on screen
  // is the number the Server Action is about to change.
  const scopedCount =
    scope === "editor"
      ? editorCount
      : scope === "trusted_editor"
        ? trustedEditorCount
        : editorCount + trustedEditorCount;
  const plural = (n: number): string => `${n} account${n === 1 ? "" : "s"}`;

  /**
   * `dailyCapUsd` / `hourlyCapUsd`: a number sets it, null clears it,
   * undefined leaves it alone. `dailyEnabled` undefined leaves the switch.
   */
  function submit(
    weeklyCapUsd: number | null,
    dailyEnabled: boolean | undefined,
    dailyCapUsd: number | null | undefined,
    hourlyCapUsd: number | null,
  ): void {
    setErrorMessage(null);
    setDoneMessage(null);
    startTransition(async () => {
      try {
        // Weekly first: it is the one that revokes grants on zero, so if it
        // fails there is nothing to unwind.
        const result = await setAllEditorsWeeklyCap(weeklyCapUsd, scope);
        if ("error" in result) {
          setErrorMessage(result.error);
          return;
        }
        if (dailyEnabled !== undefined && dailyEnabled !== dailyCapEnabled) {
          const switched = await setUserDailyCapEnabled(dailyEnabled);
          if (switched?.error) {
            setErrorMessage(switched.error);
            return;
          }
        }
        if (dailyCapUsd !== undefined) {
          const dailyResult = await setAllEditorsDailyCap(dailyCapUsd, scope);
          if ("error" in dailyResult) {
            setErrorMessage(dailyResult.error);
            return;
          }
        }
        const hourlyResult = await setAllEditorsHourlyCap(hourlyCapUsd, scope);
        if ("error" in hourlyResult) {
          setErrorMessage(hourlyResult.error);
          return;
        }
        // Stays open on success, unlike the per-account dialog: the admin
        // just changed every editor's limit at once and the count is the
        // only confirmation that it hit who they expected.
        setDoneMessage(
          weeklyCapUsd === null
            ? `Cleared. ${plural(result.updated)} back on role defaults.`
            : `Saved on ${plural(result.updated)}.`,
        );
      } catch (error) {
        unstable_rethrow(error);
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to set the editor allowance.",
        );
      }
    });
  }

  function handleSave(): void {
    const entered = Number(credits);
    if (!Number.isFinite(entered) || entered <= 0) {
      setErrorMessage("Enter a positive number of credits.");
      return;
    }
    const weeklyCapUsd = creditsToUsd(entered);
    const error = weeklyCapOverrideError(weeklyCapUsd, maxWeeklyCapUsd);
    if (error) {
      setErrorMessage(error);
      return;
    }

    // Daily OFF leaves the stored amounts alone: the switch is what stops
    // them applying, and turning it back on brings them back as they were.
    let dailyCapUsd: number | undefined;
    if (dailyOn) {
      const enteredDaily = Number(dailyCredits);
      if (!Number.isFinite(enteredDaily) || enteredDaily < 0) {
        setErrorMessage("Enter zero or a positive daily cap.");
        return;
      }
      dailyCapUsd = creditsToUsd(enteredDaily);
      const dailyError = dailyCapOverrideError(dailyCapUsd, maxDailyCapUsd);
      if (dailyError) {
        setErrorMessage(dailyError);
        return;
      }
    }

    // Hourly has no installation switch — an account is capped exactly when
    // it has a value — so OFF clears it for the chosen role.
    let hourlyCapUsd: number | null = null;
    if (hourlyOn) {
      const enteredHourly = Number(hourlyCredits);
      if (!Number.isFinite(enteredHourly) || enteredHourly < 0) {
        setErrorMessage("Enter zero or a positive hourly cap.");
        return;
      }
      hourlyCapUsd = creditsToUsd(enteredHourly);
    }

    submit(weeklyCapUsd, dailyOn, dailyCapUsd, hourlyCapUsd);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Spending limits
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Spending limits</DialogTitle>
          <DialogDescription>
            Applies to {plural(scopedCount)} right now. Admins are never affected, and any allowance
            you set on one person individually is overwritten.
          </DialogDescription>
        </DialogHeader>

        {/* Scope first, then the amount — the amount means nothing until you
            know who it lands on, and an admin who picks the number first is
            the one who misses that the default is every tier. */}
        <div className="grid gap-2">
          <Label htmlFor="all-editors-allowance-scope">Applies to</Label>
          <Select
            value={scope}
            onValueChange={(next) => setScope(next as BulkAllowanceScope)}
            disabled={isPending}
          >
            <SelectTrigger id="all-editors-allowance-scope" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="editor">
                {BULK_ALLOWANCE_SCOPE_LABELS.editor} ({editorCount})
              </SelectItem>
              <SelectItem value="trusted_editor">
                {BULK_ALLOWANCE_SCOPE_LABELS.trusted_editor} ({trustedEditorCount})
              </SelectItem>
              <SelectItem value="all">
                {BULK_ALLOWANCE_SCOPE_LABELS.all} ({editorCount + trustedEditorCount})
              </SelectItem>
            </SelectContent>
          </Select>
          {scope === "trusted_editor" ? (
            <p className="text-xs text-muted-foreground">
              A trusted editor&apos;s own allowance is separate from what they may APPROVE for a
              colleague — that ceiling is WEEKLY_CAP_USD and is not changed here.
            </p>
          ) : null}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="all-editors-allowance-credits">Credits per week</Label>
          <Input
            id="all-editors-allowance-credits"
            type="number"
            min={1}
            step={100}
            value={credits}
            onChange={(event) => setCredits(event.target.value)}
            disabled={isPending}
          />
          <p className="text-xs text-muted-foreground">
            Up to {formatCredits(maxWeeklyCapUsd)}. This is not the role default — it sets a value
            on the accounts that exist today. Someone who signs up later starts on the role default
            until you run this again. &ldquo;Use role defaults&rdquo; clears it for everyone.
          </p>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="all-editors-daily-switch" className="flex flex-col items-start gap-0.5">
              <span>Daily cap</span>
              <span className="text-xs font-normal text-muted-foreground">
                Optional burst guard under the weekly figure.
              </span>
            </Label>
            <Toggle
              id="all-editors-daily-switch"
              checked={dailyOn}
              onChange={setDailyOn}
              disabled={isPending}
            />
          </div>
          {dailyOn ? (
            <div className="grid gap-2">
              <Label htmlFor="all-editors-daily-credits">Credits per day</Label>
              <Input
                id="all-editors-daily-credits"
                type="number"
                min={0}
                step={100}
                value={dailyCredits}
                onChange={(event) => setDailyCredits(event.target.value)}
                disabled={isPending}
              />
              <p className="text-xs text-muted-foreground">
                Anything at or over the weekly amount never fires. Up to{" "}
                {formatCredits(maxDailyCapUsd)}.
              </p>
            </div>
          ) : null}
          {/* The on/off is installation-wide (app_settings), not per role —
              said here so "Editors only" above isn't read as covering it. */}
          {dailyOn !== dailyCapEnabled ? (
            <p
              className={cn(
                "text-xs",
                dailyOn ? "text-muted-foreground" : "font-medium text-destructive",
              )}
            >
              {dailyOn
                ? `Save turns the daily cap on for all ${plural(followingDefaultCount)}.`
                : `Save turns the daily cap off for all ${plural(followingDefaultCount)} — one editor could spend a week's allowance in an afternoon.`}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-4">
            <Label
              htmlFor="all-editors-hourly-switch"
              className="flex flex-col items-start gap-0.5"
            >
              <span>Hourly cap</span>
              <span className="text-xs font-normal text-muted-foreground">
                {hourlyOn
                  ? "Optional ceiling per hour."
                  : `Off — Save removes hourly caps from these ${plural(scopedCount)}.`}
              </span>
            </Label>
            <Toggle
              id="all-editors-hourly-switch"
              checked={hourlyOn}
              onChange={setHourlyOn}
              disabled={isPending}
            />
          </div>
          {hourlyOn ? (
            <div className="grid gap-2">
              <Label htmlFor="all-editors-hourly-credits">Credits per hour</Label>
              <Input
                id="all-editors-hourly-credits"
                type="number"
                min={0}
                step={10}
                value={hourlyCredits}
                onChange={(event) => setHourlyCredits(event.target.value)}
                disabled={isPending}
              />
            </div>
          ) : null}
        </div>

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
        {doneMessage ? <p className="text-sm text-muted-foreground">{doneMessage}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Close
          </Button>
          <PendingButton
            variant="outline"
            onClick={() => submit(null, undefined, null, null)}
            pending={isPending}
          >
            Use role defaults
          </PendingButton>
          <PendingButton onClick={handleSave} pending={isPending}>
            Set for {scopedCount}
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
