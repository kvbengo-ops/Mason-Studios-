"use client";

// What happened to the images you asked for (0095_image_attempt_recovery.sql).
//
// The console's own state lives in the browser, so leaving the page threw away
// the spinner, the preview and any idea of whether a generation was still
// running. The charge was real either way. This panel is the durable answer:
// the server knows every attempt this account reserved, and this shows them and
// finishes the unfinished ones.
//
// IT OWNS NO MONEY DECISION. Every transition it can cause happens inside
// reconcilePersonalImageAttempt — this component only asks, on a timer, and
// renders what comes back.

import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import type { ImageAttempt } from "@/actions/image-generator";
import { isImageAttemptUnfinished, type ImageAttemptStatus } from "@/lib/image-attempt";
import { PendingButton } from "@/components/pending-button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { RunsTrigger } from "@/components/runs-trigger";
import { dateTimeFormatter } from "@/lib/datetime";
import { formatCredits } from "@/lib/format-usd";
import { cn } from "@/lib/utils";

/**
 * How often an unfinished attempt is re-checked.
 *
 * One kie read per tick per unfinished attempt, and a generation is ~22s
 * observed, so five seconds is a handful of reads across a normal one. The
 * timer stops the moment nothing is unfinished — see the effect below, which
 * depends on that flag rather than running forever.
 */
const POLL_INTERVAL_MS = 5000;

const ImageAttemptsContext = createContext<readonly ImageAttempt[]>([]);

export function useImageAttempts(): readonly ImageAttempt[] {
  return useContext(ImageAttemptsContext);
}

/**
 * The exact words for each state.
 *
 * `billing_unknown` gets a sentence rather than a word because it is the only
 * one that asks the operator to DO something before pressing Generate again:
 * the attempt may already have been charged, and pressing again is a second
 * real charge. Every other state is self-explanatory in one word.
 */
const STATUS_LABEL: Record<ImageAttemptStatus, string> = {
  queued: "Queued…",
  generating: "Generating…",
  completed: "Completed",
  failed: "Failed",
  billing_unknown: "Billing status unknown — check before retrying",
};

const STATUS_TONE: Record<ImageAttemptStatus, string> = {
  queued: "text-muted-foreground",
  generating: "text-muted-foreground",
  completed: "text-foreground",
  failed: "text-destructive",
  billing_unknown: "text-destructive",
};

export interface ImageAttemptPanelProps {
  children?: ReactNode;
  initialAttempts: readonly ImageAttempt[];
  /**
   * Asks the server to finish one unfinished attempt: one read of kie, then
   * settle, store, or leave it running. Returns the attempt as it now stands.
   */
  reconcileAction: (runId: string) => Promise<ImageAttempt>;
}

export function ImageAttemptPanel({
  children,
  initialAttempts,
  reconcileAction,
}: ImageAttemptPanelProps): JSX.Element | null {
  const [attempts, setAttempts] = useState<readonly ImageAttempt[]>(initialAttempts);
  const [checking, setChecking] = useState<string | null>(null);
  const manualCheck = useRef(false);

  // What the remount key used to do, without destroying the open dialog to do
  // it. A server render brings rows this component has never seen (a new
  // generation) and fresh signed URLs for the ones it has, so the prop still
  // has to win — it is read from the same database every action here writes to.
  //
  // DURING RENDER, not in an effect. React documents this as the way to reset
  // state when a prop changes ("You Might Not Need an Effect"): the re-render is
  // discarded and restarted immediately, so no stale list is ever committed to
  // the DOM and there is no second paint. An effect would set the same state one
  // commit later, which is both a cascading render and a visible flash of the
  // previous attempts.
  //
  // Identity, not contents, is the trigger: `attempts` is rebuilt by the server
  // on every render, so this fires exactly when a render delivered something
  // new, and the guard makes it idempotent — state cannot feed back into the
  // prop, so it cannot loop.
  const [lastServerAttempts, setLastServerAttempts] = useState(initialAttempts);
  if (initialAttempts !== lastServerAttempts) {
    setLastServerAttempts(initialAttempts);
    setAttempts(initialAttempts);
  }

  async function recover(runId: string): Promise<void> {
    if (manualCheck.current) return;
    manualCheck.current = true;
    setChecking(runId);
    try {
      const updated = await reconcileAction(runId);
      setAttempts((current) => current.map((row) => (row.runId === runId ? updated : row)));
    } catch {
      setAttempts((current) =>
        current.map((row) =>
          row.runId === runId
            ? { ...row, reason: "Could not check status. Please try checking again." }
            : row,
        ),
      );
    } finally {
      manualCheck.current = false;
      setChecking(null);
    }
  }

  // A tick that is still in flight must not have a second one stacked on top of
  // it: reconcile does real work (settle, upload, insert), and overlapping calls
  // for the same run would race each other through that tail.
  const ticking = useRef(false);
  // The poll reads the CURRENT list from here rather than closing over
  // `attempts`, so a long tick still asks about the rows as they stand now.
  const latest = useRef<readonly ImageAttempt[]>(initialAttempts);
  useEffect(() => {
    latest.current = attempts;
  }, [attempts]);

  const unfinished = attempts.filter((attempt) => isImageAttemptUnfinished(attempt.status));
  const hasUnfinished = unfinished.length > 0;

  const poll = useCallback(async () => {
    if (ticking.current) return;
    ticking.current = true;
    try {
      const pending = latest.current.filter((attempt) => isImageAttemptUnfinished(attempt.status));

      for (const attempt of pending) {
        try {
          const updated = await reconcileAction(attempt.runId);
          setAttempts((current) =>
            current.map((row) => (row.runId === updated.runId ? updated : row)),
          );
        } catch {
          // One attempt failing to reconcile must not stop the others, and must
          // not blank the panel. The row stays as it was and the next tick asks
          // again — the server is the source of truth, so nothing is lost by
          // simply not knowing yet.
        }
      }
    } finally {
      ticking.current = false;
    }
  }, [reconcileAction]);

  useEffect(() => {
    if (!hasUnfinished) return;
    // Immediately, then on an interval: an operator returning to a finished
    // generation should see it resolve on arrival, not five seconds later.
    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasUnfinished, poll]);

  return (
    <ImageAttemptsContext.Provider value={attempts}>
      {children}
      <Dialog>
          <RunsTrigger
            total={attempts.length}
            active={unfinished.length}
            activeLabel="Generating"
            ariaLabel={
              hasUnfinished
                ? `${unfinished.length} image generation in progress — view recent image attempts`
                : `View ${attempts.length} recent image attempts`
            }
          />
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
            <DialogTitle>Recent attempts</DialogTitle>
            <DialogDescription>
              Every image generation for this account, including work that finished after you left
              the page.
            </DialogDescription>
            <Card className="border-0 shadow-none">
              <CardHeader className="hidden" />
              <CardContent id="image-attempt-list" className="flex flex-col gap-3 p-0">
                <p className="text-xs text-muted-foreground">
                  Every generation this account has charged for, whether or not the page was open
                  when it finished.
                </p>
                {attempts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No runs yet.</p>
                ) : null}
                <ul className="flex flex-col gap-3">
                  {attempts.map((attempt) => (
                    <li
                      key={attempt.runId}
                      className="flex items-start gap-3 rounded-md border border-border p-3"
                    >
                      {attempt.image ? (
                        /* eslint-disable-next-line @next/next/no-img-element -- signed URL, not a static import */
                        <img
                          src={attempt.image.url}
                          alt=""
                          className="h-16 w-16 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <div
                          className={cn(
                            "h-16 w-16 shrink-0 rounded bg-muted",
                            isImageAttemptUnfinished(attempt.status) && "animate-pulse",
                          )}
                          aria-hidden="true"
                        />
                      )}

                      <div className="flex min-w-0 flex-col gap-1">
                        <span className={cn("text-sm font-medium", STATUS_TONE[attempt.status])}>
                          {STATUS_LABEL[attempt.status]}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {attempt.model} · {dateTimeFormatter.format(new Date(attempt.createdAt))}
                          {attempt.costUsd !== null ? ` · ${formatCredits(attempt.costUsd)}` : null}
                        </span>
                        {attempt.reason ? (
                          <span className="break-words text-xs text-muted-foreground">
                            {attempt.reason}
                          </span>
                        ) : null}
                        {/* Only when billing is unknown. That is the one case where a
                        human has to look the task up on kie's dashboard before
                        deciding whether to pay again — the same reason lib/kie.ts's
                        timeout error carries it. */}
                        {attempt.kieTaskId ? (
                          <span className="break-all font-mono text-xs text-muted-foreground">
                            kie task {attempt.kieTaskId}
                          </span>
                        ) : null}
                        {attempt.kieTaskId &&
                        !attempt.image &&
                        (attempt.status === "billing_unknown" || attempt.status === "completed") ? (
                          <PendingButton
                            type="button"
                            variant="outline"
                            size="sm"
                            className="self-start"
                            // Only THIS row's button is pending. `checking` still
                            // disables the others through `disabled` below, because
                            // recover() serialises on one ref — but a spinner on a
                            // row nobody pressed says the wrong thing about which
                            // task is being checked.
                            pending={checking === attempt.runId}
                            disabled={checking !== null}
                            onClick={() => void recover(attempt.runId)}
                          >
                            Check status / Recover image
                          </PendingButton>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </DialogContent>
      </Dialog>
    </ImageAttemptsContext.Provider>
  );
}
