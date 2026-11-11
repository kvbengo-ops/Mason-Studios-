"use client";

// Sidebar's "Request more" affordance, now surfaced from inside the avatar
// menu (web/components/account-menu.tsx) rather than the old bare footer.
// `state` is what still varies across the honest messages below; the
// control itself is always rendered when there's no pending request — see
// lib/sidebar-budget.ts's header for why gating its EXISTENCE on
// canRequestMore was the original bug.
//
// CONTROLLED, not self-contained: this used to own its own `open` state and
// a <DialogTrigger> button. It no longer does, because its trigger now
// lives as a DropdownMenu.Item inside account-menu.tsx's Radix
// DropdownMenu.Content — and Radix's dropdown unmounts its Content (and
// everything nested inside it) the instant the menu closes, which happens
// on every item selection. A Dialog nested in that tree would never get
// the chance to open: the menu closes on the same click that was supposed
// to open it. account-menu.tsx renders this component as a SIBLING of the
// DropdownMenu, not a descendant, and owns `open` itself — the documented
// Radix composition pattern for "dialog opened from a menu item". Only the
// dialog's own submit/cancel plumbing lives here now.
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
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { requestAllowance } from "@/actions/allowance";
// Type-only import: erased at compile time, so this carries none of
// lib/spend.ts's runtime (including its module-load-throw-on-bad-env-var
// risk — see lib/sidebar-budget.ts's header) into this Client Component's
// bundle. Only the string-union shape crosses, same as any other plain
// prop type.
import type { AllowanceDialogState } from "@/lib/spend";
import { remainingForDisplayUsd, formatUsd } from "@/lib/format-usd";

/**
 * The three honest states this dialog can be in, per the task that added
 * them: the WEEKLY-only-exhausted case is the ordinary request flow and
 * keeps its original wording; "headroom" and the three "blocked-*" states
 * are new — they let the control stay visible even when requesting won't
 * (yet, or right now) do anything, by saying so instead of hiding.
 *
 * Pure and exported so it's unit-testable without mounting this component —
 * this repo's tests run under vitest/node, no React renderer (see
 * vitest.config.ts).
 */
export function requestAllowanceDescription(
  state: AllowanceDialogState,
  weeklyRemainingUsd: number,
  weeklyCapUsd: number,
  globalCapPeriod: "daily" | "weekly" = "daily",
): string {
  switch (state) {
    case "normal":
      return (
        "You've used your allowance. Ask an admin for more — a grant raises today's limit " +
        "until 5:00 AM Asia/Manila, then you're back to your normal cap. They can grant a " +
        "different amount than what you request, so this is a starting point, not a promise."
      );
    case "headroom":
      return (
        `You have ${formatUsd(remainingForDisplayUsd(weeklyRemainingUsd))} of ${formatUsd(weeklyCapUsd)} ` +
        "left this week. You can still ask, and an admin can approve ahead of time — useful if " +
        "you know a big render is coming."
      );
    case "blocked-global":
      return (
        `Requesting more won't unblock you right now — the team's shared ${globalCapPeriod} cap is what's ` +
        `stopping you, not your own usage. A grant doesn't change that. It resets at 5:00 AM Manila time ${globalCapPeriod === "weekly" ? "on Monday" : "tomorrow"}.`
      );
    case "blocked-hourly":
      return (
        "Requesting more won't unblock you right now — your rolling-hour cap is stopping you. " +
        "Earlier spend frees up as it ages past 60 minutes; a grant doesn't change it."
      );
  }
}

export function RequestAllowanceDialog({
  open,
  onOpenChange,
  state,
  weeklyRemainingUsd,
  weeklyCapUsd,
  globalCapPeriod = "daily",
}: {
  /** Controlled by account-menu.tsx — see this file's header for why. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** lib/spend.ts's allowanceDialogState() — which of the four messages above to show. */
  state: AllowanceDialogState;
  /** Only used by the "headroom" message; harmless to pass in every other state. */
  weeklyRemainingUsd: number;
  weeklyCapUsd: number;
  globalCapPeriod?: "daily" | "weekly";
}): JSX.Element {
  const [amount, setAmount] = useState("10");
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function handleSubmit(): void {
    setErrorMessage(null);
    const enteredAmount = Number(amount);
    if (!Number.isFinite(enteredAmount) || enteredAmount <= 0) {
      setErrorMessage("Enter a positive dollar amount.");
      return;
    }
    const amountUsd = enteredAmount;

    startTransition(async () => {
      try {
        const result = await requestAllowance(amountUsd, reason.trim() || null);
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        onOpenChange(false);
        setReason("");
      } catch (error) {
        // requestAllowance never redirects today, but unstable_rethrow stays
        // here so a future change that adds one doesn't get silently eaten
        // by the catch below — same reasoning as every other dialog in this
        // codebase (see scene-rerender-dialog.tsx).
        unstable_rethrow(error);
        setErrorMessage(error instanceof Error ? error.message : "Failed to submit request.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request more allowance</DialogTitle>
          <DialogDescription>
            {requestAllowanceDescription(state, weeklyRemainingUsd, weeklyCapUsd, globalCapPeriod)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="allowance-amount">Amount (USD)</Label>
            <Input
              id="allowance-amount"
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              disabled={isPending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="allowance-reason">Reason (optional)</Label>
            <Textarea
              id="allowance-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="What's this for?"
              disabled={isPending}
            />
          </div>
        </div>

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <PendingButton onClick={handleSubmit} pending={isPending}>
            Submit request
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
