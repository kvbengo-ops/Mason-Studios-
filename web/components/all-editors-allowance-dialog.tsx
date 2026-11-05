"use client";

// Bulk weekly allowance for every editor-tier account, from /users
// (actions/account.ts's setAllEditorsWeeklyCap).
//
// The copy below says out loud that this is not the role default, because
// an admin will otherwise assume it is. It writes an override onto each
// existing editor row; an account created afterwards still starts on the
// env-var default until someone runs this again. That ceiling is recorded
// on the Server Action, along with what changing it would actually cost.
//
// Destructive-ish enough to confirm: it rewrites a money limit on every
// editor at once, including any per-person allowance an admin had
// deliberately set. So the confirm step names the count it is about to
// affect rather than firing on first click, the same reasoning
// reject-account-dialog.tsx uses.

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
import { setAllEditorsDailyCap, setAllEditorsWeeklyCap } from "@/actions/account";
import {
  BULK_ALLOWANCE_SCOPE_LABELS,
  dailyCapOverrideError,
  weeklyCapOverrideError,
  type BulkAllowanceScope,
} from "@/lib/allowance";
import { creditsToUsd, formatCredits } from "@/lib/format-usd";

export function AllEditorsAllowanceDialog({
  /** ADMIN_WEEKLY_CAP_USD, resolved server-side — see the per-account
   * dialog's prop doc for why this is never a client import. */
  maxWeeklyCapUsd,
  /** Accounts on the plain `editor` role. */
  editorCount,
  /** ADMIN_DAILY_CAP_USD, resolved server-side — the ceiling the daily field validates against. */
  maxDailyCapUsd,
  /** Whether the daily guard is switched on for the installation. Off hides the daily field: a number nothing enforces is a number that misleads. */
  dailyCapEnabled = false,
  /** Accounts on `trusted_editor`. Counted separately because the scope
   * below writes to one tier or the other, and the copy names the number it
   * is about to change. */
  trustedEditorCount,
}: {
  maxWeeklyCapUsd: number;
  maxDailyCapUsd: number;
  dailyCapEnabled?: boolean;
  editorCount: number;
  trustedEditorCount: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [credits, setCredits] = useState("2000");
  const [dailyCredits, setDailyCredits] = useState("400");
  // "all" is the default because it is what this control did before scopes
  // existed — an admin who opens it and clicks straight through gets the
  // behaviour they already knew.
  const [scope, setScope] = useState<BulkAllowanceScope>("all");
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  function submit(weeklyCapUsd: number | null, dailyCapUsd: number | null): void {
    setErrorMessage(null);
    setDoneMessage(null);
    startTransition(async () => {
      try {
        const result = await setAllEditorsWeeklyCap(weeklyCapUsd, scope);
        if ("error" in result) {
          setErrorMessage(result.error);
          return;
        }
        // Weekly first: it is the one that revokes grants on zero, so if it
        // fails there is nothing to unwind. Only written when the guard is
        // on — an amount nothing enforces is not worth stamping onto every
        // row, and "Use role defaults" clears both regardless.
        if (dailyCapEnabled || dailyCapUsd === null) {
          const dailyResult = await setAllEditorsDailyCap(dailyCapUsd, scope);
          if ("error" in dailyResult) {
            setErrorMessage(dailyResult.error);
            return;
          }
        }
        // Stays open on success, unlike the per-account dialog: the admin
        // just changed every editor's limit at once and the count is the
        // only confirmation that it hit who they expected.
        setDoneMessage(
          weeklyCapUsd === null
            ? `Cleared. ${result.updated} account${result.updated === 1 ? "" : "s"} back on role defaults.`
            : `Set ${formatCredits(weeklyCapUsd)} on ${result.updated} account${result.updated === 1 ? "" : "s"}.`,
        );
      } catch (error) {
        unstable_rethrow(error);
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to set the editor allowance.",
        );
      }
    });
  }

  // What the chosen scope will actually write to, so every number on screen
  // is the number the Server Action is about to change.
  const scopedCount =
    scope === "editor"
      ? editorCount
      : scope === "trusted_editor"
        ? trustedEditorCount
        : editorCount + trustedEditorCount;

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
    let dailyCapUsd: number | null = null;
    if (dailyCapEnabled) {
      const enteredDaily = Number(dailyCredits);
      if (!Number.isFinite(enteredDaily) || enteredDaily < 0) {
        setErrorMessage("Enter zero or a positive daily guard.");
        return;
      }
      dailyCapUsd = creditsToUsd(enteredDaily);
      const dailyError = dailyCapOverrideError(dailyCapUsd, maxDailyCapUsd);
      if (dailyError) {
        setErrorMessage(dailyError);
        return;
      }
    }
    submit(weeklyCapUsd, dailyCapUsd);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Set allowance by role
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Allowance by role</DialogTitle>
          <DialogDescription>
            Applies to {scopedCount} account{scopedCount === 1 ? "" : "s"} right now. Admins are
            never affected, and any allowance you set on one person individually is overwritten.
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
          {/* The one thing an admin will get wrong if it is not said here.
              This sets a value on the accounts that exist now; it does not
              change what a NEW account starts with. */}
          <p className="text-xs text-muted-foreground">
            Up to {formatCredits(maxWeeklyCapUsd)}. This is not the role default — it sets a value
            on the accounts that exist today. Someone who signs up later starts on the role default
            until you run this again. &ldquo;Use role defaults&rdquo; clears it for everyone.
          </p>
        </div>

        {/* Only when the guard is actually on. Setting a daily amount the
            installation does not enforce writes a number onto every row that
            changes nothing an editor can observe — worse than absent,
            because it reads as a limit. */}
        {dailyCapEnabled ? (
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
              A burst guard under the weekly figure above, not a second budget — anything at or over
              the weekly amount never fires. Up to {formatCredits(maxDailyCapUsd)}.
            </p>
          </div>
        ) : null}

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
        {doneMessage ? <p className="text-sm text-muted-foreground">{doneMessage}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Close
          </Button>
          <PendingButton variant="outline" onClick={() => submit(null, null)} pending={isPending}>
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
