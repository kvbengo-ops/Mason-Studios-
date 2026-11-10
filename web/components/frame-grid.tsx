"use client";

// Gate 2 review surface (docs/architecture.md § "User flow" step 6). A
// wrong reference frame guarantees a wrong clip that costs ~40x more to
// render than the frame did to make, so the entire design goal here is:
// make "this one's wrong, fix it" a single click with instant feedback.

import { useCallback, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import type { JSX } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Maximize2Icon } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { PendingButton } from "@/components/pending-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { updateScenePromptAndRegenerate, generateFrames } from "@/actions/frames";
// Text-only prompt save, reused here from Gate 1's editing surface
// (components/scene-table.tsx uses it the same way) rather than duplicating
// it: same table, same column, same edited_by_human flag, same
// draft/frame_ready guard as this file's own assertEditable — the only
// difference is which page's cache it revalidates, which is exactly what we
// want (see framePromptById below).
import { updateScenePrompt } from "@/actions/brief";

import { isEditable } from "@/lib/editable-guard";
import { useRailBusyIds, useRailBusySetter } from "@/components/project-rail";
import { Skeleton } from "@/components/ui/skeleton";
import type { Database } from "@/types/db";
import { useVisibleInterval } from "@/lib/use-visible-interval";

type SceneStatus = Database["public"]["Tables"]["scenes"]["Row"]["status"];

export interface FrameGridScene {
  id: string;
  idx: number;
  video_prompt: string | null;
  is_talking_head: boolean;
  status: SceneStatus;
  imageUrl: string | null;
  // Untransformed source for the "view full frame" link below — see
  // frames/page.tsx's doc comment on why this gate needs both a compressed
  // thumbnail and a full-fidelity original.
  originalImageUrl: string | null;
}

type GridScene = FrameGridScene & { pending: boolean };

type OptimisticAction =
  | { type: "pending"; id: string; pending: boolean }
  | { type: "prompt"; id: string; prompt: string };

const DEBOUNCE_MS = 600;

/**
 * How often to re-ask the server while frames are being generated.
 *
 * generateFrames writes each scene's asset row as that frame lands, then
 * revalidates ONCE at the very end — so a three-scene batch used to show
 * nothing at all for a minute and then everything at once. The operator's
 * reading of that is "it is stuck", and the reported symptom was exactly
 * that: refreshing the browser by hand to find out whether anything had
 * happened. Refreshing on a timer while a batch is open makes each frame
 * appear as it is actually finished.
 *
 * Four seconds because a single frame is roughly ten to twenty: slower than
 * this and a whole frame can complete inside one gap, faster and it is
 * re-rendering the route for nothing. Torn down the instant nothing is in
 * flight, so an idle Frames screen polls nothing at all — same rule as the
 * rail's own refresh (project-rail.tsx) and render-progress.tsx.
 */
// 8s, and never from a hidden tab: each tick re-renders the whole page server-side.
const FRAME_REFRESH_MS = 8_000;

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function reduceScenes(state: GridScene[], action: OptimisticAction): GridScene[] {
  switch (action.type) {
    case "pending":
      return state.map((scene) =>
        scene.id === action.id ? { ...scene, pending: action.pending } : scene,
      );
    case "prompt":
      return state.map((scene) =>
        scene.id === action.id ? { ...scene, video_prompt: action.prompt } : scene,
      );
    default:
      return state;
  }
}

function RollBadge({ isTalkingHead }: { isTalkingHead: boolean }): JSX.Element {
  return (
    <Badge variant={isTalkingHead ? "default" : "secondary"}>
      {isTalkingHead ? "A-roll" : "B-roll"}
    </Badge>
  );
}

export function FrameGrid({
  projectId,
  initialScenes,
  refFrameCostUsd,
  readOnly = false,
}: {
  projectId: string;
  initialScenes: FrameGridScene[];
  /**
   * True when the viewer is an admin looking at someone else's project
   * (requireProjectReadable's `isOwner: false` — see actions/guard.ts).
   * Every action here is still refused server-side by actions/frames.ts's
   * owner-only guards regardless of this prop — this only keeps a
   * read-only viewer from seeing editable-looking prompt fields and
   * Regenerate/Generate buttons that would only error on submit.
   */
  readOnly?: boolean;
  /**
   * What ONE reference frame costs at the vendor that will actually bill it,
   * resolved on the server and handed over.
   *
   * This file used to import REF_FRAME_COST_USD — fal's rate — and quote it
   * unconditionally. Production runs IMAGE_VENDOR=kie, where a frame is
   * $0.02 rather than $0.0398, so every price on this screen was double.
   * Reading the vendor here instead would not have worked either: it lives
   * in a non-NEXT_PUBLIC_ env var, so in the browser it is undefined and
   * every model resolves to "fal" — the same trap that mislabelled the
   * Settings screen.
   */
  refFrameCostUsd: number;
}): JSX.Element {
  // Must track `initialScenes` on every render, not just mount: this is the
  // server value `useOptimistic` reconciles against once its action settles
  // (React drops the optimistic overlay and falls back to this base). A
  // `useState` snapshot froze it at first mount, so after the server action
  // revalidated the route with a fresh `imageUrl`, the grid kept showing
  // "no frame yet" until a manual reload — blocking gate 2.
  const initial = useMemo<GridScene[]>(
    () => initialScenes.map((scene) => ({ ...scene, pending: false })),
    [initialScenes],
  );
  const [scenes, applyOptimistic] = useOptimistic(initial, reduceScenes);
  const [, startTransition] = useTransition();
  const [batchPending, setBatchPending] = useState(false);
  // The rail signal is written by the ACTIONS below, not by a mounted
  // component. `scene.pending` is optimistic state and a remount resets it,
  // so a card whose frame is still generating came back looking idle with a
  // live Regenerate button on it — a second $0.02 for a frame already in
  // flight. Same defect scene-workbench.tsx had, same cure: the store is
  // what survives the navigation, so the paid control reads the store.
  //
  // RailBusyWhile is deliberately gone from the cards. It clears its entry
  // on unmount, and since it writes the SAME scene id these actions do, it
  // would cancel a still-running generation's signal on the way out.
  const setRailBusy = useRailBusySetter();
  const sceneBusyIds = useRailBusyIds();
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const missing = scenes.filter((scene) => scene.imageUrl === null);
  // A scene that has never had a frame is still "missing" while its own
  // Regenerate press is in flight — imageUrl stays null until the new one
  // lands — so the batch would ask the server to generate it a second time.
  // generateFrames picks its own targets server-side, so the client cannot
  // fix this after the click; refusing the click is the only lever here.
  const batchWouldDuplicate = missing.some((scene) => sceneBusyIds.has(scene.id));
  const allFramed = scenes.length > 0 && missing.length === 0;

  // Anything in flight at all — the batch, or a single card's Regenerate.
  // Both write their scene's row the moment they finish, so both are worth
  // re-asking for; a single regenerate is only one frame, but it is also the
  // case where the operator is staring at one card waiting for it to change.
  const anyGenerating = batchPending || scenes.some((scene) => scene.pending);

  const router = useRouter();
  useVisibleInterval(() => router.refresh(), FRAME_REFRESH_MS, anyGenerating);

  // This file used to fire updateScenePromptAndRegenerate — save AND spend
  // REF_FRAME_COST_USD on fal — from the debounce below on every 600ms
  // typing pause. An operator thinking through a prompt burned real money on
  // every pause they never asked to spend; that's what drained the vendor
  // balance. Spend now only happens from an explicit Regenerate press
  // (handleRegenerate); the debounce (schedulePromptSave) only ever saves
  // text.
  const handleRegenerate = useCallback(
    (sceneId: string, prompt: string): void => {
      // Cancel any autosave still waiting to fire for this scene before
      // spending. This press already saves whatever's currently on screen —
      // passed as `prompt` straight to updateScenePromptAndRegenerate below
      // — so a debounce left pending has nothing left to contribute except a
      // redundant duplicate write a moment later. Left uncleared, that's a
      // stray timer this map never lets go of; cleared here, the invariant
      // stays simple: at most one save in flight per scene, and exactly one
      // spend per press, never a spend racing a save for the same scene.
      const existingTimer = timers.current.get(sceneId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        timers.current.delete(sceneId);
      }

      setRailBusy(sceneId, true);
      startTransition(async () => {
        applyOptimistic({ type: "pending", id: sceneId, pending: true });
        try {
          // A guard failure (locked scene, empty prompt) comes back as
          // `{ error }` data now, not a throw — see lib/action-result.ts.
          // The catch below still exists for a genuine thrown failure.
          //
          // Deliberately the combined save+regenerate action, not the
          // plain regenerate-only one, and passed `prompt` straight from
          // the textarea rather than trusting what's already persisted:
          // the autosave debounce can still be mid-flight when this fires,
          // and regenerating from a stale, pre-edit prompt would spend
          // REF_FRAME_COST_USD on the wrong text — forcing a second paid
          // press just to get the frame the operator actually asked for.
          const result = await updateScenePromptAndRegenerate(sceneId, prompt);
          if (result?.error) {
            toast.error(result.error);
          }
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Failed to regenerate frame.");
        } finally {
          setRailBusy(sceneId, false);
        }
      });
    },
    [applyOptimistic, setRailBusy],
  );

  const schedulePromptSave = useCallback(
    (sceneId: string, prompt: string): void => {
      startTransition(() => {
        applyOptimistic({ type: "prompt", id: sceneId, prompt });
      });

      const existing = timers.current.get(sceneId);
      if (existing) clearTimeout(existing);

      timers.current.set(
        sceneId,
        setTimeout(() => {
          startTransition(async () => {
            // Text-only save (actions/brief.ts) — never
            // updateScenePromptAndRegenerate. No `pending` optimistic
            // dispatch here either, on purpose: `pending` drives the
            // "Generating frame" overlay and disables the Regenerate
            // button, both of which would make a free save look like it's
            // spending. It would also never clear — unlike
            // handleRegenerate's action, this one revalidates the brief
            // page, not this one (see framePromptById below), so nothing
            // would ever come back around to reconcile the optimistic
            // overlay away, and the card would be stuck "generating"
            // forever.
            try {
              const result = await updateScenePrompt(sceneId, prompt);
              if (result?.error) {
                toast.error(result.error);
              }
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Failed to save scene prompt.");
            }
          });
        }, DEBOUNCE_MS),
      );
    },
    [applyOptimistic],
  );

  // What prompt actually produced the frame currently on screen for each
  // scene — used only to detect "edited but not yet regenerated" below.
  // `initial` (the server-confirmed base `useOptimistic` reconciles
  // against) advances only when a paid action's revalidatePath refreshes
  // this page's props, and every one of those actions
  // (generateFrames/updateScenePromptAndRegenerate) writes video_prompt and
  // the frame together, atomically — so `initial`'s
  // video_prompt is always exactly the prompt behind the currently
  // displayed image. The autosave above revalidates the brief page instead
  // and never touches this one, so it can never advance this map — that's
  // what lets the comparison below tell "typed but not regenerated yet"
  // apart from "matches what's on screen," the same way editing the script
  // marks the brief stale on the character page without a DB column to
  // back it (see that page's `hasScenes` comment) — an honest, cheap
  // signal, not a precise one, and the cheapest one available without a
  // schema change.
  const framePromptById = useMemo(
    () => new Map(initial.map((scene) => [scene.id, scene.video_prompt])),
    [initial],
  );

  function handleGenerateMissing(): void {
    const targetIds = missing.map((scene) => scene.id);
    if (targetIds.length === 0) return;

    setBatchPending(true);
    targetIds.forEach((id) => setRailBusy(id, true));
    startTransition(async () => {
      targetIds.forEach((id) => applyOptimistic({ type: "pending", id, pending: true }));
      try {
        const result = await generateFrames(projectId);
        if (result.failed.length > 0) {
          const idxById = new Map(scenes.map((scene) => [scene.id, scene.idx + 1]));
          const failedLabels = result.failed
            .map((f) => `#${idxById.get(f.sceneId) ?? "?"}`)
            .join(", ");
          toast.error(
            `${result.failed.length} frame(s) failed to generate (scene ${failedLabels}).`,
          );
        } else if (result.succeeded.length > 0) {
          toast.success(`Generated ${result.succeeded.length} frame(s).`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to generate frames.");
      } finally {
        setBatchPending(false);
        targetIds.forEach((id) => setRailBusy(id, false));
      }
    });
  }

  const generateCostUsd = missing.length * refFrameCostUsd;

  return (
    <div className="flex flex-col gap-6">
      {!readOnly && missing.length > 0 && (
        <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 p-4">
          <div className="flex flex-col">
            <span className="text-sm font-medium text-foreground">
              {missing.length} of {scenes.length} scene{scenes.length === 1 ? "" : "s"} still need a
              frame
            </span>
            <span className="text-xs text-muted-foreground">
              Estimated cost: {usdFormatter.format(generateCostUsd)}
            </span>
          </div>
          <PendingButton
            type="button"
            onClick={handleGenerateMissing}
            pending={batchPending}
            disabled={batchWouldDuplicate}
            title={
              batchWouldDuplicate
                ? "A frame in this batch is already generating. This would pay for it twice."
                : undefined
            }
          >
            {missing.length === scenes.length
              ? `Generate all frames (${usdFormatter.format(generateCostUsd)})`
              : `Generate remaining ${missing.length} (${usdFormatter.format(generateCostUsd)})`}
          </PendingButton>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {scenes.map((scene, index) => {
          const editable = isEditable(scene.status) && !readOnly;
          // Quiet, informational — not an error — same idiom as the
          // script-changed-since-compile note on the character page: the
          // prompt beside this frame no longer matches what produced it.
          // Suppressed while pending (the "Generating frame" overlay
          // already covers that) and while there's no frame yet at all
          // (nothing for the prompt to be stale relative to).
          // Reads the store, not scene.pending: the store is what survives
          // a navigation away and back, and this is the paid control.
          const busy = sceneBusyIds.has(scene.id);
          const framePromptStale =
            !scene.pending &&
            scene.imageUrl !== null &&
            scene.video_prompt !== framePromptById.get(scene.id);
          return (
            // h-full so every card fills its grid row (the row is already
            // stretch-aligned by default), and the footer below uses mt-auto
            // to sit on the bottom edge of whichever card is tallest.
            // Without both, each Regenerate button floats directly under its
            // own prompt textarea — and those differ in height by several
            // lines, so a row of four cards showed the same button at four
            // different heights, which reads as a rendering glitch rather
            // than as variable content.
            <Card
              key={scene.id}
              // Anchor for the project rail's per-scene links — see
              // lib/project-rail.ts. scene-table.tsx already carries the same id.
              id={`scene-${scene.id}`}
              className="flex h-full scroll-mt-6 flex-col gap-3 py-3"
            >
              <CardHeader className="flex flex-row items-center justify-between gap-2 px-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground">
                    #{scene.idx + 1}
                  </span>
                  <RollBadge isTalkingHead={scene.is_talking_head} />
                </div>
                <span className="text-xs text-muted-foreground">
                  {usdFormatter.format(refFrameCostUsd)}/regen
                </span>
              </CardHeader>

              <CardContent className="flex flex-col gap-3 px-3">
                <div className="relative aspect-[9/16] w-full overflow-hidden rounded-md border border-border bg-muted">
                  {scene.pending || busy ? (
                    // A skeleton in the frame's own shape, matching the scene
                    // workbench. It was a spinner and a label, which said
                    // "work is happening"; this says WHAT is being replaced,
                    // in the place the replacement will appear. It also hides
                    // the old frame, which a spinner beside it did not — and
                    // an old frame left on screen is what a $1.89 render gets
                    // judged against.
                    //
                    // `busy` as well as `scene.pending`: the optimistic flag
                    // is reset by a remount, the store is not.
                    <Skeleton
                      role="status"
                      aria-label={`Generating frame for scene ${scene.idx + 1}`}
                      className="h-full w-full rounded-none"
                    />
                  ) : scene.imageUrl ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element -- signed URL, not a static import */}
                      <img
                        src={scene.imageUrl}
                        alt={`Reference frame for scene ${scene.idx + 1}`}
                        className="h-full w-full object-cover"
                        // Grid scales with scene count (xl:grid-cols-4), so
                        // most of these are offscreen on load — lazy-load all
                        // but the first card, which renders right under this
                        // page's one-line header and is the above-the-fold
                        // (likely LCP) image; lazy-loading it would delay it
                        // for no benefit.
                        loading={index === 0 ? "eager" : "lazy"}
                        decoding="async"
                      />
                      {scene.originalImageUrl ? (
                        // Same overlay treatment as RemoveReferenceButton
                        // (character/page.tsx): size-6 visible target,
                        // hit area grown with an invisible ::before instead
                        // of the artwork, corner-inset enough to clear this
                        // wrapper's overflow-hidden. Opens the untransformed
                        // original in a new tab — this is a GATE screen (see
                        // this file's header comment), and an operator must
                        // be able to inspect a frame at full fidelity before
                        // rejecting or approving it, not just the quality-80
                        // thumbnail this card displays.
                        <a
                          href={scene.originalImageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`View full-resolution frame for scene ${scene.idx + 1}`}
                          className="absolute right-3 top-3 flex size-6 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm transition-colors before:absolute before:-inset-2.5 before:content-[''] hover:bg-accent"
                        >
                          <Maximize2Icon className="size-3.5" />
                        </a>
                      ) : null}
                    </>
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <span className="text-xs text-muted-foreground">No frame yet</span>
                    </div>
                  )}
                </div>

                <Textarea
                  defaultValue={scene.video_prompt ?? ""}
                  onChange={(e) => schedulePromptSave(scene.id, e.target.value)}
                  disabled={!editable}
                  // text-base (not a bare text-sm) below md: cn()'s twMerge
                  // lets this className win over Textarea's own mobile-safe
                  // default (components/ui/textarea.tsx), and anything under
                  // 16px makes iOS Safari zoom the whole page on focus. Keep
                  // the md: prefix — collapsing this back to "text-sm" is
                  // silent on desktop and re-breaks mobile.
                  className="min-h-20 text-base md:text-sm"
                  placeholder="Video prompt"
                  // Per card. A placeholder is not an accessible name, and
                  // it is gone the moment there is text in the field —
                  // which, on this screen, there always is.
                  aria-label={`Video prompt for scene ${scene.idx + 1}`}
                />
                {framePromptStale ? (
                  <p className="text-xs text-muted-foreground">
                    Prompt edited since this frame was generated — it still reflects the previous
                    prompt until you regenerate it.
                  </p>
                ) : null}
              </CardContent>

              <CardFooter className="mt-auto px-3">
                <PendingButton
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  // No spinner on the button — the skeleton above is this
                  // call's one signal. Disabled by the store, which survives
                  // a remount, as well as by the optimistic flag.
                  pending={false}
                  disabled={!editable || scene.pending || busy}
                  onClick={() => handleRegenerate(scene.id, scene.video_prompt ?? "")}
                >
                  {`Regenerate frame — ${usdFormatter.format(refFrameCostUsd)}`}
                </PendingButton>
              </CardFooter>
            </Card>
          );
        })}
      </div>

      {allFramed && (
        <p className="text-sm text-muted-foreground">
          Every scene has a reference frame. Review them above, then continue to render.
        </p>
      )}
    </div>
  );
}
