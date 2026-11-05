"use client";

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow } from "next/navigation";
import { passAllowance } from "@/actions/transfer";
import { passBlockReason } from "@/lib/transfer";
import { creditsToUsd, formatCredits, remainingForDisplayUsd } from "@/lib/format-usd";
import type { ProfileRole } from "@/types/db";
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

/** The session-scoped transfer_recipients RPC is fetched by the server. */
export interface TransferRecipient {
  id: string;
  username: string;
  email: string;
  role: ProfileRole;
}

// Controlled outside the account dropdown: closing its menu must not unmount
// this dialog, just as with RequestAllowanceDialog.
export function PassCreditsDialog({
  open,
  onOpenChange,
  senderId,
  senderRole,
  headroomUsd,
  recipients,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  senderId: string;
  senderRole: ProfileRole;
  headroomUsd: number;
  /** null means the server read failed; [] means there are no eligible peers. */
  recipients: TransferRecipient[] | null;
}): JSX.Element {
  const [recipientId, setRecipientId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const amountUsd = creditsToUsd(Number(amount));

  function handlePass(): void {
    setErrorMessage(null);
    const recipient = recipients?.find((entry) => entry.id === recipientId);
    if (!recipient) {
      setErrorMessage("Choose a recipient.");
      return;
    }
    const reason = passBlockReason({
      senderId,
      senderRole,
      recipientId: recipient.id,
      recipientRole: recipient.role,
      amountUsd,
      headroomUsd,
    });
    if (reason) {
      setErrorMessage(reason);
      return;
    }
    startTransition(async () => {
      try {
        const result = await passAllowance(recipient.id, amountUsd, note.trim() || undefined);
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        setRecipientId("");
        setAmount("");
        setNote("");
        onOpenChange(false);
      } catch (error) {
        unstable_rethrow(error);
        setErrorMessage(error instanceof Error ? error.message : "Failed to pass credits.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pass credits</DialogTitle>
          <DialogDescription>
            Pass part of your weekly allowance to a colleague. The pass expires at the end of this
            Manila week and is not returned. Unspent headroom for both of you stops existing on
            Monday.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pass-recipient">Recipient</Label>
            <select
              id="pass-recipient"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              value={recipientId}
              onChange={(event) => setRecipientId(event.target.value)}
              disabled={isPending || !recipients?.length}
            >
              <option className="bg-popover text-popover-foreground" value="">
                Choose a recipient
              </option>
              {recipients?.map((recipient) => (
                <option
                  className="bg-popover text-popover-foreground"
                  key={recipient.id}
                  value={recipient.id}
                >
                  {recipient.username || recipient.email}
                </option>
              ))}
            </select>
            {recipients === null ? (
              <p className="text-sm text-destructive">
                Recipients could not be loaded. Refresh to try again.
              </p>
            ) : recipients.length === 0 ? (
              <p className="text-sm text-muted-foreground">No eligible colleagues are available.</p>
            ) : null}
          </div>
          <p className="text-sm tabular-nums">
            Remaining this week: {formatCredits(remainingForDisplayUsd(headroomUsd))}
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pass-amount">Amount (credits)</Label>
            <Input
              id="pass-amount"
              type="number"
              min="1"
              step="1"
              value={amount}
              // DIGITS ONLY, filtered on the way in. `min="1"` is advisory
              // here: the browser enforces it on native form submission and
              // this dialog submits from a button, so "-50" was typeable and
              // reached passBlockReason to be refused after the fact. Credits
              // are whole (step="1"), so stripping everything but digits also
              // drops "-", "e" and "." — every character a number input
              // accepts that this field has no meaning for.
              onChange={(event) => setAmount(event.target.value.replace(/[^0-9]/g, ""))}
              disabled={isPending}
            />
          </div>
          <p className="text-sm tabular-nums">
            Remaining after pass:{" "}
            {Number.isFinite(amountUsd) ? formatCredits(Math.max(0, headroomUsd - amountUsd)) : "—"}
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pass-note">Note (optional)</Label>
            <Textarea
              id="pass-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={isPending}
            />
          </div>
        </div>
        {errorMessage ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <PendingButton onClick={handlePass} pending={isPending}>
            Pass credits
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
