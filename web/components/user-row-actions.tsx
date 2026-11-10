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

import { useState } from "react";
import type { JSX } from "react";
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
import { BurnDrawer, type BurnDrawerAccount } from "@/components/burn-drawer";
import { ChangeRoleDialog } from "@/components/change-role-dialog";
import type { ProfileRole } from "@/types/db";

export function UserRowActions({
  userId,
  email,
  role,
  allowanceOnly = false,
  /** Admin rows only: offer demotion. False on the viewer's own row. */
  canDemote = false,
  /** Null when lib/spend did not load — the allowance item is hidden rather than offering a control that cannot validate its own input. */
  allowance,
  burn = null,
}: {
  userId: string;
  email: string;
  /** The row's current role, shown and excluded in Change role…. */
  role: ProfileRole;
  allowanceOnly?: boolean;
  canDemote?: boolean;
  allowance: {
    effectiveWeeklyCapUsd: number;
    activeGrantsUsd?: number;
    hasDailyCapSwitch?: boolean;
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
  /** What the burn drawer's header needs; null leaves "View burn" out of the menu. */
  burn?: Omit<BurnDrawerAccount, "userId" | "email" | "role"> | null;
}): JSX.Element {
  const [burnOpen, setBurnOpen] = useState(false);
  const [allowanceOpen, setAllowanceOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [promoteAdminOpen, setPromoteAdminOpen] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);

  return (
    <div className="flex flex-col items-end gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* The row's own identity is in the label, not the icon: "Actions"
              repeated down a column is unusable to a screen reader without
              saying whose. */}
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
            <MoreHorizontalIcon className="h-4 w-4" />
            <span className="sr-only">Actions for {email}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {burn ? (
            <DropdownMenuItem
              // Same preventDefault reason as Allowance below: the drawer is
              // rendered outside the menu and must outlive it.
              onSelect={(event) => {
                event.preventDefault();
                setBurnOpen(true);
              }}
            >
              View burn
            </DropdownMenuItem>
          ) : null}
          {/* Every role change lives behind this one item: editor-tier rows
              pick any other role or Admin, an admin row (not the viewer's own)
              can only be demoted. An admin row without that has nothing to change. */}
          {!allowanceOnly || canDemote ? (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setRoleOpen(true);
              }}
            >
              Change role…
            </DropdownMenuItem>
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
      {burn && burnOpen ? (
        <BurnDrawer
          account={{ userId, email, role, ...burn }}
          open={burnOpen}
          onOpenChange={setBurnOpen}
        />
      ) : null}

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

      {roleOpen ? (
        <ChangeRoleDialog
          userId={userId}
          email={email}
          role={role}
          open={roleOpen}
          onOpenChange={setRoleOpen}
          onPromoteToAdmin={() => setPromoteAdminOpen(true)}
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
    </div>
  );
}
