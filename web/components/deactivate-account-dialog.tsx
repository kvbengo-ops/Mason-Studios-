"use client";

// Cutting off a colleague who is currently working, from /users.
//
// Controlled by user-row-actions.tsx rather than self-contained, for the
// same reason WeeklyAllowanceDialog is: its trigger is a DropdownMenuItem,
// and a Dialog nested inside DropdownMenuContent unmounts the instant the
// menu closes on selection — before it ever opens.
//
// Confirmation, not a one-click menu item: approving an account grants what
// it applied for, but this takes access away from someone mid-task, and the
// menu item sits one row away from "Make trusted" on a list of near
// identical rows.

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow } from "next/navigation";
import { decideAccountApproval } from "@/actions/account";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function DeactivateAccountDialog({
  userId,
  email,
  open,
  onOpenChange,
}: {
  userId: string;
  email: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function handleDeactivate(): void {
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = await decideAccountApproval(userId, "deactivate");
        // The race branch (two admins on the list at once) comes back as
        // data, not a throw — see lib/action-result.ts. Keep the dialog open
        // so the admin reads it where they clicked.
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        onOpenChange(false);
      } catch (error) {
        unstable_rethrow(error);
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to deactivate that account.",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deactivate {email}?</DialogTitle>
          <DialogDescription>
            They lose access immediately — the next page they open signs them out to a locked
            screen, and the database refuses their reads and writes from that moment.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Nothing is deleted. Their projects, tasks and history stay exactly as they are, and you
          can turn access back on from this page.
        </p>
        {errorMessage ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Keep access
          </Button>
          <PendingButton variant="destructive" pending={isPending} onClick={handleDeactivate}>
            Deactivate
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
