"use client";

// One place to change an account's role, opened from the row's ⋯ menu
// ("Change role…"), instead of one menu item per role.
//
// Editor-tier rows choose among the assignable roles (setAccountRole) or Admin,
// which hands over to PromoteAdminDialog so the escalation keeps its own
// confirmation. An admin row (never the viewer's own) can only be demoted to
// trusted editor or editor (demoteAdmin).

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow } from "next/navigation";
import { demoteAdmin, setAccountRole } from "@/actions/account";
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
import { ASSIGNABLE_ROLES, ROLE_LABELS } from "@/lib/model-access";
import type { ProfileRole } from "@/types/db";

type DemotionRole = "editor" | "trusted_editor";

/** The roles this row can be moved to; the current one is listed but not selectable. */
export function roleChoices(role: ProfileRole): ProfileRole[] {
  return role === "admin" ? ["trusted_editor", "editor"] : [...ASSIGNABLE_ROLES, "admin"];
}

export function ChangeRoleDialog({
  userId,
  email,
  role,
  open,
  onOpenChange,
  onPromoteToAdmin,
}: {
  userId: string;
  email: string;
  /** The account's current role. */
  role: ProfileRole;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Picking Admin closes this dialog and opens the promote confirmation. */
  onPromoteToAdmin: () => void;
}): JSX.Element {
  const [selected, setSelected] = useState<ProfileRole | null>(null);
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function save(): void {
    if (!selected) return;
    if (selected === "admin") {
      onOpenChange(false);
      onPromoteToAdmin();
      return;
    }
    setErrorMessage(null);
    startTransition(async () => {
      try {
        // The lost-race branch (someone else changed this role first) comes
        // back as data, not a throw — see lib/action-result.ts.
        const result =
          role === "admin"
            ? await demoteAdmin(userId, selected as DemotionRole)
            : await setAccountRole(userId, selected);
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        onOpenChange(false);
      } catch (error) {
        unstable_rethrow(error);
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to change that account's role.",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change role</DialogTitle>
          <DialogDescription>
            {email} is currently {ROLE_LABELS[role]}.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="flex flex-col gap-2" disabled={isPending}>
          <legend className="sr-only">New role for {email}</legend>
          {roleChoices(role).map((choice) => {
            const current = choice === role;
            return (
              <label
                key={choice}
                className="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
              >
                <input
                  type="radio"
                  name="role"
                  value={choice}
                  checked={selected === choice}
                  disabled={current}
                  onChange={() => setSelected(choice)}
                />
                <span className="font-medium text-foreground">{ROLE_LABELS[choice]}</span>
                {current ? <span className="text-xs text-muted-foreground">Current</span> : null}
              </label>
            );
          })}
        </fieldset>
        {errorMessage ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <PendingButton pending={isPending} disabled={selected === null} onClick={save}>
            {selected === "admin" ? "Continue" : "Change role"}
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
