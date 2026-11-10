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

import { useRef, useState, useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
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
  getBulkSpendingLimits,
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
  type BulkSpendingLimits,
} from "@/lib/allowance";
import { formatUsd } from "@/lib/format-usd";
import { cn } from "@/lib/utils";

const capInput = (value: number | null | "mixed"): string =>
  typeof value === "number" ? String(value) : "";

export function Toggle({
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
  /** Accounts on `trusted_editor`. Counted separately because the scope
   * below writes to one tier or the other, and the copy names the number it
   * is about to change. */
  trustedEditorCount,
  /** Accounts on `hybrid_editor` / `ai_animator` (0131), counted per scope like the two above. */
  hybridEditorCount = 0,
  aiAnimatorCount = 0,
  /** Editor-tier accounts the daily on/off moves (it is installation-wide, not per role). */
  followingDefaultCount,
}: {
  maxWeeklyCapUsd: number;
  maxDailyCapUsd: number;
  editorCount: number;
  trustedEditorCount: number;
  hybridEditorCount?: number;
  aiAnimatorCount?: number;
  followingDefaultCount: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [credits, setCredits] = useState("");
  const [dailyOn, setDailyOn] = useState(false);
  const [dailyCredits, setDailyCredits] = useState("");
  const [hourlyOn, setHourlyOn] = useState(false);
  const [hourlyCredits, setHourlyCredits] = useState("");
  const [changed, setChanged] = useState({ weekly: false, daily: false, hourly: false });
  const [limits, setLimits] = useState<BulkSpendingLimits | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const loadRequest = useRef(0);
  // "all" is the default because it is what this control did before scopes
  // existed — an admin who opens it and clicks straight through gets the
  // behaviour they already knew.
  const [scope, setScope] = useState<BulkAllowanceScope>("all");
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  // What the chosen scope will actually write to, so every number on screen
  // is the number the Server Action is about to change.
  const countByScope: Record<BulkAllowanceScope, number> = {
    editor: editorCount,
    trusted_editor: trustedEditorCount,
    hybrid_editor: hybridEditorCount,
    ai_animator: aiAnimatorCount,
    all: editorCount + trustedEditorCount + hybridEditorCount + aiAnimatorCount,
  };
  const scopedCount = limits?.count ?? countByScope[scope];
  const plural = (n: number): string => `${n} account${n === 1 ? "" : "s"}`;
  const disabled = isPending || isLoading || !limits;

  async function loadLimits(nextScope: BulkAllowanceScope): Promise<boolean> {
    const request = ++loadRequest.current;
    setIsLoading(true);
    setLimits(null);
    setErrorMessage(null);
    setDoneMessage(null);
    try {
      const saved = await getBulkSpendingLimits(nextScope);
      if (request !== loadRequest.current) return false;
      setLimits(saved);
      setCredits(capInput(saved.weeklyCapUsd));
      setDailyCredits(capInput(saved.dailyCapUsd));
      setHourlyCredits(capInput(saved.hourlyCapUsd));
      setChanged({ weekly: false, daily: false, hourly: false });
      setDailyOn(saved.dailyCapEnabled);
      setHourlyOn(saved.hourlyCapUsd !== null);
      return true;
    } catch (error) {
      unstable_rethrow(error);
      if (request === loadRequest.current) {
        setErrorMessage(error instanceof Error ? error.message : "Could not load saved limits.");
      }
      return false;
    } finally {
      if (request === loadRequest.current) setIsLoading(false);
    }
  }

  function changeOpen(nextOpen: boolean): void {
    if (isPending) return;
    setOpen(nextOpen);
    if (nextOpen) void loadLimits(scope);
    else ++loadRequest.current;
  }

  /**
   * `dailyCapUsd` / `hourlyCapUsd`: a number sets it, null clears it,
   * undefined leaves it alone. `dailyEnabled` undefined leaves the switch.
   */
  function submit(
    weeklyCapUsd: number | null | undefined,
    dailyEnabled: boolean | undefined,
    dailyCapUsd: number | null | undefined,
    hourlyCapUsd: number | null | undefined,
  ): void {
    if (disabled || !limits || limits.count === 0) return;
    setErrorMessage(null);
    setDoneMessage(null);
    startTransition(async () => {
      try {
        // A zero weekly cap also revokes grants; do it before the other changes.
        if (weeklyCapUsd !== undefined) {
          const result = await setAllEditorsWeeklyCap(weeklyCapUsd, scope);
          if ("error" in result) throw new Error(result.error);
        }
        if (dailyCapUsd !== undefined) {
          const dailyResult = await setAllEditorsDailyCap(dailyCapUsd, scope);
          if ("error" in dailyResult) throw new Error(dailyResult.error);
        }
        if (hourlyCapUsd !== undefined) {
          const hourlyResult = await setAllEditorsHourlyCap(hourlyCapUsd, scope);
          if ("error" in hourlyResult) throw new Error(hourlyResult.error);
        }
        // Apply amounts before enabling the guard, so an old cap cannot briefly block users.
        if (dailyEnabled !== undefined && dailyEnabled !== limits.dailyCapEnabled) {
          const switched = await setUserDailyCapEnabled(dailyEnabled);
          if (switched?.error) throw new Error(switched.error);
        }
        // Read back after writes, including clearing overrides to role defaults.
        if (await loadLimits(scope)) {
          setDoneMessage(
            weeklyCapUsd === null
              ? "Cleared. Selected accounts are back on role defaults."
              : "Changes saved. Showing current limits.",
          );
        }
      } catch (error) {
        unstable_rethrow(error);
        const reloaded = await loadLimits(scope);
        setErrorMessage(
          `${error instanceof Error ? error.message : "Failed to save limits."} Some changes may have saved. ${reloaded ? "Current limits have been reloaded; review them before retrying." : "Close and reopen to reload current limits before retrying."}`,
        );
      }
    });
  }

  function handleSave(): void {
    if (!limits || disabled) return;
    let weeklyCapUsd: number | undefined;
    if (changed.weekly) {
      weeklyCapUsd = Number(credits);
      const error =
        credits.trim() === ""
          ? "Enter zero or a positive weekly limit."
          : weeklyCapOverrideError(weeklyCapUsd, maxWeeklyCapUsd);
      if (error) {
        setErrorMessage(error);
        return;
      }
    }

    // Daily OFF leaves the stored amounts alone: the switch is what stops
    // them applying, and turning it back on brings them back as they were.
    let dailyCapUsd: number | undefined;
    if (dailyOn && changed.daily) {
      const enteredDaily = Number(dailyCredits);
      if (dailyCredits.trim() === "" || !Number.isFinite(enteredDaily) || enteredDaily < 0) {
        setErrorMessage("Enter zero or a positive daily cap.");
        return;
      }
      dailyCapUsd = enteredDaily;
      const dailyError = dailyCapOverrideError(dailyCapUsd, maxDailyCapUsd);
      if (dailyError) {
        setErrorMessage(dailyError);
        return;
      }
    }

    // Hourly has no installation switch — an account is capped exactly when
    // it has a value — so OFF clears it for the chosen role.
    let hourlyCapUsd: number | null | undefined;
    if (!hourlyOn && limits.hourlyCapUsd !== null) hourlyCapUsd = null;
    if (hourlyOn && (limits.hourlyCapUsd === null || changed.hourly)) {
      const enteredHourly = Number(hourlyCredits);
      if (hourlyCredits.trim() === "" || !Number.isFinite(enteredHourly) || enteredHourly < 0) {
        setErrorMessage("Enter zero or a positive hourly cap.");
        return;
      }
      hourlyCapUsd = enteredHourly;
    }

    submit(weeklyCapUsd, dailyOn, dailyCapUsd, hourlyCapUsd);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <SlidersHorizontal aria-hidden="true" className="size-4" />
          Spending limits
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Spending limits</DialogTitle>
          <DialogDescription>
            Applies to {plural(scopedCount)} right now. Changes replace individual limits for these
            accounts. Admins are never affected.
          </DialogDescription>
        </DialogHeader>

        {/* Scope first, then the amount — the amount means nothing until you
            know who it lands on, and an admin who picks the number first is
            the one who misses that the default is every tier. */}
        <div className="grid gap-2">
          <Label htmlFor="all-editors-allowance-scope">Applies to</Label>
          <Select
            value={scope}
            onValueChange={(next) => {
              const nextScope = next as BulkAllowanceScope;
              setScope(nextScope);
              void loadLimits(nextScope);
            }}
            disabled={isPending || isLoading}
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
              <SelectItem value="hybrid_editor">
                {BULK_ALLOWANCE_SCOPE_LABELS.hybrid_editor} ({hybridEditorCount})
              </SelectItem>
              <SelectItem value="ai_animator">
                {BULK_ALLOWANCE_SCOPE_LABELS.ai_animator} ({aiAnimatorCount})
              </SelectItem>
              <SelectItem value="all">
                {BULK_ALLOWANCE_SCOPE_LABELS.all} ({countByScope.all})
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
          <Label htmlFor="all-editors-allowance-credits">USD per week</Label>
          <Input
            id="all-editors-allowance-credits"
            type="number"
            min={0}
            step={0.01}
            value={credits}
            placeholder={limits?.weeklyCapUsd === "mixed" ? "Mixed — unchanged" : undefined}
            onChange={(event) => {
              setCredits(event.target.value);
              setChanged((current) => ({ ...current, weekly: true }));
            }}
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            Up to {formatUsd(maxWeeklyCapUsd)}. This sets a value on the accounts that exist today;
            someone who signs up later gets their role&apos;s starting value. &ldquo;Reset to
            starting values&rdquo; puts each selected account back on its role&apos;s starting
            value. Set to 0 to remove the base allowance and revoke approved grants. Allowance
            received from colleagues remains available. Untouched limits stay unchanged.
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
              disabled={disabled}
            />
          </div>
          {dailyOn ? (
            <div className="grid gap-2">
              <Label htmlFor="all-editors-daily-credits">USD per day</Label>
              <Input
                id="all-editors-daily-credits"
                type="number"
                min={0}
                step={0.01}
                value={dailyCredits}
                placeholder={limits?.dailyCapUsd === "mixed" ? "Mixed — unchanged" : undefined}
                onChange={(event) => {
                  setDailyCredits(event.target.value);
                  setChanged((current) => ({ ...current, daily: true }));
                }}
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">
                Anything at or over the weekly amount never fires. Up to {formatUsd(maxDailyCapUsd)}
                .
              </p>
            </div>
          ) : null}
          {/* The on/off is installation-wide (app_settings), not per role —
              said here so "Editors only" above isn't read as covering it. */}
          {limits && dailyOn !== limits.dailyCapEnabled ? (
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
              disabled={disabled}
            />
          </div>
          {hourlyOn ? (
            <div className="grid gap-2">
              <Label htmlFor="all-editors-hourly-credits">USD per hour</Label>
              <Input
                id="all-editors-hourly-credits"
                type="number"
                min={0}
                step={0.01}
                value={hourlyCredits}
                placeholder={limits?.hourlyCapUsd === "mixed" ? "Mixed — unchanged" : undefined}
                onChange={(event) => {
                  setHourlyCredits(event.target.value);
                  setChanged((current) => ({ ...current, hourly: true }));
                }}
                disabled={disabled}
              />
            </div>
          ) : null}
        </div>

        {isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading saved limits…
          </p>
        ) : null}
        {errorMessage ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        {doneMessage ? <p className="text-sm text-muted-foreground">{doneMessage}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => changeOpen(false)} disabled={isPending}>
            Close
          </Button>
          <PendingButton
            variant="outline"
            onClick={() => submit(null, undefined, null, null)}
            pending={isPending}
            disabled={disabled || scopedCount === 0}
          >
            Reset to starting values
          </PendingButton>
          <PendingButton
            onClick={handleSave}
            pending={isPending}
            disabled={disabled || scopedCount === 0}
          >
            Set for {scopedCount}
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
