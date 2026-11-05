"use client";

// The one screen that holds a scene's prompt, reference frame and clip
// together, so the 3-8 correction cycles a bad clip costs happen WITHOUT
// leaving it. Every control the loop needs lives here: rewrite the prompt,
// regenerate the frame, change this scene's model, re-render, retry a
// failure, reopen a finished scene. Anything that sends the operator to
// another route mid-loop is a design bug on this file.

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/spinner";
import type { JSX } from "react";
import { useRouter } from "next/navigation";
import { CircleX } from "lucide-react";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import { PendingButton } from "@/components/pending-button";
import { InfoHint } from "@/components/info-hint";
import { useRailBusySetter, useRailEntryBusy } from "@/components/project-rail";
import { Badge } from "@/components/ui/badge";
import { setActiveSceneVersion, updateScenePromptAndRegenerate } from "@/actions/frames";
import { applyScenePrompt, deleteScene, updateScenePrompt } from "@/actions/brief";
import { retryScene } from "@/actions/enqueue";
import { SceneRerenderDialog } from "@/components/scene-rerender-dialog";
import { isSceneContentEditable, isSceneInFlight } from "@/lib/editable-guard";
import { getModel, parseRenderSettings } from "@/lib/models";
import type { ActionResult } from "@/lib/action-result";
import type { RenderBudgetFigures } from "@/lib/render-budget";
import type { RenderErrorInfo } from "@/lib/render-error";
import type { Database } from "@/types/db";

type SceneRow = Database["public"]["Tables"]["scenes"]["Row"];
type AssetRow = Database["public"]["Tables"]["assets"]["Row"];

export interface SceneWorkbenchProps {
  scene: SceneRow;
  refFrameUrl: string | null;
  /**
   * Every attempt at this scene, newest first — see
   * 0058_scene_versions.sql. One row per RENDER, carrying the prompt and
   * frame that render was billed for; `hasClip` says whether it produced
   * one. `renderSettings`/`durationS` are 0059's snapshots of what it was
   * rendered WITH — null on a version that predates those columns, which is
   * shown as "settings not recorded" rather than filled in from the scene's
   * current settings.
   */
  versions: readonly {
    id: string;
    n: number;
    createdAt: string;
    hasClip: boolean;
    renderSettings: unknown;
    durationS: number | null;
  }[];
  /** scenes.active_version_id — the attempt currently shown and delivered. */
  activeVersionId: string | null;
  clipAsset: AssetRow | null;
  clipUrl: string | null;
  isOwner: boolean;
  frameCostUsd: number;
  /** applyScenePrompt's price for THIS project's compiler model — see the page's own comment. */
  rewriteCostUsd: number;
  clipCostUsd: number;
  /**
   * The three values behind clipCostUsd, as one line — "Seedance 2.5 · 720p
   * · 6s". Resolved on the page from the scene's EFFECTIVE settings (the
   * project's merged with this scene's sticky override) and the model
   * pickModel will actually route to, which is the same pair clipCostUsd is
   * priced from. Shown on the confirm dialogs, where the price is being
   * agreed to and cannot otherwise be checked against anything.
   */
  clipSettingsLabel: string;
  /**
   * What this scene has actually been billed, summed from `runs`.
   *
   * The clip card printed clipCostUsd and called it "what the rendered clip
   * cost", on the stated reasoning that a rendered scene's settings are
   * frozen. They are not: the scene settings panel deliberately stays live
   * on a done scene, and updateSceneRenderOverride refuses only
   * queued/rendering. So changing the model after a render rewrote the
   * price of a clip that had already been paid for — the same defect the
   * Deliver page was fixed for, where a number labelled "already spent" was
   * computed from current settings.
   */
  clipSpentUsd: number;
  /** Which vendor actually renders this scene's clip — always "kie" now, kept as a display field rather than a literal so the UI has one name for it. */
  clipVendor: string;
  /** Whether the model this scene ACTUALLY renders on carries native audio — pickModel's answer, not the project's selected descriptor's. */
  clipHasAudio: boolean;
  /**
   * The spendable balance at kie, pre-formatted in kie's own unit
   * ("442 cr") — the same figure and the same unit the rail's budget block
   * shows, because it is the same quantity. `null` means the balance could
   * not be read, and stays null
   * rather than becoming a zero: "we don't know" and "you have nothing"
   * must not look identical to someone deciding whether to spend.
   */
  vendorBalanceLabel: string | null;
  /** Classified reason this scene's last render failed — non-null only for a 'failed' scene. */
  failure: RenderErrorInfo | null;
  budget: RenderBudgetFigures;
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const DEBOUNCE_MS = 600;

/**
 * How often an in-flight scene re-reads itself from the server.
 *
 * This page is a Server Component with no realtime subscription, so without
 * this it only changed on a manual reload — and a render that had already
 * finished and been billed sat here reading "rendering" for eight minutes
 * with nothing on screen to say otherwise. Eight minutes of an operator
 * staring at a stale word is also eight minutes in which the honest move
 * looks like clicking something again.
 *
 * Ten seconds, and only while the scene is actually queued/rendering: the
 * interval is torn down the moment the refreshed row comes back terminal,
 * so a finished scene costs nothing. This is deliberately the cheap half of
 * the fix — the rail's own live status (the thing visible from every route)
 * is a separate concern owned elsewhere.
 */
const IN_FLIGHT_REFRESH_MS = 10_000;

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * A-roll/B-roll, as a two-option radiogroup rather than a badge.
 *
 * It was a read-only badge here and a real control only on the brief table,
 * so the answer to "how do I change this?" was "leave this screen, find the
 * row again" — on the one screen built for fixing a single scene. Same
 * shape as scene-table.tsx's RollToggle, deliberately: two options side by
 * side with one marked selected, because a single button labelled with the
 * CURRENT value cannot be read as "is" versus "click to make it".
 */
/**
 * One terse line for the version picker: "6s · Seedance 2.5 · 720p".
 *
 * Reads ONLY the version's own snapshot (0059). A version with no snapshot —
 * backfilled by 0058, before the columns existed — says so, because the
 * alternative is quoting the scene's current model for a clip that was not
 * rendered on it, which is the whole reason the snapshot was added.
 */
function describeVersionSettings(version: {
  renderSettings: unknown;
  durationS: number | null;
}): string {
  if (version.renderSettings === null || version.renderSettings === undefined) {
    return "settings not recorded";
  }
  const settings = parseRenderSettings(version.renderSettings);
  // Length first, then model, then resolution. The length can be missing on
  // its own: 0059 made the two columns independently nullable.
  const parts = [getModel(settings.model).label, settings.resolution];
  if (version.durationS !== null) parts.unshift(`${version.durationS}s`);
  return parts.join(" · ");
}

function RollBadge({ isTalkingHead }: { isTalkingHead: boolean }): JSX.Element {
  return (
    <Badge variant={isTalkingHead ? "default" : "secondary"}>
      {isTalkingHead ? "A-roll" : "B-roll"}
    </Badge>
  );
}

function SaveIndicator({ state }: { state: SaveState }): JSX.Element | null {
  if (state === "idle") return null;
  if (state === "saving") return <span className="text-xs text-muted-foreground">Saving…</span>;
  if (state === "error") return <span className="text-xs text-destructive">Failed to save</span>;
  return <span className="text-xs text-muted-foreground">Saved</span>;
}

/** "2:10" — minutes:seconds, the shape the rail's own running count uses. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Live "how long has this been running" label, ticking once a second.
 *
 * Starts at null and only becomes a string after the first effect run, on
 * purpose: Date.now() during render would differ between the server's HTML
 * and the client's first paint and trip a hydration mismatch on every
 * in-flight scene. `scenes.submitted_at` has been on the row all along and
 * was never displayed — a static "Currently rendering" cannot tell thirty
 * seconds apart from thirty minutes, which is the entire difference between
 * waiting and being stuck.
 */
function useElapsedLabel(sinceIso: string | null, active: boolean): string | null {
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    if (!active || !sinceIso) return;
    // Both writes happen in callbacks rather than in the effect body: a
    // synchronous setState here would be a cascading render on every mount
    // of every in-flight scene, and the zero-delay timeout gets the first
    // reading onto the screen without waiting a whole second for the
    // interval's first tick.
    const firstTick = setTimeout(() => setNowMs(Date.now()), 0);
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return (): void => {
      clearTimeout(firstTick);
      clearInterval(timer);
    };
  }, [active, sinceIso]);

  // Gated on `active` rather than cleared on teardown, for the same reason:
  // a stale reading left over from a previous render of this scene can
  // never be displayed, because nothing is displayed at all unless the
  // scene is in flight right now.
  if (!active || nowMs === null || !sinceIso) return null;
  const startedMs = Date.parse(sinceIso);
  if (Number.isNaN(startedMs)) return null;
  return formatElapsed(nowMs - startedMs);
}

export function SceneWorkbench({
  scene,
  refFrameUrl,
  versions,
  activeVersionId,
  clipAsset,
  clipUrl,
  isOwner,
  frameCostUsd,
  rewriteCostUsd,
  clipCostUsd,
  clipSettingsLabel,
  clipSpentUsd,
  clipVendor,
  clipHasAudio,
  vendorBalanceLabel,
  failure,
  budget,
}: SceneWorkbenchProps): JSX.Element {
  // The pending flag was discarded here, so nothing disabled the frame
  // regeneration while it ran: a second click billed a second $0.02 call
  // for a frame the first one was already generating. Every other spending
  // control on this screen already guards its own double-click.
  // startTransition is the FREE half: the optimistic prompt echo and the
  // debounced text save. Its pending flag is deliberately not read by
  // anything — it went true on every 600ms typing pause, and it used to
  // drive the paid "Regenerate frame" button, so pausing mid-sentence
  // disabled that button and span its ring for a save that costs nothing.
  // A spinner that points at the wrong work is worse than none: it teaches
  // the operator that the ring does not mean money is moving.
  const [, startTransition] = useTransition();
  // The three paid actions hold plain state, NOT useTransition.
  //
  // A pending transition blocks navigation. Next's <Link> starts its own
  // transition to render the next route, and React will not run it while
  // one of these is still awaiting a server action — so clicking scene 4 in
  // the rail during a $0.02 frame regeneration did nothing at all until the
  // regeneration finished. Reported as: "nag try ako mag press sa 4th scene
  // pero ayaw mag navigate."
  //
  // Nothing here needs a transition. These are direct server-action calls,
  // not form actions, and the only thing the transition wrapped was the
  // router.refresh() that follows — which is ordinary work outside one. The
  // spinner reads from state, which also paints reliably, unlike a
  // transition's pending flag (see the rail's own RailBusyStore comment for
  // the same lesson learned the other way round).
  const [regenerating, setRegenerating] = useState(false);
  const [isRewriting, setIsRewriting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /**
   * The prompt text, held in plain state rather than useOptimistic.
   *
   * useOptimistic reverts to its base the moment the transition that set it
   * ends — and the transition here was the keystroke's own, which ends
   * immediately. So every character typed after the first debounce landed
   * was swallowed: the field looked frozen with "Saved" beside it, which is
   * exactly what it was. An optimistic overlay is for a value the SERVER is
   * about to confirm; a text field the operator is still typing into is not
   * that.
   */
  const [prompt, setPrompt] = useState(scene.video_prompt ?? "");
  // What flushPrompt saves. A ref, not the state: flushPrompt is memoised on
  // scene.id so it would otherwise close over the prompt as it was when the
  // field first mounted, and save that instead of what was typed.
  const promptRef = useRef(prompt);
  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);
  // Re-sync only when the SERVER's value genuinely changes under us — a
  // version switch, a Rewrite, a recompile. Comparing against the last
  // server value we saw (rather than against `prompt`) is what keeps this
  // from stamping on text the operator is mid-way through typing.
  const lastServerPrompt = useRef(scene.video_prompt ?? "");
  useEffect(() => {
    const next = scene.video_prompt ?? "";
    if (next !== lastServerPrompt.current) {
      lastServerPrompt.current = next;
      setPrompt(next);
    }
  }, [scene.video_prompt]);
  const router = useRouter();

  // Content-editability, not the money boundary: a finished scene's prompt
  // and frame are the operator's again (see isSceneContentEditable).
  const editable = isSceneContentEditable(scene.status) && isOwner;
  const inFlight = isSceneInFlight(scene.status);
  const hasClip = clipUrl !== null;
  const isFailed = scene.status === "failed";
  const isDone = scene.status === "done";
  // Exactly what enqueueScene accepts (lib/enqueue-guard.ts's
  // assertNotAlreadySpent). Spelled out here rather than reusing
  // `editable` above: that one is about whether the WORKER owns the row,
  // and conflating the two is how a button that can only fail gets drawn.
  const awaitingFirstRender = scene.status === "draft" || scene.status === "frame_ready";
  const sceneLabel = `Scene ${scene.idx + 1}`;
  const elapsedLabel = useElapsedLabel(scene.submitted_at, inFlight);
  // See IN_FLIGHT_REFRESH_MS.
  // Re-read the scene when this tab comes back to the front.
  //
  // The poll below only runs once the page ALREADY knows the scene is in
  // flight, which leaves one honest gap: a scene queued from somewhere else
  // — the batch render, another tab — never reaches this page, so Scene
  // Settings stays interactive against a scene the worker now owns. The
  // writes are refused server-side either way (updateSceneRenderOverride,
  // updateSceneDuration and toggleTalkingHead all check the status), so the
  // cost is a click that earns an error rather than a corrupted render. But
  // a panel that looks live on a rendering scene is the wrong thing to show
  // regardless, and returning to the tab is exactly when an operator looks.
  useEffect(() => {
    function onFocus(): void {
      if (document.visibilityState === "visible") router.refresh();
    }
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return (): void => {
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [router]);

  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => router.refresh(), IN_FLIGHT_REFRESH_MS);
    return (): void => clearInterval(timer);
  }, [inFlight, router]);

  /** Cancels a queued debounced save. Every control that REPLACES the prompt wholesale has to do this first, or the pending save lands afterwards and resurrects the text the operator just paid to replace. */
  const cancelPendingSave = useCallback(() => {
    const existing = timers.current.get(scene.id);
    if (existing) {
      clearTimeout(existing);
      timers.current.delete(scene.id);
    }
  }, [scene.id]);

  /**
   * Save the prompt NOW, cancelling the debounce.
   *
   * The 600ms debounce is right for typing and wrong for leaving: clicking
   * "Render this scene" straight after a keystroke submitted a PAID render
   * built from the prompt still sitting in the database, not the one on
   * screen. Blur fires before the click lands, so flushing here closes the
   * realistic version of that race — the operator has to leave the field to
   * reach any button that spends.
   */
  const flushPrompt = useCallback(() => {
    const existing = timers.current.get(scene.id);
    if (!existing) return;
    clearTimeout(existing);
    timers.current.delete(scene.id);
    startTransition(async () => {
      setSaveState("saving");
      try {
        const result = await updateScenePrompt(scene.id, promptRef.current);
        if (result?.error) {
          setSaveState("error");
          toast.error(result.error);
          return;
        }
        setSaveState("saved");
      } catch (err) {
        setSaveState("error");
        toast.error(err instanceof Error ? err.message : "Failed to save scene prompt.");
      }
    });
  }, [scene.id]);

  const handlePromptChange = useCallback(
    (newPrompt: string) => {
      setPrompt(newPrompt);

      const existing = timers.current.get(scene.id);
      if (existing) clearTimeout(existing);

      timers.current.set(
        scene.id,
        setTimeout(() => {
          startTransition(async () => {
            setSaveState("saving");
            try {
              const result = await updateScenePrompt(scene.id, newPrompt);
              if (result?.error) {
                setSaveState("error");
                toast.error(result.error);
                return;
              }
              setSaveState("saved");
            } catch (err) {
              setSaveState("error");
              toast.error(err instanceof Error ? err.message : "Failed to save scene prompt.");
            }
          });
        }, DEBOUNCE_MS),
      );
    },
    [scene.id],
  );

  // Deleting is only offered where actions/brief.ts's deleteScene would
  // actually accept it — draft or frame_ready. On a rendered scene the
  // action refuses, because a clip that has been paid for is part of the
  // record, and Reopen is the route there instead.
  // Plain state, for the same reason as the three paid actions above: a
  // pending transition holds the rail's navigation until it settles.
  const [switchingVersion, setSwitchingVersion] = useState(false);

  function handlePickVersion(versionId: string): void {
    setSwitchingVersion(true);
    void (async (): Promise<void> => {
      try {
        const result = await setActiveSceneVersion(scene.id, versionId);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to switch version.");
      } finally {
        setSwitchingVersion(false);
      }
    })();
  }

  const activeVersion = versions.find((version) => version.id === activeVersionId) ?? null;

  const [deleting, startDeleteTransition] = useTransition();

  // This scene's own rail row spins for every call this screen makes that
  // costs money or takes real time — never for the free autosave. The row
  // keeps spinning after the operator navigates away, which is the whole
  // reason the rail carries this signal rather than the button alone.
  // All four report through setRailBusy inside their own actions, NOT
  // useRailBusyWhile — that hook clears on unmount, and now that these no
  // longer hold the router, navigating away mid-call is the normal thing to
  // do. The row went quiet exactly when the operator most needed it to keep
  // talking: "nawala un loading sa scene 1? na stop din un regenerate?"
  //
  // Delete is in the same list even though it navigates away itself, and
  // that is not tidiness. It writes the SAME entry id as the other three, so
  // a useRailBusyWhile(scene.id, deleting) sitting alongside them clears
  // that key on unmount and cancels a regeneration's signal that is still
  // running. Found by the unmount test, which failed on exactly that.
  const setRailBusy = useRailBusySetter();
  // Survives a navigation away and back; `regenerating` and friends do not.
  // Every paid control on this scene reads this so a remounted workbench
  // cannot offer a second click on a call that is still running.
  const sceneBusy = useRailEntryBusy(scene.id);

  function handleDelete(): void {
    if (!window.confirm(`Delete ${sceneLabel}? Everything typed on it goes with it.`)) return;
    setRailBusy(scene.id, true);
    startDeleteTransition(async () => {
      try {
        const result = await deleteScene(scene.id);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        // The scene this page is about no longer exists, so staying here
        // would render a 404 nobody asked for.
        router.push(`/projects/${scene.project_id}/brief`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to delete scene.");
      } finally {
        setRailBusy(scene.id, false);
      }
    });
  }

  const handleRegenerateFrame = useCallback(() => {
    cancelPendingSave();

    setRegenerating(true);
    setRailBusy(scene.id, true);
    void (async (): Promise<void> => {
      try {
        const result = await updateScenePromptAndRegenerate(scene.id, prompt);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        // No router.refresh() here. The action revalidates this scene's own
        // route (actions/frames.ts), and the router applies that to the
        // current page as part of the action's response — so the refresh
        // was a second server round trip inside a transition the operator
        // is already waiting on, and a rail click during that window queues
        // behind all of it.
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to regenerate frame.");
      } finally {
        setRegenerating(false);
        setRailBusy(scene.id, false);
      }
    })();
  }, [cancelPendingSave, scene.id, prompt, setRailBusy]);

  const handleRewrite = useCallback(() => {
    // applyScenePrompt overwrites video_prompt wholesale from the script
    // line and clears edited_by_human — a debounced save landing after it
    // would write the discarded text straight back.
    cancelPendingSave();
    setSaveState("idle");

    setIsRewriting(true);
    setRailBusy(scene.id, true);
    void (async (): Promise<void> => {
      try {
        const result = await applyScenePrompt(scene.id);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        // applyScenePrompt revalidates the Brief route, not this one, so
        // without this the new prompt would sit on the server unseen.
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to rewrite the prompt.");
      } finally {
        setIsRewriting(false);
        setRailBusy(scene.id, false);
      }
    })();
  }, [cancelPendingSave, scene.id, router, setRailBusy]);

  // Runs from the confirm dialog's Confirm, not from the button itself — a
  // retry buys a whole new attempt at the same price as the one that failed,
  // and it was the last control on this screen that spent on one press.
  //
  // Not the dialog's built-in retryScene branch, only because of the refresh:
  // that action revalidates the project's /render route, and this screen is
  // /scenes/[sceneId]. A refusal is RETURNED rather than toasted so it lands
  // inside the dialog, beside the number it refused.
  const handleRetry = useCallback(async (): Promise<ActionResult | void> => {
    setIsRetrying(true);
    setRailBusy(scene.id, true);
    try {
      const result = await retryScene(scene.id);
      if (result?.error) return result;
      router.refresh();
    } finally {
      setIsRetrying(false);
      setRailBusy(scene.id, false);
    }
  }, [scene.id, router, setRailBusy]);

  const inFlightText = scene.status === "queued" ? "Queued for rendering" : "Rendering";

  return (
    <div className="flex flex-col gap-5 p-6">
      {/* Header — scene identity, roll, and the per-scene model/duration/
          resolution decision, all on one line. The project's own title
          belongs to the rail, which is on screen from every route; repeating
          it here was a second answer to a question nobody asked twice. */}
      {/* Sticky, because it is the row you scroll away from and still need:
          which scene you are standing in, and the model/resolution the money
          buttons further down are priced at. A 9:16 clip and a full prompt
          put real distance between the two, and deciding to re-render at
          $1.89 without the settings in view is deciding half-blind.
          -mx-6/px-6 so the background spans the panel's own padding rather
          than leaving the content to slide through the gutters, and top-0
          because app/(app)/layout.tsx makes <main> the scrollport at md+. */}
      <div className="sticky top-0 z-10 -mx-6 flex flex-wrap items-center gap-3 border-b border-border bg-background px-6 py-3">
        <h1 className="text-2xl font-medium text-foreground">Scene {scene.idx + 1}</h1>
        {/* A BADGE here, never the toggle. A-roll/B-roll is the per-scene
            audio switch — pickModel's first argument — so it decides which
            model runs and what the scene costs, and it belongs beside those
            numbers in Scene Settings rather than in a header that shows
            none of them. Flipping it here meant changing the bill from a
            place with no price on it. The header still NAMES the roll,
            because it is also how you recognise the scene. */}
        <RollBadge isTalkingHead={scene.is_talking_head} />
        {/* The scene's identity, not an action: "which attempt am I looking
            at" has to be answered before anything below it means anything,
            so it sits in the sticky header beside the scene number and the
            roll. One row per render (0058), and picking one switches the
            prompt, the frame and the clip together — they were never
            separable, which is why they share a row rather than three
            histories. Hidden below two: a picker with one option is
            furniture. */}
        {versions.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                // Switching versions is free and changes nothing the
                // worker is reading — a delivered project is still locked
                // (isOwner/locked feed `editable`), but a rendered scene is
                // not. Only an in-flight render blocks it.
                disabled={inFlight || !isOwner || switchingVersion}
                className="h-7 gap-1 px-2 text-xs font-medium"
              >
                v{activeVersion?.n ?? versions[0]?.n ?? 1}
                <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Versions — one per render
              </DropdownMenuLabel>
              {versions.map((version) => (
                <DropdownMenuItem
                  key={version.id}
                  disabled={switchingVersion}
                  onSelect={
                    version.id === activeVersionId
                      ? undefined
                      : (): void => handlePickVersion(version.id)
                  }
                  className="justify-between gap-4"
                >
                  <span className={version.id === activeVersionId ? "font-medium" : undefined}>
                    {version.id === activeVersionId ? "✓ " : ""}v{version.n}
                  </span>
                  <span className="text-right text-xs text-muted-foreground">
                    {describeVersionSettings(version)}
                    <span className="block opacity-70">
                      {version.hasClip ? "has clip" : "no clip"}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {/* No model/length/resolution control in this header. It is the
            "This scene" panel in the right column now — the same three
            values, always readable instead of hidden behind a dropdown, and
            beside the price they decide. The header keeps what is only ever
            this scene's shape: A-roll/B-roll, the version, and the cost. */}
        {/* The one number this screen spends, at the far right of the row
            that carries the decision. It used to be the last item inside
            the settings chip AND repeated per row inside that chip's menu —
            seven models and two resolutions each quoting a per-second rate,
            which turns a decision into a price list. One figure, in the same
            place every time, that moves when the settings do. */}
        <span className="ml-auto text-sm font-medium tabular-nums text-foreground">
          {usdFormatter.format(clipCostUsd)}
          <span className="ml-1 text-xs font-normal text-muted-foreground">this scene</span>
        </span>
        {inFlight && (
          <div
            role="status"
            className="flex items-center gap-2 rounded bg-chart-2/10 px-2 py-1 text-sm text-chart-2"
          >
            {/* A moving ring, not a static dot: the one thing that tells
                "still working" apart from "stuck" at a glance. */}
            <Spinner className="size-3.5" />
            <span>{inFlightText}</span>
            {elapsedLabel && <span className="tabular-nums opacity-80">{elapsedLabel}</span>}
          </div>
        )}
      </div>

      {/* Failure is a first-class state here, not an absence of one. A
          'failed' scene used to render exactly like a scene that had never
          been submitted — no marker, no reason, and a clip slot reading
          "render to generate" over a render that was attempted and paid
          for. */}
      {isFailed && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <CircleX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">Render failed</span>
            <span className="text-destructive/90">
              {failure?.message ?? "No failure reason recorded."}
            </span>
          </div>
        </div>
      )}

      {/* Frame beside prompt — the frame is a reference thumbnail, the
          prompt is the thing being worked on, so they don't get equal
          width. */}
      {/* The frame column is sized to the FRAME, not to a round number. The
          box below is max-h-80 at 9:16, so it is 180px wide however much
          room it is given — in a 20rem column that left ~70px of dead
          gutter on each side of it and took the width off the prompt, which
          is the half that actually needs reading room. */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,11.5rem)_1fr]">
        {/* 9:16, and contained rather than cropped. Every frame this
            pipeline produces is 9:16 — lib/kie.ts sends aspect_ratio
            "9:16" — so a 16:9 box with object-cover showed
            roughly the middle third and cut the top and bottom off the
            composition. This is the image an operator inspects before
            committing $1.89 to render from it, so it has to be the whole
            image. The signed URL is already fetched with resize "contain"
            (the page), meaning the full frame arrived and was then cropped
            by CSS. components/frame-grid.tsx has always got this right;
            this screen contradicted it about the same asset. */}
        <div className="flex flex-col gap-2">
          <div className="mx-auto aspect-[9/16] max-h-80 w-full overflow-hidden rounded-md border border-border bg-muted">
            {/* The frame itself carries the waiting, in the shape and place
                the new one will appear. A spinner on the button said "work is
                happening"; this says WHAT is being replaced, which is the
                thing the operator is actually waiting to see. It also holds
                the old frame back from view — leaving it up under a spinner
                invites a $1.89 render judged against an image that is about
                to be thrown away. */}
            {sceneBusy || regenerating ? (
              <Skeleton className="h-full w-full rounded-none" />
            ) : refFrameUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={refFrameUrl}
                alt={`Reference frame for scene ${scene.idx + 1}`}
                className="h-full w-full object-contain"
                loading="eager"
                decoding="async"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <span className="text-sm text-muted-foreground">No frame yet</span>
              </div>
            )}
          </div>
          {/* Under the frame it regenerates, not in the action row at the
              bottom of the page. It acts on the thumbnail above it and
              nothing else, and it was sitting a full clip player away from
              the thing it changes. */}
          {editable && isOwner && !inFlight ? (
            <PendingButton
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              // No spinner here: the skeleton above is this call's one
              // signal, and two indicators for one wait is how a screen
              // starts looking busy rather than reading as busy. The button
              // only has to be shut — and it is shut by the STORE, not by
              // `regenerating`, which a remount resets to false while the
              // call is still running.
              pending={false}
              // `regenerating` as well as the store: the store write goes
              // through a context and this instance's own flag is the one
              // that is true the instant the click lands.
              disabled={sceneBusy || regenerating}
              onClick={handleRegenerateFrame}
            >
              Regenerate frame — {usdFormatter.format(frameCostUsd)}
            </PendingButton>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Prompt
            </span>
            <InfoHint>
              Written once, when the script was compiled, from the character and product
              descriptions as they were AT THAT MOMENT. It is a frozen copy: editing Setup later
              does not change these words. Only Rewrite with AI, or recompiling the script, writes
              them again. The reference frame is the opposite — it is generated from whatever Setup
              holds at the moment you press Regenerate.
            </InfoHint>
            {scene.edited_by_human && (
              <Badge variant="secondary" className="text-xs font-normal">
                edited
              </Badge>
            )}
            <SaveIndicator state={saveState} />
          </div>
          <Textarea
            value={prompt}
            onChange={(e) => handlePromptChange(e.target.value)}
            onBlur={flushPrompt}
            disabled={!editable}
            className="min-h-40 flex-1 text-base md:text-sm"
            placeholder="Video prompt"
            // The "Prompt" heading above is a <span> in a flex row, not a
            // <label>, so this field had no accessible name at all — a
            // placeholder is not one, and it disappears the moment there is
            // text. This is the field the whole screen is about.
            aria-label="Video prompt"
            readOnly={!editable}
          />
          {/* Says WHY the field is inert. isEditable already refuses
              'queued' and 'rendering' — the worker owns the scene at that
              point and a prompt edit would either be ignored or race the
              dispatch that is reading it — but a greyed-out box with no
              sentence beside it reads as broken rather than as locked. */}
          {inFlight ? (
            <p className="text-xs text-muted-foreground">
              Locked while this scene renders — the worker is already reading this prompt. It
              unlocks when the clip lands or the render fails.
            </p>
          ) : null}
          {/* Named for what it actually does. applyScenePrompt
              (actions/brief.ts) regenerates this prompt from the script line
              and sets edited_by_human back to false — there is no merge and
              no confirmation, and an operator lost a hand-edited prompt to a
              button labelled "Apply". Living here rather than only on the
              Brief table is the point of this screen: the fix loop must not
              require leaving it. */}
          {editable && (
            <PendingButton
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              pending={isRewriting}
              disabled={sceneBusy || !scene.script_line?.trim()}
              title={
                scene.script_line?.trim()
                  ? undefined
                  : "This scene has no script line to generate a prompt from."
              }
              onClick={handleRewrite}
            >
              Rewrite with AI — {usdFormatter.format(rewriteCostUsd)}
              <span className="opacity-70">
                {" · "}
                {scene.edited_by_human ? "discards your edit" : "replaces this prompt"}
              </span>
            </PendingButton>
          )}
          {/* Said out loud, not left to a tooltip on a disabled button.
              A scene added by hand (the rail's "Add scene") has no
              script_line — nothing was compiled for it — so there is
              nothing for Rewrite to write FROM, and a recompile would drop
              it rather than recreate it. Both facts surprise people, and a
              hover hint on a control that cannot be hovered comfortably is
              not where they belong. */}
          {editable && !scene.script_line?.trim() && (
            <p className="text-xs text-muted-foreground">
              This scene was added by hand, so it has no script line. Write the prompt yourself —
              Rewrite with AI has nothing to work from, and recompiling the script will not recreate
              this scene.
            </p>
          )}
        </div>
      </div>

      <div className="border-t border-border" />

      {/* Clip */}
      <div className="flex flex-col gap-2">
        {hasClip ? (
          <>
            {/* Height-capped, not width-driven — the fix the Deliver page
                already documents for the same asset. Every clip this
                pipeline makes is 9:16, and this panel runs to max-w-6xl, so
                `w-full` rendered an ~850px-wide player about 1500px tall and
                pushed the clip's own meta row and the entire action row —
                Reopen, Re-render, Retry — below the fold on every done
                scene. The controls that decide what to do about a clip have
                to be in the same glance as the clip.
                max-h + w-auto lets the browser derive the width from the
                clip's real aspect ratio instead of forcing one. */}
            <div className="flex justify-center">
              <video
                controls
                // Bounded on BOTH axes, matching the assembled video on the
                // Deliver page ("capped to roughly one clip card's width").
                // A 9:16 clip given only a height cap still fills a tall
                // viewport and pushes the meta and action rows under the
                // fold; the operator is reviewing a phone-shaped video, not
                // watching it in a cinema.
                className="max-h-[60vh] w-auto max-w-sm rounded-md border border-border bg-black"
              >
                <source src={clipUrl!} type="video/mp4" />
                Your browser does not support the video tag.
              </video>
            </div>
            {/* What this clip is, in one line: how long, whether it has
                sound, who rendered it and what that costs. Duration alone
                was the only one of the four on screen — the vendor and the
                money, the two an operator actually decides on, were
                nowhere. */}
            <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {clipAsset?.duration_s ?? scene.duration_s}s
              </span>
              <span>·</span>
              <span>{clipHasAudio ? "audio on" : "silent"}</span>
              <span>·</span>
              <span>{clipVendor}</span>
              {/* What was BILLED, when anything has been. The list price at
                  current settings is a different number the moment an
                  operator changes the model on a done scene, which this
                  screen lets them do — and a clip card is the last place
                  that should quietly restate the cost of something already
                  paid for. Falls back to the list price only when nothing
                  has been billed yet, where it is a quote and says so. */}
              <span
                className="font-medium text-foreground"
                title={
                  clipSpentUsd > 0
                    ? "Actually billed for this scene, summed from its render history."
                    : "Estimated at this scene's current model and resolution — nothing billed yet."
                }
              >
                {usdFormatter.format(clipSpentUsd > 0 ? clipSpentUsd : clipCostUsd)}
              </span>
            </div>
          </>
        ) : (
          <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-md border border-border bg-muted/40 px-4 text-center">
            <span className="text-sm text-muted-foreground">
              {inFlight
                ? `${inFlightText}${elapsedLabel ? ` — ${elapsedLabel}` : ""}`
                : isFailed
                  ? "This render failed before it produced a clip."
                  : "No clip yet."}
            </span>
            {/* "render to generate" was an instruction with nowhere to
                follow it: rendering is started for the whole project on the
                Render step, and this screen has no control of its own until
                a clip exists (re-render) or a render fails (retry). Saying
                where, as a link, is the difference between a dead end and a
                next step. */}
            {/* The render control itself is NOT here — it lives in the one
                action row below, which renders whether or not a clip is on
                screen. It used to live in this empty slot, which meant a
                scene holding a clip could reach a state with no way to
                render at all: regenerating the frame writes the scene back
                to 'frame_ready' (actions/frames.ts), so `isDone` went false
                while the old clip stayed on screen, and neither branch
                offered anything. Reported as "inedit ko lang un text??
                wala un rerender na btn????". Only the no-frame explanation
                belongs to the empty slot. */}
            {!inFlight && !isFailed && isOwner && !refFrameUrl ? (
              <span className="text-sm text-muted-foreground">
                Generate the reference frame first — the clip is rendered from it.
              </span>
            ) : null}
          </div>
        )}
      </div>

      {/* Cheap left, expensive right — but they are NOT adjacent, and this
          comment used to claim they were. The design pictures "regen frame
          $0.02" beside "Re-render $1.89" on a finished scene, 47x apart, so
          the gap reads in one glance. That pairing cannot exist here: the
          two are gated on disjoint states. Regenerate needs `editable`
          (draft or frame_ready), and the server enforces it —
          actions/frames.ts's assertEditable refuses a done scene outright,
          because once a render has been paid for its reference frame can no
          longer change under it. Rendering both would put a button on screen
          that always fails.
          The whole row is offered on a rendered scene now: regenerate the
          frame, rewrite the prompt, re-render. None of them destroys the
          existing clip — a re-render opens a new version and the old one
          stays pickable (0058_scene_versions.sql) — so the priced "Reopen"
          step that used to guard this no longer guards anything. */}
      {!inFlight && isOwner && (
        <div className="flex flex-wrap items-center gap-3">
          {/* Quietest control in the row, and last: it destroys work rather
              than making any, and it is the one thing here that cannot be
              undone by spending again. Deliberately NOT widened along with
              the rest when editing opened up to rendered scenes — everything
              else here can be re-done by spending again, and this cannot.
              Draft and frame_ready only, which is also what deleteScene
              still accepts. */}
          {(scene.status === "draft" || scene.status === "frame_ready") && (
            <PendingButton
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              pending={deleting}
              onClick={handleDelete}
            >
              Delete scene
            </PendingButton>
          )}

          {/* Reopen is gone. It existed because a 'done' scene was not
              editable and re-rendering destroyed the clip, so there had to
              be a priced, confirmed step back. Neither is true any more:
              editing is refused only while the worker owns the scene
              (lib/editable-guard.ts), and a re-render opens a new version
              rather than overwriting the old clip (0058). What is left is
              the actions themselves, offered directly. */}
          {/* rerenderScene (lib/enqueue-guard.ts's assertSceneRerenderable)
              accepts 'done' and nothing else — a failed scene belongs to
              retryScene, and a scene that has never rendered has nothing to
              re-render. This used to render for every non-in-flight status,
              so a frame_ready scene showed a priced Re-render button whose
              only possible outcome was a refusal. */}
          {isDone && (
            <SceneRerenderDialog
              sceneId={scene.id}
              sceneLabel={sceneLabel}
              costUsd={clipCostUsd}
              settingsLabel={clipSettingsLabel}
              vendor={clipVendor}
              vendorBalanceLabel={vendorBalanceLabel}
              budget={budget}
              busy={sceneBusy}
            />
          )}

          {/* The first render, for a scene that has not had one — or has
              been written back to 'frame_ready' by a frame regeneration
              while an older version's clip is still on screen. Which ACTION
              applies is decided by the scene's STATUS, never by whether the
              clip slot happens to be full: enqueueScene refuses a scene
              that has already rendered, and rerenderScene accepts only
              'done', so offering the wrong one hands over a Confirm that
              can only fail. No frame, no button — assertAllFramed refuses
              it server-side anyway, and the control that fixes it is right
              above. */}
          {!isDone && !isFailed && refFrameUrl && awaitingFirstRender && (
            <SceneRerenderDialog
              sceneId={scene.id}
              sceneLabel={sceneLabel}
              kind="first"
              costUsd={clipCostUsd}
              settingsLabel={clipSettingsLabel}
              vendor={clipVendor}
              vendorBalanceLabel={vendorBalanceLabel}
              budget={budget}
              busy={sceneBusy}
            />
          )}

          {/* classifyRenderError decides whether this is offered at all —
              an out-of-credit or rejected failure cannot succeed on a
              retry, and a Retry button there just invites paying twice for
              the same refusal. */}
          {isFailed &&
            ((failure?.retryable ?? true) ? (
              <SceneRerenderDialog
                kind="retry"
                sceneId={scene.id}
                sceneLabel={sceneLabel}
                costUsd={clipCostUsd}
                settingsLabel={clipSettingsLabel}
                vendor={clipVendor}
                vendorBalanceLabel={vendorBalanceLabel}
                budget={budget}
                confirmAction={handleRetry}
                // `busy` is for the default trigger; this one carries its own
                // disable, and a scene with something else already running
                // must not be able to open the question either.
                trigger={
                  <PendingButton type="button" size="sm" pending={isRetrying} disabled={sceneBusy}>
                    Retry — {usdFormatter.format(clipCostUsd)}
                  </PendingButton>
                }
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Retry unavailable until this is fixed.
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
