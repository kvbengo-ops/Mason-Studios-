"use client";

// /create's Video tab twin of the image Runs pill (image-attempt-panel.tsx):
// every video attempt, newest first, with what it cost — plus the clips still
// queued or rendering. Read-only — a video attempt is finished by the worker,
// not by this page.

import type { JSX } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { RunsTrigger } from "@/components/runs-trigger";
import { Spinner } from "@/components/spinner";
import { dateTimeFormatter } from "@/lib/datetime";
import { formatCredits } from "@/lib/format-usd";
import { cn } from "@/lib/utils";

export interface VideoRun {
  id: string;
  createdAt: string;
  status: "queued" | "rendering" | "done" | "failed";
  modelLabel: string;
  prompt: string;
  /** runs.cost_usd; null when kie never billed the attempt. */
  costUsd: number | null;
  reason: string | null;
  /** What a failure kie did not bill gave back to the caps; null otherwise. */
  returnedUsd: number | null;
}

const STATUS_LABEL: Record<VideoRun["status"], string> = {
  queued: "Queued…",
  rendering: "Rendering…",
  done: "Done",
  failed: "Failed",
};

function inFlight(run: VideoRun): boolean {
  return run.status === "queued" || run.status === "rendering";
}

export function VideoRunsPanel({ runs }: { runs: readonly VideoRun[] }): JSX.Element {
  const active = runs.filter(inFlight).length;
  return (
    <Dialog>
      <RunsTrigger
        total={runs.length}
        active={active}
        activeLabel="Rendering"
        ariaLabel={
          active > 0
            ? `${active} video rendering — view recent video runs`
            : `View ${runs.length} recent video runs`
        }
      />
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle>Recent video runs</DialogTitle>
        <DialogDescription>
          Every video attempt for this account and the credits it spent.
        </DialogDescription>
        {runs.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet.</p> : null}
        <ul className="flex flex-col gap-3">
          {runs.map((run) => (
            <li
              key={run.id}
              className={cn(
                "flex flex-col gap-1 rounded-md border p-3",
                inFlight(run) ? "border-primary/60" : "border-border",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span
                  className={cn(
                    "inline-flex items-center gap-2 text-sm font-medium",
                    run.status === "failed" ? "text-destructive" : "text-foreground",
                  )}
                >
                  {inFlight(run) ? <Spinner /> : null}
                  {STATUS_LABEL[run.status]}
                </span>
                {/* Nothing is billed until the render finishes, so an
                    in-flight row has no cost to show yet. */}
                {run.costUsd !== null || !inFlight(run) ? (
                  <span className="text-sm font-medium tabular-nums">
                    {run.costUsd !== null ? formatCredits(run.costUsd) : "Not billed"}
                  </span>
                ) : null}
              </div>
              <span className="text-xs text-muted-foreground">
                {run.modelLabel} · {dateTimeFormatter.format(new Date(run.createdAt))}
              </span>
              {run.prompt ? <p className="line-clamp-2 break-words text-xs">{run.prompt}</p> : null}
              {run.reason ? (
                <span className="break-words text-xs text-muted-foreground">{run.reason}</span>
              ) : null}
              {/* A failure kie did not bill records no cost (worker's
                  kie.FailedRunCost), so it no longer counts against the caps. */}
              {run.status === "failed" && run.costUsd === null ? (
                <span
                  role="status"
                  className="self-start rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary"
                >
                  {run.returnedUsd !== null
                    ? `+${formatCredits(run.returnedUsd)} returned — not charged, back in your allowance.`
                    : "Not charged — the credits went back to your allowance."}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
