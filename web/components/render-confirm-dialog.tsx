"use client";

// The last free moment before step 7 spends real money
// (docs/architecture.md § "User flow": "Step 7 is irreversible."). Deliberately
// small and single-purpose — the estimated cost is the most prominent thing
// in the dialog on purpose.
//
// One component covers three moments, not three copies of this dialog:
// the initial "render everything" gate (`all`), the "render what's left"
// card a partial/test render leaves behind (`remaining`), and the
// single-scene "try before you commit" control (`test`). They share every
// line of budget-check and redirect-handling logic below — the SMN-review
// finding this file exists to avoid is exactly this dialog re-implemented
// three times with the numbers drifting apart. Only the copy and which
// server action fires change per `kind`.

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
import { enqueueRender, enqueueTestScene } from "@/actions/enqueue";
import {
  bindingRenderCap,
  renderCapRefusalMessage,
  type RenderBudgetFigures,
} from "@/lib/render-budget";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export type RenderConfirmKind = "all" | "remaining" | "test";

export function RenderConfirmDialog({
  projectId,
  kind,
  totalUsd,
  budget,
  sceneCount,
  resolution,
  fps,
}: {
  projectId: string;
  /**
   * `"all"` — nothing has rendered yet, this queues every scene.
   * `"remaining"` — a prior (test or partial) render left some scenes
   * already spent; this queues only what's still waiting.
   * `"test"` — queues scene 1 alone, ahead of the batch.
   * Purely a copy/action switch — every guard and every dollar figure below
   * comes from the caller, never re-derived here, so the three moments
   * can't quote a different price than the one that was actually computed
   * server-side.
   */
  kind: RenderConfirmKind;
  totalUsd: number;
  /** lib/spend.ts's getAccountBudgetSnapshot(userId, profile), threaded as plain data — see lib/render-budget.ts's bindingRenderCap for why all three ceilings (not just daily) have to reach this dialog. */
  budget: RenderBudgetFigures;
  sceneCount: number;
  /**
   * Echoed back in the dialog because resolution is what makes totalUsd a
   * 4x range. A confirmation that shows only the number leaves the operator
   * unable to tell an expensive-but-intended 2160p render from a
   * misconfigured one, which is the difference this dialog exists to catch.
   */
  resolution: string;
  fps: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // The server (assertWithinSpendCaps, enforced in actions/enqueue.ts) is
  // the real gate, checked global -> weekly -> daily. This is the UI's
  // early warning, checked in the same order via bindingRenderCap so it
  // can't disagree with the server about which ceiling refuses this render
  // — the historical bug this dialog used to have (see lib/render-
  // budget.ts's bindingRenderCap doc comment) checked daily remaining
  // only, so an account out of WEEKLY allowance but still under its daily
  // guard saw Confirm stay enabled right up until the server refused it.
  // Same rule for all three kinds — a test render is still real money.
  const bindingCap = bindingRenderCap(totalUsd, budget);
  const overBudget = bindingCap !== null;
  const refusalMessage = renderCapRefusalMessage(bindingCap, totalUsd, budget);

  function handleConfirm(): void {
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result =
          kind === "test" ? await enqueueTestScene(projectId) : await enqueueRender(projectId);
        if (result?.error) {
          setErrorMessage(result.error);
        }
      } catch (error) {
        // Both actions redirect() to the render page on success — that's a
        // thrown NEXT_REDIRECT control-flow error, not a failure.
        // unstable_rethrow lets it through to Next's navigation handling;
        // without it, a successful enqueue would get reported here as
        // "Failed to enqueue render" and the dialog would never navigate,
        // even though the render had already been queued.
        unstable_rethrow(error);
        setErrorMessage(error instanceof Error ? error.message : "Failed to enqueue render.");
      }
    });
  }

  const triggerLabel =
    kind === "all"
      ? `Render all — ${usdFormatter.format(totalUsd)}`
      : kind === "remaining"
        ? `Render remaining ${sceneCount} — ${usdFormatter.format(totalUsd)}`
        : `Test scene 1 only — ${usdFormatter.format(totalUsd)}`;

  const title =
    kind === "all"
      ? `Render ${sceneCount} scenes?`
      : kind === "remaining"
        ? `Render the remaining ${sceneCount} scenes?`
        : "Test scene 1 only?";

  const description =
    kind === "all"
      ? "This submits every scene to the render queue. It cannot be undone, and each scene costs " +
        "money the moment the worker picks it up."
      : kind === "remaining"
        ? "This submits every scene still waiting for a render — scenes already queued, rendering, " +
          "or done are left alone. It cannot be undone, and each scene costs money the moment the " +
          "worker picks it up."
        : "Renders just the first scene so you can check it before committing to the rest of the " +
          "batch — the cheapest way to catch a bad prompt. It cannot be undone, and this scene " +
          "costs money the moment the worker picks it up.";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size={kind === "test" ? "default" : "lg"}
          variant={kind === "test" ? "outline" : "default"}
        >
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-1 rounded-lg border bg-muted/40 py-6">
          <span className="text-4xl font-semibold tabular-nums text-foreground">
            {usdFormatter.format(totalUsd)}
          </span>
          <span className="text-sm text-muted-foreground">
            estimated total · {resolution} · {fps} fps
          </span>
        </div>

        <p className="text-sm text-muted-foreground">
          Left today after this render:{" "}
          <span
            className={
              budget.dailyRemainingUsd - totalUsd < 0
                ? "font-medium text-destructive"
                : "font-medium text-foreground"
            }
          >
            {usdFormatter.format(budget.dailyRemainingUsd - totalUsd)}
          </span>
        </p>

        {/* Names WHICH cap binds (global/weekly/daily), not just a number —
            an editor staring at a disabled Confirm button needs "why can't
            I do this right now", and the daily-only figure above can't
            answer that when weekly or the team cap is what's actually
            refusing this render. See lib/render-budget.ts's
            renderCapRefusalMessage. */}
        {refusalMessage ? <p className="text-sm text-destructive">{refusalMessage}</p> : null}

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <PendingButton onClick={handleConfirm} pending={isPending} disabled={overBudget}>
            {`Confirm — ${usdFormatter.format(totalUsd)}`}
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
