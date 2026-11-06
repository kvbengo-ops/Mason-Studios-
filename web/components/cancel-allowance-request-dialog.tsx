"use client";
import { formatUsd } from "@/lib/format-usd";

// The avatar menu's pending-request cancel control (web/components/
// account-menu.tsx). requestAllowance's own returned message
// (web/actions/allowance.ts) tells an editor with a pending request to
// "cancel it below" — before this component existed, cancelAllowanceRequest
// had no caller anywhere in the UI, so that instruction pointed at nothing
// and an editor who mistakenly requested the wrong amount had no way to
// undo it short of asking an admin to deny it.
//
// CONTROLLED, not self-contained — see request-allowance-dialog.tsx's file
// header for why: its trigger now lives as a DropdownMenu.Item inside
// account-menu.tsx's Radix DropdownMenu.Content, and this Dialog is
// rendered as a SIBLING of that menu (not nested inside it), with `open`
// owned by account-menu.tsx. Nesting it inside the menu's Content would
// have it unmounted the instant the menu closes on item selection — before
// it ever got the chance to open.

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
import { cancelAllowanceRequest } from "@/actions/allowance";

export function CancelAllowanceRequestDialog({
  open,
  onOpenChange,
  requestId,
  requestedUsd,
}: {
  /** Controlled by account-menu.tsx — see this file's header for why. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  requestedUsd: number;
}): JSX.Element {
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function handleCancel(): void {
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = await cancelAllowanceRequest(requestId);
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        onOpenChange(false);
      } catch (error) {
        // cancelAllowanceRequest never redirects today — see request-
        // allowance-dialog.tsx's identical comment for why unstable_rethrow
        // stays here anyway.
        unstable_rethrow(error);
        setErrorMessage(error instanceof Error ? error.message : "Failed to cancel request.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel allowance request?</DialogTitle>
          <DialogDescription>
            Withdraws your pending request for {formatUsd(requestedUsd)}. You can submit a new one
            right away — this only clears the way for that, it does not change your current
            allowance.
          </DialogDescription>
        </DialogHeader>

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Keep it
          </Button>
          <PendingButton variant="destructive" onClick={handleCancel} pending={isPending}>
            Cancel request
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
