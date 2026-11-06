"use client";

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow } from "next/navigation";
import { promoteToAdmin } from "@/actions/account";
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

export function PromoteAdminDialog({
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

  function handlePromote(): void {
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = await promoteToAdmin(userId);
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        onOpenChange(false);
      } catch (error) {
        unstable_rethrow(error);
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to promote that account to admin.",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Make {email} an admin?</DialogTitle>
          <DialogDescription>
            This gives them administrator access, including access to other users’ projects and
            account management.
          </DialogDescription>
        </DialogHeader>
        {errorMessage ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <PendingButton pending={isPending} onClick={handlePromote}>
            Make admin
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
