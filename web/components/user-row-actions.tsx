"use client";

// The per-row actions menu on /users.
//
// Editor rows get role/access actions; admin rows get only the allowance item.
//
// APPROVE AND REJECT ARE DELIBERATELY NOT IN HERE. Those are the decision a
// pending row is ASKING for, not housekeeping an admin goes looking for —
// burying a question behind a click is how it stops getting answered. They
// stay inline in the same cell, which is why that cell renders one thing or
// the other and never both: an account is either awaiting a decision or
// past it.

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow } from "next/navigation";
import { MoreHorizontalIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { WeeklyAllowanceDialog } from "@/components/weekly-allowance-dialog";
import { DeactivateAccountDialog } from "@/components/deactivate-account-dialog";
import { PromoteAdminDialog } from "@/components/promote-admin-dialog";
import { demoteAdmin, setAccountRole } from "@/actions/account";
import { ASSIGNABLE_ROLES, type AssignableRole } from "@/lib/model-access";
import type { ProfileRole } from "@/types/db";

const MAKE_ROLE_LABEL: Record<AssignableRole, string> = {
  editor: "Make editor",
  trusted_editor: "Make trusted",
  hybrid_editor: "Make Hybrid Editor",
  ai_animator: "Make AI Animator",
};

export function UserRowActions({
  userId,
  email,
  role,
  allowanceOnly = false,
  /** Admin rows only: offer demotion. False on the viewer's own row. */
  canDemote = false,
  /** Null when lib/spend did not load — the allowance item is hidden rather than offering a control that cannot validate its own input. */
  allowance,
}: {
  userId: string;
  email: string;
  /** The row's current role: the menu offers every OTHER non-admin role (setAccountRole). */
  role: ProfileRole;
  allowanceOnly?: boolean;
  canDemote?: boolean;
  allowance: {
    effectiveWeeklyCapUsd: number;
    hasOverride: boolean;
    maxWeeklyCapUsd: number;
    effectiveDailyCapUsd: number;
    hasDailyOverride: boolean;
    maxDailyCapUsd: number;
    dailyCapEnabled: boolean;
    effectiveHourlyCapUsd: number | null;
    hasHourlyOverride: boolean;
    globalCapExempt?: boolean;
  } | null;
}): JSX.Element {
  const [allowanceOpen, setAllowanceOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [promoteAdminOpen, setPromoteAdminOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function changeRole(next: ProfileRole): void {
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = await setAccountRole(userId, next);
        // The lost-race branch (someone else changed this role first) comes
        // back as data, not a throw — see lib/action-result.ts.
        if (result?.error) setErrorMessage(result.error);
      } catch (error) {
        unstable_rethrow(error);
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to change that account's role.",
        );
      }
    });
  }

  function demote(role: "editor" | "trusted_editor"): void {
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = await demoteAdmin(userId, role);
        if (result?.error) setErrorMessage(result.error);
      } catch (error) {
        unstable_rethrow(error);
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to change that account's role.",
        );
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* The row's own identity is in the label, not the icon: "Actions"
              repeated down a column is unusable to a screen reader without
              saying whose. */}
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" disabled={isPending}>
            <MoreHorizontalIcon className="h-4 w-4" />
            <span className="sr-only">Actions for {email}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!allowanceOnly ? (
            <>
              {/* Every non-admin role but the current one (0131 added Hybrid Editor and
                  AI Animator). Admin has its own confirm dialog below. */}
              {ASSIGNABLE_ROLES.filter((next) => next !== role).map((next) => (
                <DropdownMenuItem key={next} onSelect={() => changeRole(next)}>
                  {MAKE_ROLE_LABEL[next]}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setPromoteAdminOpen(true);
                }}
              >
                Make admin
              </DropdownMenuItem>
            </>
          ) : null}
          {canDemote ? (
            <>
              <DropdownMenuItem onSelect={() => demote("trusted_editor")}>
                Make trusted editor
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => demote("editor")}>Make editor</DropdownMenuItem>
            </>
          ) : null}
          {allowance ? (
            <DropdownMenuItem
              // preventDefault, or the menu closes and takes the dialog's
              // mount point with it before the dialog can open — the same
              // pattern components/account-menu.tsx uses for its own dialogs.
              onSelect={(event) => {
                event.preventDefault();
                setAllowanceOpen(true);
              }}
            >
              Allowance
            </DropdownMenuItem>
          ) : null}
          {/* Last, and styled as the destructive one: it sits on a menu whose
              other items adjust an account, while this one ends its access. */}
          {!allowanceOnly ? (
            <DropdownMenuItem
              variant="destructive"
              onSelect={(event) => {
                event.preventDefault();
                setDeactivateOpen(true);
              }}
            >
              Deactivate account
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Rendered OUTSIDE the menu, controlled by this component: a Dialog
          nested inside DropdownMenuContent unmounts with the menu. */}
      {allowance && allowanceOpen ? (
        <WeeklyAllowanceDialog
          userId={userId}
          email={email}
          open={allowanceOpen}
          onOpenChange={setAllowanceOpen}
          {...allowance}
        />
      ) : null}

      {!allowanceOnly ? (
        <DeactivateAccountDialog
          userId={userId}
          email={email}
          open={deactivateOpen}
          onOpenChange={setDeactivateOpen}
        />
      ) : null}

      {!allowanceOnly ? (
        <PromoteAdminDialog
          userId={userId}
          email={email}
          open={promoteAdminOpen}
          onOpenChange={setPromoteAdminOpen}
        />
      ) : null}

      {errorMessage ? (
        <span className="max-w-48 text-right text-xs text-destructive">{errorMessage}</span>
      ) : null}
    </div>
  );
}
