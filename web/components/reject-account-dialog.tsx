"use client";

// Confirmation step for /users' Reject button (web/app/(app)/users/page.tsx).
// Reject used to fire on the first click, straight from an ActionForm, next
// to Approve and one row over from every other account — a misclick that
// locked a real colleague out of the app with nothing in between. Same
// one-action-per-dialog shape as decide-allowance-request-dialog.tsx's Deny
// half, which is the closest thing this app already has to this decision.
//
// Not a shared "decide account" dialog covering Approve too: approve has
// nothing to confirm (it grants exactly the access the account was applying
// for), so a dialog there would be a click every admin learns to dismiss —
// which is how a confirmation stops meaning anything.

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
import { decideAccountApproval } from "@/actions/account";

export function RejectAccountDialog({
  userId,
  email,
}: {
  userId: string;
  email: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function handleReject(): void {
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = await decideAccountApproval(userId, "reject");
        // The race branch (two admins on the list at once) comes back as
        // data, not a throw — see lib/action-result.ts. Keep the dialog
        // open so the admin reads it where they clicked.
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        setOpen(false);
      } catch (error) {
        unstable_rethrow(error);
        setErrorMessage(error instanceof Error ? error.message : "Failed to reject that account.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* Names the account for a screen reader, same as the Approve
            button beside it — "Reject" repeated once per row is unusable
            out of visual context. */}
        <Button size="sm" variant="outline">
          Reject<span className="sr-only"> {email}</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject {email}?</DialogTitle>
          <DialogDescription>
            They stay held at /pending and cannot use the app. Nothing is deleted, and this is not
            final — Approve on the same row puts them back to active if this was a misclick.
          </DialogDescription>
        </DialogHeader>

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <PendingButton variant="destructive" onClick={handleReject} pending={isPending}>
            Reject
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
