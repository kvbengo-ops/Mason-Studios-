"use client";

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow } from "next/navigation";
import { setAccountRole } from "@/actions/account";
import { ASSIGNABLE_ROLES, ROLE_LABELS } from "@/lib/model-access";
import type { ProfileRole } from "@/types/db";

/**
 * Admin-only: sets a non-admin account's role (editor, trusted editor, Hybrid Editor,
 * AI Animator). Admins are shown, not changed, here: promote/demote own that.
 */
export function RoleSelect({ userId, role }: { userId: string; role: ProfileRole }): JSX.Element {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (role === "admin") return <></>;

  function change(value: string): void {
    setError(null);
    startTransition(async () => {
      try {
        const result = await setAccountRole(userId, value);
        if (result?.error) setError(result.error);
      } catch (caught) {
        unstable_rethrow(caught);
        setError(caught instanceof Error ? caught.message : "Failed to set the role.");
      }
    });
  }

  return (
    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      Role
      <select
        aria-label="Role"
        value={role}
        disabled={isPending}
        onChange={(event) => change(event.target.value)}
        className="h-8 rounded-md border bg-card px-2 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {ASSIGNABLE_ROLES.map((value) => (
          <option key={value} value={value} className="bg-popover text-popover-foreground">
            {ROLE_LABELS[value]}
          </option>
        ))}
      </select>
      {error ? (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      ) : null}
    </label>
  );
}
