"use client";

// A right-column, always-visible expansion of the scene header's chip
// (the former scene-render-override-form.tsx, now deleted). That chip was a
// dropdown —
// see its own header comment — but the reason cuts both ways: a menu that
// has to be OPENED to be read can never be read at the same time as the
// project defaults sitting in render-settings-form.tsx a few hundred pixels
// away, and every price on it is invisible until a click reveals it. This
// panel is the other half of that trade-off: same sceneId, same actions,
// same settings, laid out as a permanent card so "what is this scene set to,
// and against what default" is one glance, not one click then a glance.
//
// OptionRow/OptionButton are copied from render-settings-form.tsx rather
// than imported — that file does not export them, and this panel wants the
// exact same look (label above its row of buttons, selected state, a
// disabled reason surfaced through a hover wrapper because a disabled
// <button> never receives pointer events to paint its own `title`).

import { useOptimistic, useState, useTransition } from "react";
import type { JSX, ReactNode } from "react";
import { toast } from "sonner";
import {
  VIDEO_MODELS,
  isResolutionAllowedForDuration,
  maxDurationForResolution,
  pickModel,
  SEEDANCE_2_5_BYTEPLUS,
  type RenderSettings,
} from "@/lib/models";
import { effectiveRender } from "@/lib/effective-render";
import { updateSceneRenderOverride, clearSceneRenderOverride } from "@/actions/render-settings";
import { toggleTalkingHead, updateSceneDuration } from "@/actions/brief";
import { isSceneInFlight } from "@/lib/editable-guard";
import { useRailEntryBusy } from "@/components/project-rail";
import type { SceneStatus } from "@/types/db";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** One labelled block: label above its row of option buttons. Copied from render-settings-form.tsx. */
function OptionRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

/** One option button. Copied from render-settings-form.tsx — see that file's comment for why the hover wrapper exists. */
function OptionButton({
  selected,
  disabled,
  title,
  onClick,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  children: ReactNode;
}): JSX.Element {
  const button = (
    <Button
      type="button"
      size="sm"
      variant={selected ? "default" : "outline"}
      disabled={disabled}
      title={disabled ? undefined : title}
      onClick={onClick}
      className={cn("h-7 px-2.5 text-xs font-medium", disabled && "opacity-50")}
    >
      {children}
    </Button>
  );

  if (disabled && title) {
    return (
      <span title={title} className="inline-flex">
        {button}
      </span>
    );
  }
  return button;
}

export interface SceneSettingsPanelProps {
  /** The project this scene belongs to — only for the "Project defaults" link below. */
  projectId: string;
  sceneId: string;
  /** scene.duration_s — shown, never picked from a menu, but changed via its own row: it's the scene's own fixed length, not a render setting. */
  durationS: number;
  /** mergeRenderSettings(project.render_settings, scene.render_settings_override) at load — this scene's REAL effective settings, not the project's raw ones. */
  initialSettings: RenderSettings;
  /**
   * Whether scenes.render_settings_override currently carries anything —
   * server-computed, not re-derived from initialSettings here: an override
   * could equal the project's own values field-for-field and still be a
   * real, present override the operator explicitly set.
   */
  initialIsOverridden: boolean;
  /** False while this scene isn't owned by the viewer, or a render is in flight for it — the actions refuse the latter server-side too; this just keeps the panel from offering a control that would only error on click. */
  editable: boolean;
  /** scenes.is_talking_head. Feeds pickModel, which decides the model the render ACTUALLY uses — and therefore the price. */
  isTalkingHead: boolean;
  /** lib/models.ts's isAudioEnabled(), resolved server-side. Same reason: pickModel needs it, and AUDIO_ENABLED is not NEXT_PUBLIC_. */
  audioEnabled: boolean;
  /**
   * isEditable(scene.status) — the MONEY boundary, draft/frame_ready only.
   *
   * Deliberately separate from `editable`, which is the worker-ownership
   * question. updateSceneRenderOverride accepts a rendered scene and
   * updateSceneDuration does not, so one flag cannot answer for both rows.
   */
  lengthEditable: boolean;
  /** scenes.status — read only to explain WHY the panel is inert while the worker owns the scene. */
  status: SceneStatus;
}

export function SceneSettingsPanel({
  projectId,
  sceneId,
  durationS,
  initialSettings,
  initialIsOverridden,
  editable,
  isTalkingHead,
  audioEnabled,
  lengthEditable,
  status,
}: SceneSettingsPanelProps): JSX.Element {
  const [togglingRoll, startRollTransition] = useTransition();

  function toggleRoll(): void {
    startRollTransition(async () => {
      try {
        const result = await toggleTalkingHead(sceneId);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to change the audio setting.");
      }
    });
  }

  const router = useRouter();
  // Local state, RE-SYNCED when the server sends different values.
  //
  // `useState(initialSettings)` alone captures the first render's props and
  // ignores every later one. That is right while this panel is the thing
  // making the change — it is what lets a click paint before the round trip
  // — and wrong for every change made anywhere ELSE. Switching versions
  // writes the version's recorded model, resolution and length back onto
  // the scene (actions/frames.ts's setActiveSceneVersion, 0059), the page
  // re-renders with them, and this panel went on showing the old ones.
  // Reported as: "bakit di nag-uupdate pag nag change ako ng version?"
  //
  // Keyed on the server value rather than a change count, so a save that
  // round-trips to the same settings does not thrash.
  const [savedSettings, setSavedSettings] = useState(initialSettings);
  const [isOverridden, setIsOverridden] = useState(initialIsOverridden);
  // Compared BY VALUE, never by reference. `initialSettings` is built fresh
  // by mergeRenderSettings on every server render, so an identity check is
  // always unequal — it would reset this state on every single render,
  // clobbering the optimistic update mid-click and looping.
  const serverKey = `${initialSettings.model}|${initialSettings.resolution}|${initialSettings.fps}|${initialIsOverridden}`;
  const [syncedTo, setSyncedTo] = useState(serverKey);
  if (serverKey !== syncedTo) {
    // Set-during-render, not an effect: this is React's own documented
    // "adjusting state when props change" pattern, and it repaints in the
    // same commit rather than showing one frame of the stale settings.
    setSyncedTo(serverKey);
    setSavedSettings(initialSettings);
    setIsOverridden(initialIsOverridden);
  }
  const [settings, applyOptimistic] = useOptimistic(
    savedSettings,
    (_state: RenderSettings, next: RenderSettings) => next,
  );
  const [isPending, startTransition] = useTransition();

  // One call, not five hand-rolled ones — see lib/effective-render.ts for
  // the seven defects that came from every screen working this out for
  // itself. `effective` is what renders and what money is computed from;
  // `picked` is only ever what the operator chose.
  const {
    picked: selectedModel,
    effective: model,
    substituted,
    // `reason` deliberately not read: it has one possible value now, and
    // the sentence below states it outright rather than branching on a
    // union of one.
    costUsd: priceUsd,
    costIsUpperBound: priceIsEstimate,
  } = effectiveRender({
    settings,
    durationS,
    isTalkingHead,
    audioEnabled,
  });
  const rateSource = model.id === SEEDANCE_2_5_BYTEPLUS.id ? "BytePlus ModelArk" : "kie";

  // sceneBusy is the WORKBENCH's work, not this panel's — a frame
  // regeneration, a rewrite, a retry, running in the column to the left.
  // Every one of them writes the scene row this panel edits, and the frame
  // regeneration in particular is what a render is priced against, so a
  // model or length changed underneath it settles onto a scene mid-write.
  // Read from the rail store because it is the one signal that spans the
  // two components (and survives a navigation) — see useRailEntryBusy.
  const sceneBusy = useRailEntryBusy(sceneId);
  const disabled = !editable || isPending || sceneBusy;
  const inFlight = isSceneInFlight(status);
  // See the Length row's own comment: updateSceneDuration is guarded by the
  // money boundary (draft/frame_ready), which is stricter than the
  // worker-ownership gate the model and resolution rows answer to.
  const lengthDisabled = disabled || !lengthEditable;

  function save(next: RenderSettings): void {
    startTransition(async () => {
      applyOptimistic(next);
      try {
        const result = await updateSceneRenderOverride(sceneId, next);
        if (result?.error) {
          // Not calling setSavedSettings leaves `savedSettings` at the old
          // value, so useOptimistic reverts to it once the transition ends.
          toast.error(result.error);
          return;
        }
        setSavedSettings(next);
        setIsOverridden(true);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save scene render settings.");
      }
    });
  }

  /**
   * Length is a scene column, not part of the override jsonb, so it takes
   * its own action and its own round trip. Nothing optimistic here: the
   * price above is computed from `durationS`, which is a PROP — only a
   * server round trip and a refresh can move it.
   */
  function saveDuration(seconds: number): void {
    startTransition(async () => {
      try {
        const result = await updateSceneDuration(sceneId, seconds);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to change the clip length.");
      }
    });
  }

  function resetToDefault(): void {
    startTransition(async () => {
      try {
        const result = await clearSceneRenderOverride(sceneId);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        setIsOverridden(false);
        // The server now holds the project's defaults for this scene, and
        // this panel's savedSettings still holds the override that was just
        // deleted — it is useState(initialSettings) and never re-syncs. The
        // header's cost updates from the server render and the panel does
        // not, so without this the two disagree and the button that would
        // explain it is gone.
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to reset scene render settings.");
      }
    });
  }

  return (
    <Card className="gap-3 border-0 bg-transparent p-0 shadow-none">
      <CardHeader className="p-0">
        <CardTitle>Scene Settings</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 p-0">
        {/* Says WHY the panel is inert, rather than leaving five greyed rows
            to be read as broken. Every control here is already gated on
            !isSceneInFlight — the worker owns the scene while it renders,
            and updateSceneRenderOverride/updateSceneDuration/
            toggleTalkingHead all refuse it server-side too. What was
            missing was the sentence. Same defect as the greyed Save button
            that prompted "nag regenerate ako, tapos un save disable pa
            din?????": the app was right and said nothing. */}
        {!inFlight && sceneBusy ? (
          // Distinct from the in-flight banner below, and it has to be: that
          // one means the WORKER owns the scene and settings are settled;
          // this means a call the operator just started is still writing to
          // it. Same greyed rows, two different answers to "when does this
          // come back".
          <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            Something is still running on this scene. These settings come back when it finishes —
            changing them now would land on a row that is being written.
          </p>
        ) : null}
        {inFlight ? (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            This scene is {status}. Its settings are read-only until the render finishes — changing
            the model or length mid-flight would price a clip that is already being billed at the
            old ones.
          </p>
        ) : null}
        {/* Audio, which is what A-roll/B-roll has always actually meant.
            It is pickModel's FIRST argument: a B-roll scene never routes to
            an audio model, whatever is picked below. That makes it the
            single largest lever on this scene's bill, and it used to live
            in the page header with no price anywhere near it.
            Same gate as Length, and for the same reason: toggleTalkingHead
            goes through assertEditable (draft/frame_ready), the money
            boundary — a rendered scene's roll is settled. */}
        <OptionRow label="Audio">
          <OptionButton
            selected={isTalkingHead}
            disabled={disabled || !lengthEditable || togglingRoll}
            title="Spoken to camera. Routes to an audio model when one is picked."
            onClick={
              !isTalkingHead && !disabled && lengthEditable && !togglingRoll
                ? toggleRoll
                : undefined
            }
          >
            A-roll · spoken
          </OptionButton>
          <OptionButton
            selected={!isTalkingHead}
            disabled={disabled || !lengthEditable || togglingRoll}
            title="Silent. Never routes to an audio model, whatever is picked below."
            onClick={
              isTalkingHead && !disabled && lengthEditable && !togglingRoll ? toggleRoll : undefined
            }
          >
            B-roll · silent
          </OptionButton>
        </OptionRow>

        <OptionRow label="Model">
          {VIDEO_MODELS.map((candidate) => {
            const pickable = !disabled;
            return (
              <OptionButton
                key={candidate.id}
                selected={candidate.id === selectedModel.id}
                disabled={disabled}
                onClick={
                  // selectedModel, never `model`: `model` is what pickModel
                  // will SUBSTITUTE, and comparing against it made the
                  // substitute itself unclickable. Pick Kling on a silent
                  // scene and pickModel answers Seedance 2.5 — so Seedance,
                  // the one model you would want to return to, was the one
                  // button with no click handler. "Already chosen" has to
                  // mean what the operator chose.
                  pickable && candidate.id !== selectedModel.id
                    ? (): void => {
                        // The resolution and frame rate come from the model
                        // that will actually RENDER, not the one clicked.
                        //
                        // This is what produced a $9.20 render from a button
                        // advertised at $0.14/s. Picking Kling wrote
                        // resolution=1080p (its defaultResolution — at the
                        // time its only tier); audio is off, so pickModel
                        // then substituted Seedance 2.5 — which
                        // bills 1080p at $1.1497/s against its own 720p
                        // default of $0.315. Eight times the advertised rate,
                        // from a setting the operator never chose, forced by
                        // a model that was never going to run.
                        const effective = pickModel(isTalkingHead, audioEnabled, {
                          model: candidate.id,
                        });
                        save({
                          model: candidate.id,
                          resolution: effective.defaultResolution,
                          fps: effective.defaultFps,
                        });
                      }
                    : undefined
                }
              >
                {candidate.label}
              </OptionButton>
            );
          })}
        </OptionRow>

        <OptionRow label="Length">
          {/* Length is gated harder than model and resolution, and on
              purpose. updateSceneRenderOverride accepts a 'done' scene —
              nothing is in flight to disturb — but updateSceneDuration goes
              through assertEditable (draft/frame_ready only, the money
              boundary in lib/editable-guard.ts). Offering it on a finished
              scene could only ever earn an error toast. */}
          {/* The EFFECTIVE model's lengths and resolutions, not the picked
              one's. Before Kling had a std/720p tier, it offered only
              1080p while Seedance 2.5 offered 720p too — so a silent scene
              set to Kling, which pickModel renders on Seedance, was shown a
              Resolution row with 1080p as its only option. The operator was
              charged $9.20 for eight seconds with no way to see that the
              same render at 720p was $2.52, hidden by a model that was
              never going to run. Same shape for Length: Kling allows 3s and
              Seedance starts at 4s. */}
          {model.allowedDurationsS.map((seconds) => (
            <OptionButton
              key={seconds}
              selected={seconds === durationS}
              disabled={lengthDisabled}
              title={
                !lengthDisabled || disabled
                  ? undefined
                  : "This scene has already rendered. Its length is fixed — re-render on a new version to change it."
              }
              onClick={
                !lengthDisabled && seconds !== durationS
                  ? (): void => saveDuration(seconds)
                  : undefined
              }
            >
              {seconds}s
            </OptionButton>
          ))}
          {model.allowedDurationsS.includes(durationS) ? null : (
            // The scene's stored length is one this model will refuse. Said
            // here rather than silently omitted: a value the operator never
            // chose, quietly missing from its own list, is how a render
            // fails at submit for no visible reason.
            <p className="w-full text-xs text-warning">
              {durationS}s — {model.label} will not accept this
            </p>
          )}
        </OptionRow>

        <OptionRow label="Resolution">
          {model.allowedResolutions.map((resolution) => {
            // Against THIS scene's length, not the project's longest. The
            // panel edits one scene, so the project-wide question the render
            // gate asks would grey out a resolution that is perfectly legal
            // for the scene in front of the operator.
            const legal = isResolutionAllowedForDuration(model, resolution, durationS);
            const max = maxDurationForResolution(model, resolution);
            return (
              <OptionButton
                key={resolution}
                selected={resolution === settings.resolution}
                disabled={disabled || !legal}
                title={
                  legal
                    ? undefined
                    : `${model.label} only accepts ${resolution} for clips of ${max}s or shorter, and this scene is ${durationS}s.`
                }
                onClick={
                  !disabled && legal && resolution !== settings.resolution
                    ? (): void => save({ ...settings, resolution })
                    : undefined
                }
              >
                {resolution}
              </OptionButton>
            );
          })}
          {isResolutionAllowedForDuration(model, settings.resolution, durationS) ? null : (
            // Same reasoning as the Length row's warning above: the stored
            // pair is one the vendor will refuse, and the button carrying it
            // is now greyed out, so without this the operator sees a selected
            // option they cannot deselect and no reason given.
            <p className="w-full text-xs text-warning">
              {settings.resolution} at {durationS}s — {model.label} will not accept this
            </p>
          )}
        </OptionRow>

        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <p className="text-sm text-muted-foreground">
            {usdFormatter.format(priceUsd)} for this scene
          </p>
          {/* Says which of the two kinds of number this is. Everywhere else
              on this screen a price is a measured rate; here it may be a
              published-but-unpaid one. Naming that is the difference
              between a quote and a guess wearing a quote's clothes. */}
          {priceIsEstimate ? (
            <p className="text-xs text-muted-foreground">
              {rateSource === "BytePlus ModelArk"
                ? "This estimate uses BytePlus ModelArk’s published token price, not a receipt; final cost depends on actual token usage."
                : `Nobody has been billed for ${settings.resolution} on ${model.label} yet — this quotes kie’s published rate, not a receipt.`}
            </p>
          ) : null}
          {/* Names the substitution rather than letting the price look
              wrong. A B-roll scene, or any scene with audio off, cannot
              render on an audio model — pickModel drops it to Seedance 2.5
              — so the figure above belongs to a model the picker does not
              show as chosen. Silence here is what made the panel and the
              header disagree. */}
          {substituted ? (
            <p className="text-xs text-warning">
              {/* The reason comes from effectiveRender, which decides it
                  once. Re-deriving it here from isTalkingHead/enabled was
                  a fourth copy of the same branch, and copies are what
                  drift. */}
              {/* One cause left. This used to fan out to three: a B-roll
                  scene and an audio-off account both used to knock a Kling
                  project down to Seedance, and this line explained which.
                  Neither happens any more — a Kling project renders its
                  B-roll on Kling, silently, because that is both cheaper
                  and higher-resolution than the fallback was (see
                  pickModel). Nothing is being hidden here; there is simply
                  nothing left to explain but a disabled model. */}
              {`${selectedModel.label} is not available, so this scene will render on ${model.label} at the price above.`}
            </p>
          ) : null}

          {/* The way to the project-wide defaults, now that the rail has no
              row for them. Deliberately a quiet link and not a button: it
              navigates, it spends nothing, and what it opens — what a NEW
              scene inherits, and the per-30s-ad estimate — is not a decision
              about THIS scene. Without it that screen has no way in at all. */}
          <Link
            href={`/projects/${projectId}/settings`}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Project defaults
          </Link>

          {isOverridden ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={resetToDefault}
              className="self-start text-xs font-medium"
            >
              Return to project default
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
