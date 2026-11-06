"use client";

// Per-scene counterpart to render-confirm-dialog.tsx, for the selective-
// regeneration path SMN-feature-spec.md § 3.7 calls THE recovery when one
// clip out of many comes out wrong: uncheck nothing, just re-render that
// scene. Same rule as the batch dialog — no button spends money without
// saying how much first — scoped to one scene's cost instead of the whole
// project's.

import { useState, useTransition } from "react";
import type { JSX, ReactNode } from "react";
import type { ActionResult } from "@/lib/action-result";
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
import { cn } from "@/lib/utils";
import { enqueueScene, rerenderScene, retryScene } from "@/actions/enqueue";
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

/**
 * Copy per kind, as tables rather than four-deep ternaries. Three separate
 * places branch on `kind` and they have to agree - a trigger that says
 * "Retry" over a dialog titled "Re-render Scene 4?" is the same drift this
 * one-component-many-moments shape exists to prevent.
 */
const TRIGGER_VERB = {
  rerender: "Re-render",
  first: "Render this scene",
  retry: "Retry",
  generate: "Generate",
} as const;

const TITLE_VERB = {
  rerender: "Re-render",
  first: "Render",
  retry: "Retry",
  generate: "Generate",
} as const;

const DESCRIPTION = {
  rerender:
    "This replaces the current clip for this scene only. The old clip is discarded and the project's assembled video will be rebuilt once the new one is done.",
  first:
    "This renders this scene only, not the rest of the project. Every other scene stays exactly where it is.",
  retry:
    "This queues a fresh attempt at this scene. The attempt that failed has already been billed — this one is billed again the moment the worker picks it up.",
  generate:
    "This queues a new clip for rendering. It cannot be undone, and it costs money the moment the worker picks it up.",
} as const;

export function SceneRerenderDialog({
  sceneId,
  sceneLabel,
  costUsd,
  settingsLabel,
  unpaidRate,
  rateSource = "kie",
  vendor,
  vendorBalanceLabel,
  budget,
  busy = false,
  kind = "rerender",
  confirmAction,
  trigger,
  notice,
}: {
  /**
   * The scene the built-in actions act on. Optional only for "generate",
   * which has no scene row yet and always supplies its own `confirmAction`.
   */
  sceneId?: string;
  /**
   * "rerender" replaces an existing clip; "first" queues a scene that has
   * never rendered; "retry" re-queues one that failed; "generate" is a clip
   * with no scene behind it yet. Same money, same guards, same dialog — only
   * the copy and which action fires differ, so they share this component
   * rather than becoming four dialogs whose numbers drift apart (the same
   * argument render-confirm-dialog.tsx makes for its own three kinds).
   *
   * "retry" and "generate" are why this list grew. Both spent on a single
   * click - retry on the stated reasoning that a failed attempt has no clip
   * to destroy, which is true and is not the question this dialog answers.
   * A retry bills a fresh attempt like any other press here, so it is asked
   * for like any other.
   */
  kind?: "rerender" | "first" | "retry" | "generate";
  /** e.g. "Scene 4" — echoed in the dialog title so a multi-scene page can't be misread as "render everything again". */
  sceneLabel: string;
  costUsd: number;
  /**
   * What this render will actually run as - "Seedance 2.5 · 480p · 4s".
   *
   * The price on its own cannot be checked against anything. A number twice
   * what the operator expected is only recognisable as wrong once the
   * settings behind it are on the same screen, and those settings are
   * exactly what a caller can get wrong: a scene keeps a sticky override
   * (0045) and a column's pickers can disagree with what the server bills.
   * So the dialog names the three values that decide the cost instead of
   * asking the operator to remember them from the screen underneath.
   *
   * Optional: the scripted pipeline's batch dialogs quote a whole project
   * and have no single triple to name.
   */
  settingsLabel?: string;
  /**
   * Set when the rate behind `credits` came off kie's published page rather
   * than a receipt — i.e. nobody has been billed at this tier yet.
   *
   * The column that opens this dialog says so too, but a caveat that lives on
   * the page and not on the dialog is a caveat the operator has scrolled past
   * by the time they approve. This is the moment money is committed, so the
   * qualification travels with the number rather than with the screen it came
   * from. Optional: the scripted pipeline never quotes an unpaid rate, and
   * passing nothing keeps its dialog unchanged.
   */
  unpaidRate?: boolean;
  /**
   * Whose published price `unpaidRate` refers to — "BytePlus" for the
   * Seedance 2.5 · BytePlus ModelArk option, kie for everything else.
   */
  rateSource?: "BytePlus" | "kie";
  /**
   * Which vendor this render bills, resolved server-side. Named next to the
   * balance below so "442 cr left" can't be misread as the other vendor's.
   * Optional: the render page mounts this dialog too and does not resolve a
   * per-scene vendor, and a dialog that hard-required it would either force
   * that page to guess or force this one to stop naming the number at all.
   */
  vendor?: string;
  /**
   * The spendable balance at `vendor`, already formatted in that vendor's
   * own unit ("442 cr", "$1.90"), or null when it could not be read.
   *
   * This is NOT the same quantity as `budget` below and the button now says
   * so. `budget` is the account's own three spend caps — what this app will
   * refuse. This is the money that exists at the vendor at all — what the
   * vendor will refuse. They move independently: an account can sit inside
   * every cap while kie's credits are exhausted, and can be over its daily
   * cap with a fully funded vendor account. The button used to show
   * min(daily, weekly, global) labelled "left", which reads as the vendor
   * balance and is not it.
   *
   * Null renders nothing rather than a dash or a zero — see
   * lib/kie-balance.ts on why an unreadable balance must not look like an
   * empty one.
   */
  vendorBalanceLabel?: string | null;
  /** Same three-cap snapshot the render gate uses — see render-confirm-dialog.tsx for why the Confirm button has to check all three, not just daily. */
  budget: RenderBudgetFigures;
  /**
   * True while something else is already running for this scene — a frame
   * regeneration, a rewrite, a retry.
   *
   * The clip is rendered FROM the reference frame, so committing $1.89
   * while that frame is being replaced buys a render of the old one and
   * throws away the $0.02 that was about to change it. The trigger is the
   * only control here that has to know: the dialog's own Confirm is already
   * gated by isPending and the caps.
   */
  busy?: boolean;
  /**
   * Replaces what Confirm submits, keeping everything else about this dialog.
   *
   * /ugc needs it: the prompt sitting in its column may have been edited since
   * the scene was saved, so the edit has to be written before the render is
   * queued or the operator pays for the words that WERE there. That is one
   * extra step before rerenderScene, not a different confirmation — the cost,
   * the vendor balance, the cap refusal and the new-vs-update choice are all
   * the same question and must not be asked twice in two places.
   *
   * Receives the chosen version mode. Absent means the built-in branch
   * (enqueueScene for "first", rerenderScene for "rerender").
   */
  confirmAction?: (versionMode: "new" | "update") => Promise<ActionResult | void>;
  /**
   * Replaces the default trigger button.
   *
   * /ugc's own button says "Regenerate scene 4 · 112 credits" — a different
   * word, a different unit, and it has to match the column it sits in. What
   * must NOT be different is the dialog behind it, which is why this is a
   * trigger override rather than a second dialog.
   */
  trigger?: ReactNode;
  /**
   * A heads-up shown above the buttons that does not block Confirm — an @tag
   * that names nothing, say. The operator reads it and decides.
   */
  notice?: string | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  /**
   * Which version this render lands in. "new" is the default because it is
   * the one that cannot lose anything — "update" deletes the clip currently
   * in this version to make room for the replacement.
   */
  const [versionMode, setVersionMode] = useState<"new" | "update">("new");
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const bindingCap = bindingRenderCap(costUsd, budget);
  const overBudget = bindingCap !== null;
  const refusalMessage = renderCapRefusalMessage(bindingCap, costUsd, budget);

  function handleConfirm(): void {
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = confirmAction
          ? await confirmAction(versionMode)
          : !sceneId
            ? { error: "There is no scene to render." }
            : kind === "first"
              ? await enqueueScene(sceneId)
              : kind === "retry"
                ? await retryScene(sceneId)
                : await rerenderScene(sceneId, versionMode);
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        setOpen(false);
      } catch (error) {
        // rerenderScene itself never redirects, but it shares actions/enqueue.ts
        // with enqueueRender — unstable_rethrow stays here so a future change
        // to this action that adds a redirect() doesn't get silently eaten by
        // the catch block, same reasoning as render-confirm-dialog.tsx.
        unstable_rethrow(error);
        setErrorMessage(error instanceof Error ? error.message : "Failed to re-render scene.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* The prominent one of the pair, deliberately. Regenerating a frame
            is $0.02 and re-rendering the clip is $1.89 — 47x apart — and
            until now both were `outline size="sm"`, identical. Two controls
            that look the same are two controls a tired operator picks
            between by position. */}
        {trigger ?? (
          <Button size="sm" disabled={busy}>
            {TRIGGER_VERB[kind]} — {usdFormatter.format(costUsd)}
            {/* The remaining balance on the button itself, not in the dialog
              after the click: the design's point is that you know this is
              your last one BEFORE you commit to it. The vendor's balance,
              in the vendor's own unit and named for the vendor — see
              vendorBalanceLabel's doc comment for why the account's spend
              caps, which is what this said before, are a different quantity
              that can read comfortably full while the vendor is empty. The
              caps still govern Confirm, and still explain themselves in
              refusalMessage below. */}
            {vendorBalanceLabel ? (
              <span className="opacity-70">
                {" · "}
                {vendorBalanceLabel} left{vendor ? ` on ${vendor}` : ""}
              </span>
            ) : null}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind === "generate" ? "Generate this clip?" : `${TITLE_VERB[kind]} ${sceneLabel}?`}
          </DialogTitle>
          <DialogDescription>{DESCRIPTION[kind]}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-1 rounded-lg border bg-muted/40 py-6">
          <span className="text-4xl font-semibold tabular-nums text-foreground">
            {usdFormatter.format(costUsd)}
          </span>
          <span className="text-sm text-muted-foreground">estimated cost for this scene</span>
          {/* The three values that DECIDE the number above them, on the same
              screen as the number - see settingsLabel's doc comment. */}
          {settingsLabel ? (
            <span className="text-xs text-muted-foreground">{settingsLabel}</span>
          ) : null}
          {unpaidRate ? (
            <span className="max-w-xs text-center text-xs text-muted-foreground">
              {rateSource === "BytePlus"
                ? "This estimate uses BytePlus ModelArk’s published token price, not a receipt; final cost depends on actual token usage."
                : "This rate is kie’s published figure, not a receipt — nobody here has been billed at this resolution yet, so it could be wrong in either direction."}
            </span>
          ) : null}
        </div>

        {/* Asked here rather than decided for them: a second attempt at the
            same idea deserves its own row, and a re-roll of a clip nobody
            liked deserves not to fill the picker with versions that are all
            the same idea. Only the first has a clip to lose, so only the
            first is destructive — and it says so. */}
        {kind === "rerender" ? (
          <div
            role="radiogroup"
            aria-label="Where this render lands"
            className="flex flex-col gap-2"
          >
            {(
              [
                {
                  value: "new" as const,
                  title: "Create a new version",
                  detail: "Keeps the current clip. You can switch back to it any time.",
                },
                {
                  value: "update" as const,
                  title: "Update this version",
                  detail: "Replaces the clip in this version. The current one is deleted.",
                },
              ] satisfies readonly { value: "new" | "update"; title: string; detail: string }[]
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={versionMode === option.value}
                disabled={isPending}
                onClick={() => setVersionMode(option.value)}
                className={cn(
                  "rounded-md border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                  versionMode === option.value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-accent",
                )}
              >
                <span className="block text-sm font-medium text-foreground">{option.title}</span>
                <span className="block text-xs text-muted-foreground">{option.detail}</span>
              </button>
            ))}
          </div>
        ) : null}

        {notice ? (
          <p
            role="status"
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground"
          >
            {notice}
          </p>
        ) : null}

        {refusalMessage ? <p className="text-sm text-destructive">{refusalMessage}</p> : null}

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <PendingButton onClick={handleConfirm} pending={isPending} disabled={overBudget}>
            {`Confirm — ${usdFormatter.format(costUsd)}`}
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
