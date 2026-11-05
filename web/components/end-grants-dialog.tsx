"use client";

// Confirmation step for /users' "End grant" control on the Active grants
// cell (web/app/(app)/users/page.tsx).
//
// "End", not "Revoke": a revoke promises a clawback this cannot deliver.
// The money is already at the vendor. What actually happens is that the
// ceiling drops to what the account has already spent — no further renders,
// nothing taken back, and no deficit. See endActiveGrants for why landing at
// zero rather than removing the grant outright is the whole point.
//
// A dialog rather than a bare ActionForm, same reasoning as
// reject-account-dialog.tsx beside it: this removes spending power a
// colleague has been told they have, and the cell it sits in is one column
// away from a row of read-only figures. A first-click end there is a misclick
// that silently narrows someone's week.
//
// Distinct from setting the weekly allowance to 0 in WeeklyAllowanceDialog,
// which revokes outright (actions/account.ts's ZERO MEANS ZERO note) — that
// one says "this account spends nothing until I say otherwise" and persists
// past Monday; this one says "you have had enough this week" and clears on
// its own.

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
import { endActiveGrants } from "@/actions/allowance";

export function EndGrantsDialog({
  userId,
  email,
  grantCount,
  grantTotal,
  baseWeeklyAllowance,
}: {
  userId: string;
  email: string;
  grantCount: number;
  /** Already formatted by the caller, in the unit /users renders — this component does no conversion of its own. */
  grantTotal: string;
  /** The cap this account falls back to, likewise pre-formatted. Named in the copy so the admin sees what is LEFT, not only what is removed. */
  baseWeeklyAllowance: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function handleEnd(): void {
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = await endActiveGrants(userId);
        // The stale-page branch (another admin ended them first, or the last
        // grant expired between render and click) comes back as data, not a
        // throw — see lib/action-result.ts. Keep the dialog open so the
        // admin reads it where they clicked.
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        setOpen(false);
      } catch (error) {
        unstable_rethrow(error);
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to end those allowance grants.",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* Names the account for a screen reader — "Revoke" repeated once
            per row is unusable out of visual context, same as Approve and
            Reject in the cell beside it. */}
        <Button size="sm" variant="outline">
          End grant
          <span className="sr-only">
            {" "}
            of {grantTotal} for {email}
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            End {grantTotal} of granted allowance for {email}?
          </DialogTitle>
          <DialogDescription>
            {grantCount === 1 ? "Their active grant" : `All ${grantCount} of their active grants`}{" "}
            stops here. Whatever they have already spent stands — nothing is taken back, and they
            are not put into deficit. They simply cannot render again until Monday, when their{" "}
            {baseWeeklyAllowance} allowance returns on its own. Anything they had not yet spent is
            gone, and the grant stays on the record as ended rather than deleted.
          </DialogDescription>
        </DialogHeader>

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <PendingButton variant="destructive" onClick={handleEnd} pending={isPending}>
            End grant
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
