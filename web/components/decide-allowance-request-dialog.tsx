"use client";

// /allowances' Approve/Deny controls (web/app/(app)/allowances/page.tsx) —
// one row's worklist actions. Two separate triggers sharing one component
// so a stray click can't approve when the approver meant to deny or vice
// versa (SceneRerenderDialog/scene-reopen-dialog.tsx's own one-action-per-
// dialog convention, applied here to a row with two distinct decisions
// instead of one).

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
import { PendingButton } from "@/components/pending-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { decideAllowanceRequest } from "@/actions/allowance";
import { grantExpiryError, peerGrantAmountError } from "@/lib/allowance";
import { formatUsd } from "@/lib/format-usd";

/** Converts an ISO instant into the `datetime-local` input's expected local-time value — no timezone conversion beyond what the browser's own <input> already does for its display. */
function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function DecideAllowanceRequestDialog({
  requestId,
  requesterEmail,
  requestedUsd,
  reason,
  defaultGrantAmountUsd,
  defaultExpiresAtIso,
  peerMaxGrantUsd,
  currentAllowanceUsd,
  usedThisWeekUsd,
  accountFundsUsd,
  outstandingAllowanceUsd,
}: {
  requestId: string;
  requesterEmail: string;
  requestedUsd: number;
  /** The requester's own reason, shown in full before deciding. Null when they gave none. */
  reason: string | null;
  /** lib/allowance.ts's defaultGrantAmountUsd(requestedUsd), computed server-side. */
  defaultGrantAmountUsd: number;
  /** lib/spend.ts's endOfManilaWeekIso(), computed server-side — the default grant expiry. */
  defaultExpiresAtIso: string;
  /** lib/spend.ts's WEEKLY_CAP_USD, resolved server-side by the page. null for an admin - no ceiling applies. */
  peerMaxGrantUsd: number | null;
  /** This requester's effective weekly allowance (role/override cap PLUS active grants) right now. null when it couldn't be resolved — renders as "—", never a wrong number. Part 3 of the task that added this: "their current allowance." */
  currentAllowanceUsd: number | null;
  /** What this requester has used against currentAllowanceUsd so far this Manila week. null on the same failure path as currentAllowanceUsd. */
  usedThisWeekUsd: number | null;
  /** kie's real dollar balance (lib/kie-balance.ts). null means "unknown" (KIE_API_KEY unset, or any read failure) — never rendered as $0.00. */
  accountFundsUsd: number | null;
  /** Sum across every non-admin account, for the current Manila week, of max(0, effective weekly allowance - used) — lib/db-aggregates.ts's getOutstandingAllowanceUsd. Same accounts on every row of this page's table, computed once by the page. */
  outstandingAllowanceUsd: number | null;
}): JSX.Element {
  const [approveOpen, setApproveOpen] = useState(false);
  const [denyOpen, setDenyOpen] = useState(false);
  // No clamp to peerMaxGrantUsd: the default is what was requested, and
  // /allowances renders this dialog only when decisionBlockReason returns
  // null — which for a non-admin already requires the request to be at or
  // under that same ceiling. A min() here could never bind, and a clamp that
  // cannot fire is a clamp nobody can reason about later.
  const initialGrantAmountUsd = defaultGrantAmountUsd;
  const [amount, setAmount] = useState(String(initialGrantAmountUsd));
  const [expiresAt, setExpiresAt] = useState(toDatetimeLocalValue(defaultExpiresAtIso));
  const [note, setNote] = useState("");
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function handleApprove(): void {
    setErrorMessage(null);
    const enteredAmount = Number(amount);
    if (!Number.isFinite(enteredAmount) || enteredAmount <= 0) {
      setErrorMessage("Enter a positive dollar amount to grant.");
      return;
    }
    const amountUsd = enteredAmount;
    if (peerMaxGrantUsd !== null) {
      const amountError = peerGrantAmountError(amountUsd, peerMaxGrantUsd);
      if (amountError) {
        setErrorMessage(amountError);
        return;
      }
    }
    // Validate the RAW input before constructing an ISO string from it —
    // `<input type="datetime-local">` yields "" when cleared, and
    // `new Date("").toISOString()` throws a RangeError synchronously, right
    // here in onClick, outside the startTransition/try below, so it used to
    // hit the error boundary instead of the intended inline message. The
    // old NaN check ran on `new Date(expiresAtIso)` — the ALREADY-VALID ISO
    // string that line 71 would have thrown on turning it into — so it
    // could never actually be true; this checks the input `expiresAt` came
    // from instead, before anything downstream can throw on it.
    const expiresAtDate = new Date(expiresAt);
    if (Number.isNaN(expiresAtDate.getTime())) {
      setErrorMessage("Enter a valid expiry date.");
      return;
    }
    const expiresAtMs = expiresAtDate.getTime();
    // Fast-fail mirror of decideAllowanceRequest's authoritative check
    // (web/actions/allowance.ts) — see grantExpiryError's own doc comment.
    // Server-side stays the check that matters; this just avoids a round
    // trip for the common typo.
    const expiryError = grantExpiryError(expiresAtMs);
    if (expiryError) {
      setErrorMessage(expiryError);
      return;
    }
    const expiresAtIso = expiresAtDate.toISOString();

    startTransition(async () => {
      try {
        const result = await decideAllowanceRequest(requestId, "approve", {
          grantAmountUsd: amountUsd,
          expiresAt: expiresAtIso,
          note: note.trim() || null,
        });
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        setApproveOpen(false);
      } catch (error) {
        unstable_rethrow(error);
        setErrorMessage(error instanceof Error ? error.message : "Failed to approve request.");
      }
    });
  }

  function handleDeny(): void {
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = await decideAllowanceRequest(requestId, "deny", {
          note: note.trim() || null,
        });
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        setDenyOpen(false);
      } catch (error) {
        unstable_rethrow(error);
        setErrorMessage(error instanceof Error ? error.message : "Failed to deny request.");
      }
    });
  }

  return (
    <div className="flex justify-end gap-2">
      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogTrigger asChild>
          <Button size="sm">Approve</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve {requesterEmail}&apos;s request</DialogTitle>
            <DialogDescription>
              Requested {formatUsd(requestedUsd)}. This raises their WEEKLY allowance only — it
              never changes their daily burst guard. You may grant a different amount than what they
              asked for.
              {peerMaxGrantUsd !== null
                ? ` Your approval limit is ${formatUsd(peerMaxGrantUsd)}; the grant expires at the end of the current Manila week.`
                : ""}
            </DialogDescription>
          </DialogHeader>

          <RequestReason reason={reason} />

          {/* Part 3 of the task that added this: "can I approve this?"
              answered here, not on three other pages — the requester's own
              current allowance and usage, next to kie's real
              funds and the total outstanding allowance across every other
              account. "—" for any figure that couldn't be resolved, never a
              silently wrong number. */}
          <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <span>
              Current allowance:{" "}
              <span className="font-medium text-foreground">
                {currentAllowanceUsd !== null ? formatUsd(currentAllowanceUsd) : "—"}
              </span>{" "}
              · Used this week:{" "}
              <span className="font-medium text-foreground">
                {usedThisWeekUsd !== null ? formatUsd(usedThisWeekUsd) : "—"}
              </span>
            </span>
            <span>
              Account funds:{" "}
              <span className="font-medium text-foreground">
                {accountFundsUsd !== null ? formatUsd(accountFundsUsd) : "Unknown"}
              </span>{" "}
              · Outstanding allowance (all accounts):{" "}
              <span className="font-medium text-foreground">
                {outstandingAllowanceUsd !== null ? formatUsd(outstandingAllowanceUsd) : "—"}
              </span>
            </span>
            {accountFundsUsd !== null &&
            outstandingAllowanceUsd !== null &&
            outstandingAllowanceUsd > accountFundsUsd ? (
              <span className="font-medium text-warning">
                Outstanding allowance already exceeds account funds — approving more widens the gap.
              </span>
            ) : null}
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`grant-amount-${requestId}`}>Grant amount (USD)</Label>
              <Input
                id={`grant-amount-${requestId}`}
                type="number"
                min="1"
                max={peerMaxGrantUsd ?? undefined}
                step="1"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                disabled={isPending}
              />
            </div>
            {peerMaxGrantUsd === null ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`grant-expires-${requestId}`}>Expires</Label>
                <Input
                  id={`grant-expires-${requestId}`}
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                  disabled={isPending}
                />
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`grant-note-${requestId}`}>Note (optional)</Label>
              <Textarea
                id={`grant-note-${requestId}`}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                disabled={isPending}
              />
            </div>
          </div>

          {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <PendingButton onClick={handleApprove} pending={isPending}>
              Approve &amp; grant
            </PendingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={denyOpen} onOpenChange={setDenyOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">
            Deny
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deny {requesterEmail}&apos;s request?</DialogTitle>
            <DialogDescription>
              Requested {formatUsd(requestedUsd)}. No grant is created — their allowance stays
              exactly where it is.
            </DialogDescription>
          </DialogHeader>

          <RequestReason reason={reason} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`deny-note-${requestId}`}>Note (optional)</Label>
            <Textarea
              id={`deny-note-${requestId}`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={isPending}
            />
          </div>

          {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDenyOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <PendingButton variant="destructive" onClick={handleDeny} pending={isPending}>
              Deny
            </PendingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The requester's reason, in full: the table row truncates it, and it is what is being decided. */
function RequestReason({ reason }: { reason: string | null }): JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-3">
      <span className="text-xs font-medium text-muted-foreground">Reason</span>
      <p className="max-h-48 overflow-y-auto text-sm whitespace-pre-wrap break-words text-foreground">
        {reason?.trim() ? reason : "No reason given."}
      </p>
    </div>
  );
}
