"use client";

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow } from "next/navigation";
import { setAccountTeam } from "@/actions/account";
import { isTeam, TEAMS, TEAM_LABELS, type Team } from "@/lib/model-access";

/** Admin-only: sets which video models an account may use. Empty = no restriction. */
export function TeamSelect({
  userId,
  team,
}: {
  userId: string;
  team: Team | null;
}): JSX.Element {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function change(value: string): void {
    setError(null);
    startTransition(async () => {
      try {
        const result = await setAccountTeam(userId, isTeam(value) ? value : null);
        if (result?.error) setError(result.error);
      } catch (caught) {
        unstable_rethrow(caught);
        setError(caught instanceof Error ? caught.message : "Failed to set the team.");
      }
    });
  }

  return (
    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      Team
      <select
        aria-label="Team"
        value={team ?? ""}
        disabled={isPending}
        onChange={(event) => change(event.target.value)}
        className="h-8 rounded-md border bg-card px-2 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <option value="" className="bg-popover text-popover-foreground">
          No team
        </option>
        {TEAMS.map((value) => (
          <option key={value} value={value} className="bg-popover text-popover-foreground">
            {TEAM_LABELS[value]}
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
