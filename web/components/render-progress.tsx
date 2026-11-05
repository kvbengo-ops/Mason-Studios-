"use client";

// Step 8 — Watch (docs/architecture.md § "User flow": "Realtime progress,
// per-scene retry"). Subscribes to `postgres_changes` UPDATE events on
// `scenes` for this project — the only column the Go worker writes back
// there is `status` (plus kie_task_id/submitted_at — a column name kept
// from the fal era, unrenamed), so that's all a Realtime payload can ever
// carry. This component never calls kie or writes scene status itself;
// retries go through actions/enqueue.ts.
//
// Realtime is the primary channel, but it is not guaranteed: a carrier
// firewall, captive portal, or a socket that drops without visibly erroring
// (routine on 3G/4G) can leave this screen frozen on stale status while a
// render keeps running — and billing — in the background, with no way to
// recover short of a manual reload. `connectionStatus` below tracks
// `subscribe()`'s own status callback so this component knows when that has
// happened, and falls back to polling `getSceneStatuses` until either the
// channel recovers to SUBSCRIBED or the batch reaches a terminal state.
//
// Failure reasons (runs.error, classified by lib/render-error.ts) live on
// `runs`, not `scenes`, so a Realtime UPDATE can never carry one — a scene
// flipping to 'failed' arrives with no reason attached. The `postgres_changes`
// handler below detects exactly that transition (into 'failed' from
// something else) and, only then, calls the same `getSceneStatuses` the
// polling fallback already uses to fetch the classified reason for the
// whole project in one query and merge it in — a one-shot, event-triggered
// fetch, not a second poller running alongside the interval-based fallback.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { JSX } from "react";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { CircleCheck, CircleX } from "lucide-react";
import {
  REALTIME_SUBSCRIBE_STATES,
  type RealtimePostgresChangesPayload,
} from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { getSceneStatuses, retryAllFailed } from "@/actions/enqueue";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { StatusIcon } from "@/components/status-icon";
import { SceneRerenderDialog } from "@/components/scene-rerender-dialog";
import { RenderConfirmDialog } from "@/components/render-confirm-dialog";
import { cn } from "@/lib/utils";
import { elapsedLabel, isRenderInFlight, renderOriginMs } from "@/lib/render-elapsed";
import { estimateCost, estimateUsdForScenes, type EstimatableBrief } from "@/lib/estimate";
import {
  bindingRenderCap,
  renderCapRefusalMessage,
  type RenderBudgetFigures,
} from "@/lib/render-budget";
import {
  VIDEO_MODELS,
  mergeRenderSettings,
  priceForSecond,
  type RenderSettings,
  type VideoModelDescriptor,
} from "@/lib/models";
import type { RenderErrorInfo } from "@/lib/render-error";
import type { Database, SceneStatus } from "@/types/db";

type SceneRow = Database["public"]["Tables"]["scenes"]["Row"];

export interface RenderProgressScene {
  id: string;
  idx: number;
  is_talking_head: boolean;
  status: SceneStatus;
  duration_s: number;
  // Needed client-side (not just at the page-load renderOriginMs call) so
  // the elapsed-time origin can be recomputed as Realtime UPDATEs land —
  // e.g. a single-scene re-render clears this back to null and then the
  // worker restamps it on claim, both of which should move the origin.
  submitted_at: string | null;
  /**
   * scenes.render_settings_override — this scene's PARTIAL settings object
   * (typically just {model}), or null when it inherits the project's
   * wholesale. See 0045_scene_render_settings_override.sql.
   *
   * Carried here, in a component that otherwise only holds what the
   * Realtime/poll handlers can refresh, for one reason: the "Retry all
   * failed" price. A scene retried onto a pricier model earlier keeps that
   * model (0045: overrides are sticky), so a price computed from the
   * project's settings alone would under-quote it — and this button's
   * number is supposed to agree by construction with what retryAllFailed
   * checks against the spend caps. Realtime's `scenes` payload carries the
   * column, so the handler below refreshes it like any other scene field.
   */
  render_settings_override: unknown;
  /**
   * Classified reason for the newest `runs` row this scene failed with —
   * see lib/render-error.ts and actions/enqueue.ts's ScenePollStatus,
   * whose shape this mirrors. Only meaningful when status === 'failed';
   * `null` there means either no error row exists yet (a brief race
   * between the scene flipping to 'failed' and its `runs` insert landing)
   * or — the far more common case — this scene was constructed before a
   * failure ever happened. Never populated by the Realtime handler's
   * `scenes` payload directly (the worker never writes runs.error to
   * scenes); see this file's header for how it actually arrives.
   */
  error: RenderErrorInfo | null;
}

// STATUS_LABEL (the visible word beside each tile's glyph) lives in
// components/status-icon.tsx, not here — StatusIcon renders both the word
// and the shape together and is also the accessible-name source for the
// pair, so the strings live next to the thing that both displays and
// announces them rather than being re-typed in this file too.

const STATUS_CLASS: Record<SceneStatus, string> = {
  draft: "border-border bg-muted/40 text-muted-foreground",
  frame_ready: "border-border bg-muted/40 text-muted-foreground",
  queued: "border-chart-2/40 bg-chart-2/10 text-chart-2",
  rendering: "border-chart-1/40 bg-chart-1/10 text-chart-1",
  done: "border-chart-5/40 bg-chart-5/10 text-chart-5",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
};

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Three decimals, unlike usdFormatter's two: the per-second rates this
// formats are $0.04–$0.16, and rounding them to cents would print two
// different models at the same price. Same definition, for the same reason,
// as components/render-gate.tsx's — the two model pickers must not quote
// the same rate differently.
const perSecondFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

/** Label for a model id already known to be one of VIDEO_MODELS (it came from this file's own picker). */
function getModelLabel(modelId: string): string {
  return VIDEO_MODELS.find((candidate) => candidate.id === modelId)?.label ?? modelId;
}

/**
 * EstimatableBrief adapter for RenderProgressScene, same shape as the
 * (separately declared) toBrief() in render-gate.tsx / render/page.tsx /
 * actions/enqueue.ts. script_line/video_prompt are hardcoded empty —
 * estimateCost() never reads them (only duration_s and is_talking_head feed
 * the math; see lib/estimate.ts), and RenderProgressScene doesn't carry them
 * in the first place: this component only gets what the Realtime/poll
 * handlers can update (this file's header), not the full scenes row.
 */
function toBrief(scenesToPrice: readonly RenderProgressScene[]): EstimatableBrief {
  return {
    character: "",
    scenes: scenesToPrice.map((scene) => ({
      script_line: "",
      video_prompt: "",
      is_talking_head: scene.is_talking_head,
      duration_s: scene.duration_s,
    })),
  };
}

/**
 * Confirm-before-spend control for retrying every failed scene in the
 * project in one batch — retryAllFailed's only caller (actions/enqueue.ts).
 * Rendered only when more than one scene has failed (see the `failedCount >
 * 1` gate at this component's call site below): with exactly one failure
 * the per-scene Retry button above is the better affordance, and a second
 * "retry everything" button next to it would be noise for a job one click
 * already covers.
 *
 * Same "no button spends money without saying how much first" shape as
 * render-confirm-dialog.tsx and scene-rerender-dialog.tsx — same Dialog
 * structure, same client-side budget pre-check (lib/render-budget.ts), same
 * inline error surface rather than a toast. That last part matters more
 * here than anywhere else in this file: retryAllFailed returns an
 * ActionResult specifically so a daily-cap refusal reaches the operator
 * instead of being redacted as React error #441 (lib/action-result.ts) —
 * routing that message through this dialog's `errorMessage` state, the same
 * way the other two priced dialogs already do, is what actually delivers on
 * that contract. The per-scene Retry on each tile is now the same shape —
 * SceneRerenderDialog with kind="retry" — so a cap refusal reads the same
 * whichever of the two an operator reached for.
 */
function RetryAllFailedDialog({
  projectId,
  failedScenes,
  projectSettings,
  audioEnabled,
  budget,
}: {
  projectId: string;
  /** The scenes this retry will re-queue. Priced here rather than by the caller because the price now depends on a model the operator picks inside this dialog. */
  failedScenes: readonly RenderProgressScene[];
  /** The project's own render settings — the baseline every per-scene override merges on top of (mergeRenderSettings, lib/models.ts). */
  projectSettings: RenderSettings;
  /** Server-computed AUDIO_ENABLED (lib/models.ts isAudioEnabled()) — see RenderProgress's own prop for why a default here would be a silent wrong answer. */
  audioEnabled: boolean;
  /** Snapshot at page load (lib/spend.ts's getAccountBudgetSnapshot), same staleness caveat as RenderProgress's own prop — the server re-checks for real. */
  budget: RenderBudgetFigures;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // null = "leave each scene on the model it is already bound for" — the
  // project's, or an override a previous retry left on it (0045: sticky).
  // That is the default on purpose: an operator who opens this dialog to
  // retry, and never touches the model row, must not silently repoint
  // anything.
  const [modelId, setModelId] = useState<string | null>(null);

  const failedCount = failedScenes.length;

  // Two different prices, and the difference is the whole point of this
  // dialog. With a model picked, every scene in the batch renders on THAT
  // model, so the batch is priced as one homogeneous set. Without one, each
  // scene keeps its own effective settings and the set may genuinely be
  // mixed — estimateUsdForScenes (lib/estimate.ts) sums per group.
  //
  // Both branches are exactly what retryAllFailed computes server-side
  // before the spend-cap check (actions/enqueue.ts), which is what keeps the
  // number on this button and the number the cap enforces from disagreeing —
  // the same guarantee every other priced control in this app makes, now
  // extended across the model choice.
  const effectiveSettings =
    modelId === null ? projectSettings : mergeRenderSettings(projectSettings, { model: modelId });
  const costUsd =
    modelId === null
      ? estimateUsdForScenes(failedScenes, audioEnabled, projectSettings)
      : estimateCost(toBrief(failedScenes), audioEnabled, effectiveSettings).totalUsd;

  // Early client-side warning only — assertWithinSpendCaps in
  // actions/enqueue.ts is the real gate, checked global -> weekly -> daily.
  // Mirrors render-confirm-dialog.tsx's reasoning exactly: without this,
  // Confirm would stay clickable on an obviously-over-budget retry and the
  // operator would only find out from a thrown-then-redacted error instead
  // of a disabled button — and checking all three ceilings, not just daily,
  // is what keeps this dialog from disagreeing with the server about which
  // one actually refuses the retry.
  const bindingCap = bindingRenderCap(costUsd, budget);
  const overBudget = bindingCap !== null;
  const refusalMessage = renderCapRefusalMessage(bindingCap, costUsd, budget);

  function handleConfirm(): void {
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = await retryAllFailed(projectId, modelId ?? undefined);
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        setOpen(false);
      } catch (error) {
        // retryAllFailed never redirects today, but it shares
        // actions/enqueue.ts with enqueueRender/enqueueTestScene, which do —
        // unstable_rethrow stays here so a future change that adds one isn't
        // silently swallowed into an error message instead of a navigation.
        // Same reasoning as scene-rerender-dialog.tsx.
        unstable_rethrow(error);
        setErrorMessage(error instanceof Error ? error.message : "Failed to retry failed scenes.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* h-11 (44px): this app's Button sizes top out at `lg` (h-10,
            40px) — see components/ui/button.tsx — which sits just under the
            accepted 44px touch-target minimum (the figure
            remove-reference-button.tsx also builds around). Worth the
            explicit override here specifically because this screen is one
            an operator plausibly has open on a phone while a batch renders. */}
        <Button size="lg" className="h-11 px-6">
          {`Retry ${failedCount} failed — ${usdFormatter.format(costUsd)}`}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Retry {failedCount} failed scenes?</DialogTitle>
          <DialogDescription>
            This re-queues every currently-failed scene in one batch and clears the project&apos;s
            assembled video, if it has one, so it rebuilds once these are done. It cannot be undone,
            and each scene costs money the moment the worker picks it up.
          </DialogDescription>
        </DialogHeader>

        {/* The model row. Same OptionRow/OptionButton shape as the render
            gate's own model picker (components/render-gate.tsx) — small
            outline buttons, the selected one filled, the per-second rate
            shown on the button itself so the price difference is visible
            where the choice is made rather than only in the total below.
            Deliberately NOT a redesign of that picker or of this page: this
            is the one control 0045 adds, sitting directly above the number
            it changes.

            "Keep current" is first and selected by default, and is a real
            option rather than the absence of one: it is what leaves each
            scene on whatever model it is already bound for, which for a
            previously-retried scene is not the project's. Only enabled
            descriptors are offered — RenderSettingsOverrideSchema
            (lib/models.ts) refuses the rest server-side anyway, so showing
            them here would only invite a refusal. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="w-24 shrink-0 text-sm text-muted-foreground">Model</span>
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              size="sm"
              variant={modelId === null ? "default" : "outline"}
              disabled={isPending}
              title="Re-render each scene on the model it is already set to"
              onClick={() => setModelId(null)}
              className="h-7 px-2.5 text-xs font-medium"
            >
              Keep current
            </Button>
            {VIDEO_MODELS.map((candidate) => {
              // Quoted at the resolution this candidate will ACTUALLY merge
              // to, not candidate.defaultResolution: mergeRenderSettings
              // only overrides `model` here (line ~235's effectiveSettings
              // does the same merge), so a candidate whose allowedResolutions
              // include the project's current resolution KEEPS it — picking
              // Kling on a 720p or 1080p project merges that same resolution
              // (Kling allows both since 2026-09-10) and quotes correctly
              // today, but a multi-resolution silent model (Seedance 2.5
              // itself, which allows 480P/720P/1080P) would otherwise
              // advertise its defaultResolution's rate while actually
              // merging to, and billing at, the project's real one.
              const candidateRate = priceForSecond(
                candidate,
                mergeRenderSettings(projectSettings, { model: candidate.id }).resolution,
              );
              return (
                <Button
                  key={candidate.id}
                  type="button"
                  size="sm"
                  variant={modelId === candidate.id ? "default" : "outline"}
                  disabled={isPending}
                  title={`${perSecondFormatter.format(candidateRate)}/s`}
                  onClick={() => setModelId(candidate.id)}
                  className="h-7 px-2.5 text-xs font-medium"
                >
                  {candidate.label}
                  <span className="ml-1 opacity-70">
                    {perSecondFormatter.format(candidateRate)}/s
                  </span>
                </Button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col items-center gap-1 rounded-lg border bg-muted/40 py-6">
          <span className="text-4xl font-semibold tabular-nums text-foreground">
            {usdFormatter.format(costUsd)}
          </span>
          <span className="text-sm text-muted-foreground">
            estimated total · {effectiveSettings.resolution} · {effectiveSettings.fps} fps
          </span>
        </div>

        {/* Stated plainly because it is the one thing about this feature
            that surprises people: the override is written onto these scenes
            and stays there (0045 — nothing clears it, not even a successful
            render), so a later re-render of one of them uses it too. */}
        {modelId !== null ? (
          <p className="text-xs text-muted-foreground">
            These {failedCount} scenes will be re-rendered on {getModelLabel(modelId)} and stay on
            it until changed again. Scenes that already rendered are not affected, and the
            project&rsquo;s own model setting is unchanged.
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

// `subscribe()`'s status callback (see the effect below) only ever reports
// one of the four REALTIME_SUBSCRIBE_STATES values below it — this adds one
// state of our own, "connecting", for the window before that callback has
// fired even once. It is deliberately not treated the same as a confirmed
// bad status; see REALTIME_GRACE_MS.
type RealtimeConnectionStatus = REALTIME_SUBSCRIBE_STATES | "connecting";

// Poll interval for the fallback below. The Go worker's dispatch and
// reconcile loops (worker/cmd/worker/main.go) only tick every 30s, so scene
// status on the backend rarely changes faster than that — polling much more
// often than this wouldn't surface anything new, just spend a mobile data
// connection that's already unreliable (the whole reason this fallback
// exists). 10s stays well under that 30s backend cadence so the screen
// still feels alive without hammering it.
const POLL_INTERVAL_MS = 10000;

// How long a brand-new `subscribe()` call gets to reach SUBSCRIBED before
// its absence counts as a real degradation rather than the ordinary
// connection handshake every page load goes through. Without this window,
// the polling fallback (and its "Updates may be delayed" indicator) would
// flash on briefly on every normal load, which is a false alarm, not a
// signal worth showing an editor watching money get spent.
const REALTIME_GRACE_MS = 3000;

export function RenderProgress({
  projectId,
  initialScenes,
  model,
  resolution,
  fps,
  budget,
  pendingCount,
  pendingCostUsd,
  audioEnabled,
  readOnly = false,
}: {
  projectId: string;
  initialScenes: readonly RenderProgressScene[];
  // Plain data, not the whole RenderSettings object — a 'done' scene's
  // re-render button needs to quote the same $/s the project actually
  // rendered at (rerenderScene re-reads this server-side too; this copy is
  // only for what the button says before it's clicked).
  model: VideoModelDescriptor;
  resolution: string;
  /** Echoed in the "render remaining" confirm dialog next to resolution — same reasoning as render-gate.tsx's RenderConfirmDialog usage. */
  fps: number;
  /**
   * Snapshot at page load (lib/spend.ts's getAccountBudgetSnapshot),
   * threaded to RetryAllFailedDialog, the "render remaining" confirm
   * dialog, and each SceneRerenderDialog so their Confirm buttons can
   * disable themselves before the server has to refuse — see
   * render-confirm-dialog.tsx and lib/render-budget.ts's bindingRenderCap
   * for why all three ceilings, not just daily, have to reach here.
   */
  budget: RenderBudgetFigures;
  /**
   * How many scenes are still draft/frame_ready — i.e. never submitted, not
   * "in progress" (scenesAwaitingRender, lib/enqueue-guard.ts). Zero means
   * either nothing was ever tested-first or the whole batch has already
   * been queued; either way there's nothing left to offer here. A snapshot
   * at page load like remainingBudgetUsd above — enqueueRender redirect()s
   * on success, so the next render of this page is what clears the card,
   * not client-side state.
   */
  pendingCount: number;
  /** estimateCost() priced on just the pending scenes — never the full-batch total, so this card can never quote a price larger than what Confirm will actually queue. */
  pendingCostUsd: number;
  /**
   * Server-computed AUDIO_ENABLED flag (lib/models.ts isAudioEnabled()),
   * threaded down for the same reason render-gate.tsx and render/page.tsx's
   * toBrief()/estimateCost() calls need it: whether a talking-head scene
   * bills at Kling's rate or the flat silent rate depends on it, and a
   * default here would be a silent wrong answer the moment audio is
   * switched on (see estimateCost's own doc comment in lib/estimate.ts).
   *
   * Optional, with a `false` fallback for a caller that hasn't been taught
   * to pass it — render/page.tsx itself always does
   * (`audioEnabled={isAudioEnabled()}`). A caller that omits it would
   * under-quote any failed talking-head scene: Kling is a real,
   * always-selectable model now (see lib/models.ts's file header — there is
   * no more "disabled pending verification" tier), so `audioEnabled`
   * genuinely decides whether pickModel routes a talking-head scene to
   * Kling's native-audio rate or the silent default.
   */
  audioEnabled?: boolean;
  /**
   * True when the viewer is an admin looking at someone else's project
   * (requireProjectReadable's `isOwner: false` — see actions/guard.ts).
   * Hides the four write controls this component can render — "render
   * remaining," "retry all failed," per-scene Retry, and
   * SceneRerenderDialog — all still refused server-side by actions/enqueue.ts
   * regardless of this prop. The live Realtime progress view itself, and
   * "Deliver →" (pure navigation, no write), stay visible either way.
   */
  readOnly?: boolean;
}): JSX.Element {
  const [scenes, setScenes] = useState<RenderProgressScene[]>([...initialScenes]);
  // Tracks the Realtime channel's own health — see the file header for why.
  // "connecting" until subscribe()'s callback fires at least once.
  const [connectionStatus, setConnectionStatus] = useState<RealtimeConnectionStatus>("connecting");
  // Tab visibility, for the polling fallback below: polling a backgrounded
  // tab burns mobile data/battery for an update nobody can see, which is
  // exactly what this fallback is trying to be considerate of in the first
  // place. Defaults to true so SSR (no `document`) never disables polling.
  const [isVisible, setIsVisible] = useState<boolean>(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  // Flips once, REALTIME_GRACE_MS after mount — see that constant's comment.
  const [pastGraceWindow, setPastGraceWindow] = useState(false);
  // Bumped after every poll (success or failure) purely to re-run the
  // polling effect for its next tick — same setTimeout-recursion-via-state
  // shape as assembling-status.tsx's `attempts`, chosen so every
  // reschedule re-checks connectionStatus/inFlight/isVisible from scratch
  // instead of a raw setInterval that would keep firing after the channel
  // recovers or the batch finishes.
  const [pollTick, setPollTick] = useState(0);

  // Latest `scenes` state, readable synchronously from inside the
  // Realtime handler below without making it a dependency of the
  // subscribe effect (that effect intentionally only re-runs on
  // `projectId` — see its own comment). Kept in sync every render.
  const scenesRef = useRef<RenderProgressScene[]>(scenes);
  useEffect(() => {
    scenesRef.current = scenes;
  }, [scenes]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`scenes:${projectId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "scenes",
          filter: `project_id=eq.${projectId}`,
        },
        (payload: RealtimePostgresChangesPayload<SceneRow>) => {
          const updated = payload.new as SceneRow;
          if (!updated.id) {
            return;
          }
          // See this file's header: a transition INTO 'failed' is exactly
          // when this payload is missing something an editor needs (the
          // reason) and the fix is a one-shot fetch, not a second poller.
          const previous = scenesRef.current.find((scene) => scene.id === updated.id);
          const enteringFailed = updated.status === "failed" && previous?.status !== "failed";
          setScenes((prev) =>
            prev.map((scene) =>
              scene.id === updated.id
                ? {
                    id: updated.id,
                    idx: updated.idx,
                    is_talking_head: updated.is_talking_head,
                    status: updated.status,
                    duration_s: updated.duration_s,
                    submitted_at: updated.submitted_at,
                    // Refreshed from the payload rather than carried over:
                    // a retry-with-a-different-model writes this column in
                    // the same UPDATE that re-queues the scene (0045,
                    // actions/enqueue.ts), so the very event that moves
                    // this tile back to 'queued' is also the one carrying
                    // its new model.
                    render_settings_override: updated.render_settings_override,
                    // Cleared, not carried over, on a fresh transition into
                    // 'failed' (a stale reason from a PREVIOUS failure of
                    // this same scene must not flash before the refetch
                    // below lands); left untouched for every other update
                    // (e.g. submitted_at moving on a retry).
                    error: enteringFailed ? null : scene.error,
                  }
                : scene,
            ),
          );
          if (enteringFailed) {
            void getSceneStatuses(projectId)
              .then((polled) => {
                const byId = new Map(polled.map((scene) => [scene.id, scene]));
                setScenes((prev) =>
                  prev.map((scene) => {
                    const fresh = byId.get(scene.id);
                    return fresh
                      ? {
                          ...scene,
                          status: fresh.status,
                          submitted_at: fresh.submitted_at,
                          error: fresh.error,
                        }
                      : scene;
                  }),
                );
              })
              .catch((err: unknown) => {
                // Same reasoning as the polling fallback's catch below: not
                // operator-actionable, and the next poll tick (or another
                // Realtime event) will get another chance.
                console.error("Failed to fetch failure reason:", err);
              });
          }
        },
      )
      .subscribe((status, err) => {
        setConnectionStatus(status);
        if (
          status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
          status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT
        ) {
          // err's `cause` often holds the real reason (offline, a blocked
          // websocket upgrade, a server-side rejection) — logged for
          // debugging only. Never surfaced to the editor as an error: the
          // render itself is fine, see the quiet fallback indicator below.
          console.error(`Realtime subscribe ${status} for scenes:${projectId}`, err);
        }
      });

    return (): void => {
      void supabase.removeChannel(channel);
    };
  }, [projectId]);

  // `scenes` here is the live Realtime state (not initialScenes), so both
  // the in-flight check and the origin reflect UPDATEs as they arrive —
  // otherwise a single-scene re-render wouldn't move the origin to its own
  // submitted_at until the next full page reload.
  const inFlight = isRenderInFlight(scenes);
  // Scoped to in-flight scenes inside renderOriginMs itself (see
  // lib/render-elapsed.ts) — this is what keeps a re-render of one 'done'
  // scene from reporting the age of the other, already-finished scenes.
  const originMs = useMemo(() => renderOriginMs(scenes), [scenes]);

  useEffect(() => {
    function handleVisibilityChange(): void {
      setIsVisible(document.visibilityState === "visible");
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return (): void => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    // Fires once per mount and never resets — a channel that later drops
    // after having connected should fall back immediately, not wait out
    // another grace window. Only the very first connect attempt gets one.
    const timer = setTimeout(() => setPastGraceWindow(true), REALTIME_GRACE_MS);
    return (): void => clearTimeout(timer);
  }, []);

  // True while this screen should be polling instead of trusting Realtime:
  // the channel isn't SUBSCRIBED, it's had a fair chance to become so, and
  // there is still something in flight worth polling for. Also drives the
  // "Updates may be delayed" indicator in the JSX below — the two must
  // never disagree, or the screen would either poll silently or claim to
  // be degraded while doing nothing about it.
  const usingFallback =
    connectionStatus !== REALTIME_SUBSCRIBE_STATES.SUBSCRIBED && pastGraceWindow && inFlight;

  useEffect(() => {
    if (!usingFallback) return;
    // Tab is backgrounded: polling now would just burn mobile data/battery
    // for an update nobody can see. The visibilitychange effect above
    // flips `isVisible` back on foreground, which re-runs this effect.
    if (!isVisible) return;

    const timer = setTimeout(() => {
      void getSceneStatuses(projectId)
        .then((polled) => {
          const byId = new Map(polled.map((scene) => [scene.id, scene]));
          setScenes((prev) =>
            prev.map((scene) => {
              const updated = byId.get(scene.id);
              // Only status/submitted_at/error can change server-side (see
              // this file's header) — idx/is_talking_head/duration_s are
              // left untouched, same fields the Realtime handler above
              // leaves alone.
              return updated
                ? {
                    ...scene,
                    status: updated.status,
                    submitted_at: updated.submitted_at,
                    error: updated.error,
                  }
                : scene;
            }),
          );
        })
        .catch((err: unknown) => {
          // Not operator-actionable — the same flaky connection that took
          // Realtime down can just as easily drop this fetch. It'll retry
          // next tick; logged only so a *persistent* failure is visible
          // somewhere.
          console.error("Scene status poll failed:", err);
        })
        .finally(() => {
          setPollTick((n) => n + 1);
        });
    }, POLL_INTERVAL_MS);

    return (): void => clearTimeout(timer);
  }, [projectId, usingFallback, isVisible, pollTick]);

  const [tickedMs, setTickedMs] = useState<number | null>(null);
  // Masks whatever the last tick left in `tickedMs` once there's nothing to
  // count from — computed at render time rather than reset via setState
  // inside the effect below, so a stale number can never flash between the
  // origin/inFlight transition and the next tick.
  const elapsedMs = originMs === null || !inFlight ? null : tickedMs;

  useEffect(() => {
    if (originMs === null || !inFlight) {
      // Two cases land here, both meaning "don't run a timer":
      // - nothing in flight has been claimed yet (originMs is null) —
      //   there is no real start time to count from.
      // - every scene has reached a terminal status (inFlight is false) —
      //   the batch is finished. The schema has no completion timestamp
      //   (scenes only ever get submitted_at, never a "finished_at"), so
      //   there's no way to compute a real duration after the fact; the
      //   caller drops the readout entirely rather than show a frozen or
      //   stale number.
      return;
    }
    const tick = (): void => setTickedMs(Date.now() - originMs);
    tick();
    const interval = setInterval(tick, 1000);
    return (): void => clearInterval(interval);
  }, [originMs, inFlight]);

  const total = scenes.length;
  const doneCount = scenes.filter((scene) => scene.status === "done").length;
  const failedCount = scenes.filter((scene) => scene.status === "failed").length;
  // Every scene has reached a terminal status (done or failed) — distinct
  // from `!inFlight` below, which is also true while scenes are still
  // sitting untouched at draft/frame_ready (a partial/test render whose
  // remainder was never queued — see `pendingCount`). Gating the finished
  // banner on this instead of `!inFlight` is what keeps that case from
  // announcing a batch as done when there's still unsubmitted work in it.
  const allTerminal = total > 0 && doneCount + failedCount === total;
  // Counts failed scenes as progress too, not just done ones: a failed
  // scene has finished being processed by the worker, it just finished
  // badly, so excluding it from the fill left the bar visibly stuck below
  // 100% forever on a batch that finished with any failures — the same
  // "looks unfinished when it's actually over" complaint this whole change
  // is fixing, just on the bar instead of the header line.
  const progressPct = total > 0 ? ((doneCount + failedCount) / total) * 100 : 0;
  // Room to deliver as soon as there is something finished and nothing left
  // rendering — not "every scene done". A permanently failed scene reaches
  // a terminal status same as a done one (deriveProjectStatus in
  // lib/project-status.ts calls that combination 'complete', same as an
  // all-done batch, and now routes a bare /projects/[id] link straight
  // here for it too), so gating this button on `allDone` stranded an
  // operator with clips they had already paid for and nowhere to take
  // them. `inFlight` (queued/rendering, computed above from the same live
  // `scenes` state the realtime/poll effects already keep current) is
  // reused rather than a second terminal check, so this can never disagree
  // with the elapsed-timer/"Updates may be delayed" logic about whether
  // the batch is still running — while it's still running, the operator
  // stays here rather than being sent to a Deliver page that would just
  // tell them to come back.
  const canDeliver = doneCount > 0 && !inFlight;

  // Pricing moved INTO RetryAllFailedDialog with 0045: the number depends on
  // a model the operator picks inside that dialog, so it cannot be computed
  // out here any more. The guarantee it was written for is unchanged and now
  // covers the model choice too — see that component's own comment on the
  // two branches and how each one mirrors what retryAllFailed computes
  // server-side before the cap check.
  const failedScenes = scenes.filter((scene) => scene.status === "failed");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-sm">
          {allTerminal ? (
            // The one thing this header didn't do before: change character
            // when the batch actually finishes. Before this, the counter
            // above just reached parity (`N / N done`) and the elapsed
            // readout on the right vanished — to a watcher that reads as
            // "the number froze," not "this is over." role="status" so the
            // transition into this state is itself announced, the same way
            // status-icon.tsx's per-tile glyphs announce queued->rendering.
            // Icons/tokens (CircleCheck/CircleX, text-success/
            // text-destructive) are the same ones status-icon.tsx uses for
            // done/failed — reused, not reinvented — and the two outcomes
            // are kept visually distinct on purpose: a batch that finished
            // with failures must not read as a clean success (see the
            // muted disclaimer near the Deliver button below, which this
            // must not contradict).
            <span
              role="status"
              className={cn(
                "flex items-center gap-1.5 font-medium",
                failedCount > 0 ? "text-destructive" : "text-success",
              )}
            >
              {failedCount > 0 ? (
                <CircleX aria-hidden="true" className="h-4 w-4 shrink-0" />
              ) : (
                <CircleCheck aria-hidden="true" className="h-4 w-4 shrink-0" />
              )}
              {canDeliver ? (
                // Points the editor at the Deliver action from the part of
                // the page they're actually watching, without duplicating
                // the large Deliver button itself (still below the grid) —
                // canDeliver is false here only when every scene failed,
                // in which case there's nothing to deliver and this stays
                // plain text.
                <Link
                  href={`/projects/${projectId}/deliver`}
                  className="underline-offset-4 hover:underline"
                >
                  {failedCount > 0
                    ? `Rendered — ${doneCount} of ${total}, ${failedCount} failed`
                    : `All ${total} scene${total === 1 ? "" : "s"} rendered`}
                </Link>
              ) : (
                <span>
                  {failedCount > 0
                    ? `Rendered — ${doneCount} of ${total}, ${failedCount} failed`
                    : `All ${total} scene${total === 1 ? "" : "s"} rendered`}
                </span>
              )}
            </span>
          ) : (
            <span className="font-medium text-foreground">
              {doneCount} / {total} done
              {failedCount > 0 ? (
                <span className="ml-2 text-destructive">· {failedCount} failed</span>
              ) : null}
            </span>
          )}
          {usingFallback || inFlight ? (
            <span className="flex items-center gap-3 text-muted-foreground">
              {usingFallback ? (
                // Quiet and deliberately not styled like an error — the
                // render is fine, only the live channel isn't (see the
                // file header). Same muted-foreground token as the elapsed
                // readout next to it, no new colors.
                <span className="text-xs">Updates may be delayed</span>
              ) : null}
              {inFlight ? (
                // Once every scene is terminal there's nothing left to
                // wait on, and no completion timestamp to report a real
                // duration from (see the effect above) — so the element
                // itself is dropped rather than left showing a frozen or
                // stale number.
                <span className="tabular-nums">{elapsedLabel(elapsedMs)} elapsed</span>
              ) : null}
            </span>
          ) : null}
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressPct)}
          aria-valuetext={
            failedCount > 0
              ? `${doneCount} of ${total} done, ${failedCount} failed`
              : `${doneCount} of ${total} done`
          }
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              // Full-width at completion reads as "over," not "stuck below
              // 100%" — and the fill colour itself now carries the same
              // done-vs-failed distinction the header line and the scene
              // tiles already do, instead of staying bg-primary (this
              // app's action colour, not a status colour) regardless of
              // outcome.
              allTerminal ? (failedCount > 0 ? "bg-destructive" : "bg-success") : "bg-primary",
            )}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {!readOnly && pendingCount > 0 ? (
        // What a test-scene (or any partial) render leaves behind: the rest
        // of the batch is still sitting in draft/frame_ready, never
        // submitted. Without this the operator would have to leave the
        // Watch screen and find a "render the rest" control somewhere
        // else — this is that control, priced on exactly what it will
        // queue (see pendingCostUsd's doc comment above).
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-sm text-muted-foreground">
            {pendingCount} scene{pendingCount === 1 ? "" : "s"} still waiting to be rendered.
          </p>
          <RenderConfirmDialog
            projectId={projectId}
            kind="remaining"
            totalUsd={pendingCostUsd}
            budget={budget}
            sceneCount={pendingCount}
            resolution={resolution}
            fps={fps}
          />
        </div>
      ) : null}

      {!readOnly && failedCount > 1 ? (
        // Only past one failure — see RetryAllFailedDialog's doc comment
        // for why. Reuses STATUS_CLASS.failed's exact border/bg tokens
        // (border-destructive/40 bg-destructive/10) so this card reads as
        // "about the failed scenes" the same way the failed tiles below and
        // the "· N failed" count above already do, without introducing a
        // new color.
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
          <p className="text-sm text-muted-foreground">
            {failedCount} scenes failed. Retry them all here, or one at a time on their cards below.
          </p>
          <RetryAllFailedDialog
            projectId={projectId}
            failedScenes={failedScenes}
            // Reassembled from the three plain props this component already
            // takes rather than threading the raw jsonb blob down: these ARE
            // the project's parsed render_settings (render/page.tsx splits
            // them apart on the way in), and mergeRenderSettings treats them
            // as the left-hand side of the same merge SQL does.
            projectSettings={{ model: model.id, resolution, fps }}
            audioEnabled={audioEnabled ?? false}
            budget={budget}
          />
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {scenes
          .slice()
          .sort((a, b) => a.idx - b.idx)
          .map((scene) => {
            // The settings this scene will ACTUALLY render and bill on:
            // the project's, with its own sticky override on top (0045).
            // Resolved once per tile because both money controls below need
            // it — the Retry confirm and the Re-render confirm — and two
            // copies of this merge is exactly how a tile comes to quote one
            // model and bill another.
            const effectiveSettings = mergeRenderSettings(
              { model: model.id, resolution, fps },
              scene.render_settings_override,
            );
            const sceneCostUsd = estimateCost(
              toBrief([scene]),
              audioEnabled ?? false,
              effectiveSettings,
            ).totalUsd;
            const settingsLabel = `${getModelLabel(effectiveSettings.model)} · ${effectiveSettings.resolution} · ${scene.duration_s}s`;
            return (
              <div
                key={scene.id}
                // The project rail links straight to a scene as
                // /render#scene-<id>. Every scene tile shares this route, so
                // without the fragment the second and third rows in the rail
                // were links to the page you were already on and looked dead.
                // scroll-mt-6 keeps a jumped-to tile off the viewport edge.
                id={`scene-${scene.id}`}
                className={cn(
                  "flex scroll-mt-6 flex-col gap-2 rounded-lg border p-3",
                  STATUS_CLASS[scene.status],
                )}
              >
                {/* Status now lives on this same header row, next to the
                  scene's own index, instead of on a line of its own below —
                  the previous layout left the glyph sitting alone under
                  this row with nothing else on its line, which read as a
                  stray mark rather than as the tile's status. Grouping it
                  with "#N" here (and leaving the A-roll/B-roll tag as the
                  row's other, unrelated fact) makes "#1 — Rendering ⟳" one
                  legible unit: identity plus current state, not two
                  disconnected rows. flex-wrap covers the widest label
                  ("Frame ready") on the narrowest tiles (2-up on mobile)
                  without truncating it. */}
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs font-medium">
                  <span className="flex items-center gap-1.5">
                    <span>#{scene.idx + 1}</span>
                    <StatusIcon status={scene.status} />
                  </span>
                  <span className="rounded border border-current/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                    {scene.is_talking_head ? "A-roll" : "B-roll"}
                  </span>
                </div>
                {scene.status === "failed" ? (
                  // min-w-0 + block truncate + title: same "long free text
                  // must not stretch a fixed-width cell" pattern
                  // app/(app)/projects/page.tsx's project-title column uses
                  // (see that file's comment on the 1,444-char title that
                  // broke it) — one line, full text on hover/long-press, and
                  // the tile's own width (this grid's column, not the text)
                  // stays in control no matter how long the reason is.
                  <p
                    className="block min-w-0 truncate text-xs text-destructive/90"
                    title={scene.error?.message}
                  >
                    {scene.error?.message ?? "No failure reason recorded."}
                  </p>
                ) : null}
                {!readOnly && scene.status === "failed" ? (
                  // classifyRenderError (lib/render-error.ts) is what decides
                  // this, not a guess made here — insufficient-balance and
                  // rejected failures default retryable=false so this button
                  // never invites an editor to spend money on a retry that
                  // cannot succeed (see that file's category doc comments).
                  // Defaults to offering Retry when no error row has landed
                  // yet (`error` is null) — "unknown, retry may help" is the
                  // documented default there too.
                  (scene.error?.retryable ?? true) ? (
                    // CONFIRMED, not one-click. This was the one paid control
                    // on the page that spent straight off the press, beside a
                    // "Retry all failed" that has asked since it was written —
                    // so the safe way to retry a whole batch was guarded and
                    // the same spend on a single tile was not.
                    //
                    // Same dialog as Re-render below, so the two cannot quote
                    // different numbers or check different caps, and it keeps
                    // the built-in retryScene: that action revalidates this
                    // very route, which is why nothing here has to refresh.
                    <SceneRerenderDialog
                      kind="retry"
                      sceneId={scene.id}
                      sceneLabel={`scene ${scene.idx + 1}`}
                      costUsd={sceneCostUsd}
                      settingsLabel={settingsLabel}
                      budget={budget}
                      // The tile is one cell of a six-column grid; the default
                      // trigger's price-plus-balance label does not fit it, and
                      // the price is in the dialog either way.
                      trigger={
                        <Button size="sm" variant="outline">
                          Retry
                        </Button>
                      }
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Retry unavailable until this changes.
                    </p>
                  )
                ) : null}
                {!readOnly && scene.status === "done" ? (
                  <SceneRerenderDialog
                    sceneId={scene.id}
                    sceneLabel={`scene ${scene.idx + 1}`}
                    // mergeRenderSettings(project, override) + estimateCost(),
                    // not a flat priceForSecond() off the project's own
                    // model/resolution — rerenderScene (actions/enqueue.ts)
                    // prices this exact scene's EFFECTIVE settings, and a
                    // scene retried onto a different model earlier keeps it
                    // (0045: sticky). Pricing off the project alone quoted
                    // Seedance's rate for a scene that actually renders (and
                    // bills) on Kling, and bindingRenderCap below then pre-checked
                    // against that wrong number too. Same shape as
                    // deliver/page.tsx's costUsdBySceneId.
                    costUsd={sceneCostUsd}
                    settingsLabel={settingsLabel}
                    budget={budget}
                  />
                ) : null}
              </div>
            );
          })}
      </div>

      {canDeliver ? (
        <div className="flex flex-col items-end gap-2">
          {/* Only when the batch finished with a failure in it — an
              all-done batch needs no disclaimer, and this must not claim
              anything about what a retry would produce (see enqueue.ts's
              stale-`final` issue, tracked separately). Mirrors
              deliver/page.tsx's own "not the full delivery" notice so the
              two screens agree before and after the click. */}
          {failedCount > 0 ? (
            <p className="text-sm text-muted-foreground">
              {failedCount} scene{failedCount === 1 ? "" : "s"} failed and can be retried above — or
              deliver what&apos;s finished now.
            </p>
          ) : null}
          <Button asChild size="lg">
            <Link href={`/projects/${projectId}/deliver`}>
              {failedCount > 0 ? "Deliver what's done →" : "Deliver →"}
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
