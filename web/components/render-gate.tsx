"use client";

// The Render gate's pre-flight panel: model / resolution / frame rate, the
// estimated total, and the confirm dialog (docs/architecture.md § "User
// flow" step 7 — "Step 7 is irreversible").
//
// This is one client component rather than a server-rendered cost card with
// a separate settings widget beside it, for one reason: resolution is a 4x
// price lever, and the total has to move the instant it is clicked. Waiting
// for a server action to persist and revalidate before the number changes
// would show the operator a stale price for as long as the round-trip takes
// — on the one screen in the product where a stale price is a lie about
// money. So the estimate is computed here, from the same estimateCost() the
// server uses for the daily-cap check, against optimistic settings.
//
// The persisted value is still the authority: enqueueRender re-reads
// projects.render_settings and re-estimates server-side before checking the
// cap, so an optimistic value that failed to save can never be the one that
// gets billed — it gets reverted here and the render is priced from what is
// actually in the database.

import { useOptimistic, useState, useTransition } from "react";
import type { JSX, ReactNode } from "react";
import { toast } from "sonner";
import { estimateCost, groupByEffectiveSettings, type EstimatableBrief } from "@/lib/estimate";
import {
  KLING_3_PRO,
  VIDEO_MODELS,
  billingResolution,
  getModel,
  isFpsAllowedForDuration,
  isResolutionAllowedForDuration,
  mergeRenderSettings,
  maxDurationForFps,
  maxDurationForResolution,
  priceForSecond,
  type RenderSettings,
} from "@/lib/models";
import { findUnrenderableDurations } from "@/lib/enqueue-guard";
import { updateRenderSettings } from "@/actions/render-settings";
import { RenderConfirmDialog } from "@/components/render-confirm-dialog";
import type { RenderBudgetFigures } from "@/lib/render-budget";
import { remainingForDisplayUsd } from "@/lib/format-usd";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface RenderGateScene {
  script_line: string | null;
  video_prompt: string | null;
  is_talking_head: boolean;
  duration_s: number;
  /**
   * scenes.render_settings_override — a PARTIAL settings object (typically
   * just {model}), or null when this scene inherits the project's wholesale.
   * See 0045_scene_render_settings_override.sql. Threaded down so this
   * card's total can be grouped by EFFECTIVE settings (groupByEffectiveSettings,
   * lib/estimate.ts) the same way enqueueRender prices the batch server-side,
   * instead of pricing every scene at whatever the operator has the picker
   * set to right now — a scene an earlier retry pointed at Kling stays on
   * Kling (sticky) regardless of what this card's Model row says.
   */
  render_settings_override: unknown;
}

/** Scene 1's own cost, priced the same way as the batch total so the two numbers can never disagree. */
function estimateTestSceneUsd(
  scenes: readonly RenderGateScene[],
  audioEnabled: boolean,
  settings: RenderSettings,
): number {
  // `scenes` here is already ordered by idx ascending (render/page.tsx's
  // query), so index 0 IS the scene enqueueTestScene will actually queue —
  // no separate min() needed, same reasoning as actions/enqueue.ts.
  const testScene = scenes[0];
  if (!testScene) return 0;
  // Merged with this scene's own override, same as enqueueTestScene
  // (actions/enqueue.ts) itself does before pricing it — scene 1 can carry
  // an override from an earlier retry same as any other scene.
  const effectiveSettings = mergeRenderSettings(settings, testScene.render_settings_override);
  return estimateCost(toBrief([testScene]), audioEnabled, effectiveSettings).totalUsd;
}

/**
 * Sum of estimateCost() over each DISTINCT effective-settings group
 * (groupByEffectiveSettings, lib/estimate.ts) rather than one estimateCost()
 * call over the whole batch at the operator's picked `settings` — the same
 * switch enqueueRender made server-side for the same reason (0045's
 * header): a scene overridden onto a pricier model, priced at the project's
 * rate, understates the total the daily-cap check is actually run against.
 * `settings` is still the baseline every group merges on top of, so in the
 * overwhelmingly common case (no scene overridden) this produces exactly
 * one group and the same number estimateCost(toBrief(scenes), ...) always
 * gave.
 */
function estimateBatchUsd(
  scenes: readonly RenderGateScene[],
  audioEnabled: boolean,
  settings: RenderSettings,
): number {
  const groups = groupByEffectiveSettings(scenes, settings);
  return groups.reduce(
    (sum, group) =>
      sum + estimateCost(toBrief(group.scenes), audioEnabled, group.settings).totalUsd,
    0,
  );
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const perSecondFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

function toBrief(scenes: readonly RenderGateScene[]): EstimatableBrief {
  return {
    character: "",
    scenes: scenes.map((scene) => ({
      script_line: scene.script_line ?? "",
      video_prompt: scene.video_prompt ?? "",
      is_talking_head: scene.is_talking_head,
      duration_s: scene.duration_s,
    })),
  };
}

/**
 * One row of the compact segmented control. Kept local rather than promoted
 * to components/ui — it exists to make three tiny option rows sit above a
 * cost card without looking like a settings page, which is not a reusable
 * concern yet.
 */
function OptionRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="w-24 shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1">{children}</div>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

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
  return (
    <Button
      type="button"
      size="sm"
      variant={selected ? "default" : "outline"}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn("h-7 px-2.5 text-xs font-medium", disabled && "opacity-50")}
    >
      {children}
    </Button>
  );
}

export function RenderGate({
  projectId,
  scenes,
  audioEnabled,
  initialSettings,
  budget,
  allFramed,
  readOnly = false,
}: {
  projectId: string;
  scenes: readonly RenderGateScene[];
  /** Server-computed AUDIO_ENABLED flag — see lib/models.ts isAudioEnabled(). */
  audioEnabled: boolean;
  /** Parsed projects.render_settings; never partial (see parseRenderSettings). */
  initialSettings: RenderSettings;
  /**
   * lib/spend.ts's getAccountBudgetSnapshot(userId, profile), threaded down
   * as plain data (that module imports next/headers via lib/supabase/server
   * and can't be imported into a Client Component directly). All three
   * ceilings, not just the daily one — see lib/render-budget.ts's
   * bindingRenderCap for why RenderConfirmDialog needs the full picture to
   * agree with the server about which cap would refuse a render.
   */
  budget: RenderBudgetFigures;
  allFramed: boolean;
  /**
   * True when the viewer is an admin looking at someone else's project
   * (requireProjectReadable's `isOwner: false` — see actions/guard.ts).
   * This whole card is nothing but write controls (model/resolution/fps
   * pickers, updateRenderSettings; the two RenderConfirmDialog triggers,
   * enqueueRender/enqueueTestScene) — every one of them is still refused
   * server-side regardless of this prop, so this just keeps a read-only
   * viewer from seeing pickers and confirm buttons that would only error on
   * submit.
   */
  readOnly?: boolean;
}): JSX.Element {
  const [saved, setSaved] = useState(initialSettings);
  const [settings, applyOptimistic] = useOptimistic(
    saved,
    (_state: RenderSettings, next: RenderSettings) => next,
  );
  const [, startTransition] = useTransition();

  const model = getModel(settings.model);
  // Same analysis the blocking guard runs, so the warning above the button
  // and the error behind it can never disagree. Recomputed on every settings
  // change because that is exactly when it changes: switching to a model with
  // a shorter allowed set is what makes a previously-fine brief unrenderable.
  const unrenderable = findUnrenderableDurations(scenes, settings, audioEnabled);
  const longestSceneS = scenes.reduce((longest, scene) => Math.max(longest, scene.duration_s), 0);

  // talkingHeadCount/silentCount/seconds/resolution/silentPerSecondUsd below
  // are read straight off this — none of them depend on which scene rendered
  // on which model (the first three are settings-independent counts/sums,
  // the last two describe the picker's own baseline). totalUsd is NOT read
  // from this: see estimateBatchUsd's own comment for why a flat
  // estimateCost() over the whole batch is the wrong number the instant one
  // scene carries an override.
  const estimate = estimateCost(toBrief(scenes), audioEnabled, settings);
  const totalUsd = estimateBatchUsd(scenes, audioEnabled, settings);
  // Surfaced so this card never implies a project-wide model change moves
  // every scene: an overridden scene's OWN model is sticky (0045) and only
  // its resolution/fps still follow the picker below. Silent unless at least
  // one scene actually carries one, same "only mention it when it's true"
  // rule scene-rerender-dialog.tsx follows for the Kling banner above.
  const overriddenSceneCount = scenes.filter(
    (scene) => scene.render_settings_override != null,
  ).length;

  // Belt to the server action's braces: the same rule is enforced in
  // actions/render-settings.ts (Zod) and again at the gate in
  // lib/enqueue-guard.ts. Here it only has to stop the operator picking a
  // combination that would be refused — an option that errors on click is a
  // worse interface than one that is visibly unavailable and says why.
  const fpsValid =
    isFpsAllowedForDuration(model, settings.fps, longestSceneS) &&
    isResolutionAllowedForDuration(model, settings.resolution, longestSceneS);
  const testSceneUsd = estimateTestSceneUsd(scenes, audioEnabled, settings);

  function save(next: RenderSettings): void {
    startTransition(async () => {
      applyOptimistic(next);
      try {
        const result = await updateRenderSettings(projectId, next);
        if (result?.error) {
          // Not calling setSaved leaves `saved` at the old value, so
          // useOptimistic reverts to it when the transition ends — the
          // displayed total snaps back to the price that is actually
          // stored, no separate rollback needed. Same reasoning applies
          // whether the failure was thrown or, as of the #441 fix,
          // returned as data (see lib/action-result.ts).
          toast.error(result.error);
          return;
        }
        setSaved(next);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save render settings.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ready to render</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
          <OptionRow
            label="Model"
            // Step 4's "surface the price difference where it is picked":
            // an editor has to see a model's per-second rate BEFORE
            // confirming, not after — the same per-second price already
            // shown on every resolution button below, just one level up.
            hint="price is per second, not per clip"
          >
            {VIDEO_MODELS.map((candidate) => {
              const candidatePerSecond = priceForSecond(candidate, candidate.defaultResolution);
              // Every model VIDEO_MODELS lists is unconditionally
              // selectable now — there is no more "disabled pending
              // verification" tier (see lib/models.ts's file header).
              // Kling stays a real, per-project, operator-picked model:
              // selecting it here persists render_settings.model =
              // "kling-3.0-pro"; pickModel then uses it for every scene of
              // the project, with sound only for scenes that are
              // talking-head AND rendering with audio — see this file's
              // amber note below and pickModel's own doc comment
              // (lib/models.ts) for exactly which scenes that is.
              return (
                <OptionButton
                  key={candidate.id}
                  selected={candidate.id === model.id}
                  disabled={readOnly}
                  title={
                    candidate.nativeAudio
                      ? // The talking-head figure is the SOUND rate (audioOn
                        // true), not candidatePerSecond above — that badge
                        // number is deliberately silent (candidate's default
                        // resolution, no third argument), and quoting it here
                        // as what a talking-head scene costs was the bug.
                        // Non-talking-head scenes render on this same model,
                        // silently, at candidatePerSecond — not on Seedance,
                        // which pickModel stopped routing to once Kling
                        // started taking every scene.
                        `${perSecondFormatter.format(priceForSecond(candidate, candidate.defaultResolution, true))}/s — used for this project's talking-head scenes when audio is enabled. Non-talking-head scenes render on it silent at ${perSecondFormatter.format(candidatePerSecond)}/s`
                      : `${perSecondFormatter.format(candidatePerSecond)}/s`
                  }
                  onClick={
                    candidate.id !== model.id && !readOnly
                      ? () =>
                          save({
                            model: candidate.id,
                            // Switching models resets resolution/fps to the
                            // new model's own defaults rather than carrying
                            // the old model's values over — the three
                            // models don't share an allowed set for either.
                            resolution: candidate.defaultResolution,
                            fps: candidate.defaultFps,
                          })
                      : undefined
                  }
                >
                  {candidate.label}
                  <span className="ml-1 opacity-70">
                    {perSecondFormatter.format(candidatePerSecond)}/s
                  </span>
                </OptionButton>
              );
            })}
          </OptionRow>
          {/* The price gap, spelled out in words, right where the operator
              is about to pick this model — not just the per-button price
              tag above. Shown only once Kling is actually the selected
              model: it is no longer an automatic route every project is
              exposed to, so a banner about it has no reason to appear on a
              project that hasn't chosen it. */}
          {model.id === KLING_3_PRO.id ? (
            <p className="pl-24 text-xs text-amber-600 dark:text-amber-500">
              {KLING_3_PRO.label} selected — this project&rsquo;s talking-head scenes render on it
              {audioEnabled ? "" : " once audio is turned on"} at{" "}
              {perSecondFormatter.format(
                // billingResolution, not KLING_3_PRO.defaultResolution: the
                // project may have picked Kling's OTHER tier (std/720p) in
                // the resolution row below, and this banner used to quote
                // pro's rate regardless of which one was actually selected.
                // audioEnabled, not the silent default a missing third
                // argument falls back to: pickModel only turns sound on for
                // a talking-head scene when this project's own audio toggle
                // is on too (isTalkingHead && audioEnabled — see pickModel's
                // doc comment), so quoting the sound rate unconditionally
                // overstated what a silent project actually pays.
                priceForSecond(
                  KLING_3_PRO,
                  billingResolution(KLING_3_PRO, settings.resolution),
                  audioEnabled,
                ),
              )}
              /s. Non-talking-head scenes render on it silent at{" "}
              {perSecondFormatter.format(
                priceForSecond(KLING_3_PRO, billingResolution(KLING_3_PRO, settings.resolution), false),
              )}
              /s.
            </p>
          ) : null}

          {/* Says the durations do not fit BEFORE the click, not after it.
              assertRenderableDurations already refuses the render with the
              same facts, but only once the operator has chosen a model and
              pressed the button — and the case is not rare: Hailuo accepts
              only 6 or 10 seconds, so picking it after a brief compiled
              against the wider Seedance/Kling range routinely produces a
              brief that looks fine and then refuses.

              Read from findUnrenderableDurations, the same function the
              blocking guard calls. Two implementations of "which durations
              are illegal here" would be free to disagree, and the worst
              available shape of that disagreement is a gate showing nothing
              and then refusing. */}
          {unrenderable.map(({ model: badModel, durationsS, count }) => (
            <p key={badModel.id} className="pl-24 text-xs text-amber-600 dark:text-amber-500">
              {count} scene{count === 1 ? "" : "s"} {count === 1 ? "is" : "are"}{" "}
              {durationsS.join("s, ")}s, which {badModel.label} will not accept — it takes{" "}
              {badModel.allowedDurationsS.join(", ")} seconds. Change {count === 1 ? "it" : "them"}{" "}
              on Review Brief, or pick a model that allows{" "}
              {count === 1 ? "that length" : "those lengths"}.
            </p>
          ))}

          {/* Says plainly what picking a model above does NOT do — a
              scene's own override is sticky (0045) and this row only ever
              writes projects.render_settings, never
              scenes.render_settings_override. Without this, "Model" reads
              as "every scene's model," which stopped being true the moment
              any scene could carry its own.
              Fps is still unaffected by any override — nothing writes it
              onto scenes.render_settings_override, so that row keeps
              applying to every scene regardless. Resolution used to be the
              same (RenderSettingsOverrideSchema, the retry path's writer,
              only ever accepts `model`) but is NOT anymore:
              updateSceneRenderOverride (the scene workbench's header
              picker, actions/render-settings.ts) writes resolution onto a
              scene's override too, so an overridden scene's resolution can
              now differ from what this row shows as well. */}
          {overriddenSceneCount > 0 ? (
            <p className="pl-24 text-xs text-muted-foreground">
              {overriddenSceneCount} scene{overriddenSceneCount === 1 ? "" : "s"} already carrying
              its own model (and possibly its own resolution) from an earlier retry or the scene
              page — this control won&rsquo;t change{" "}
              {overriddenSceneCount === 1 ? "that scene's" : "those scenes'"} settings, and the
              total below is already priced accordingly.
            </p>
          ) : null}

          <OptionRow label="Resolution">
            {model.allowedResolutions.map((resolution) => {
              // Some resolutions are only legal up to a duration (kie
              // rejects certain length/resolution pairs on some models,
              // hence maxDurationSByResolution). Enforced in the Zod schema
              // and again at the gate — this only stops the operator
              // picking a combination that would be refused.
              const legal = isResolutionAllowedForDuration(model, resolution, longestSceneS);
              const max = maxDurationForResolution(model, resolution);
              return (
                <OptionButton
                  key={resolution}
                  selected={resolution === settings.resolution}
                  disabled={!legal || readOnly}
                  title={
                    legal
                      ? `${perSecondFormatter.format(priceForSecond(model, resolution))} per second`
                      : `${resolution} is only valid up to ${max}s; this project's longest scene is ${longestSceneS}s.`
                  }
                  onClick={!legal || readOnly ? undefined : () => save({ ...settings, resolution })}
                >
                  {resolution}
                  <span className="ml-1 opacity-70">
                    {perSecondFormatter.format(priceForSecond(model, resolution))}
                    /s
                  </span>
                </OptionButton>
              );
            })}
          </OptionRow>

          <OptionRow label="Frame rate">
            {model.allowedFps.map((fps) => {
              const legal = isFpsAllowedForDuration(model, fps, longestSceneS);
              const max = maxDurationForFps(model, fps);
              return (
                <OptionButton
                  key={fps}
                  selected={fps === settings.fps}
                  disabled={!legal || readOnly}
                  title={
                    legal
                      ? undefined
                      : `${fps} fps is only valid up to ${max}s; this project's longest scene is ${longestSceneS}s.`
                  }
                  onClick={readOnly ? undefined : () => save({ ...settings, fps })}
                >
                  {fps} fps
                </OptionButton>
              );
            })}
          </OptionRow>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-3xl font-semibold tabular-nums text-foreground">
            {usdFormatter.format(totalUsd)}
          </span>
          <span className="text-sm text-muted-foreground">
            {audioEnabled
              ? `${estimate.talkingHeadCount} talking-head + ${estimate.silentCount} silent · ${estimate.seconds}s total`
              : `Audio off — all ${estimate.talkingHeadCount + estimate.silentCount} scenes render silent · ${estimate.seconds}s total`}
            {" · "}
            {perSecondFormatter.format(estimate.silentPerSecondUsd)}/s at {estimate.resolution}
            {overriddenSceneCount > 0
              ? ` for scenes on this model — see the note above for the ${overriddenSceneCount === 1 ? "one that isn't" : "ones that aren't"}`
              : null}
            {/* Only meaningful once Kling is the selected model AND audio is
                on — those are exactly the conditions under which pickModel
                can actually route a talking-head scene to it (see the amber
                note above). Otherwise every scene priced at the one
                silentPerSecondUsd rate already shown (totalUsd itself is
                estimateBatchUsd's grouped sum, not estimate.totalUsd — see
                that function's own comment). */}
            {model.id === KLING_3_PRO.id && audioEnabled && estimate.talkingHeadCount > 0
              ? ` (talking-head: ${perSecondFormatter.format(
                  priceForSecond(
                    KLING_3_PRO,
                    billingResolution(KLING_3_PRO, settings.resolution),
                    true,
                  ),
                )}/s)`
              : null}
          </span>
        </div>

        {/* Both windows, not just daily — an account can be well under its
            daily burst guard and still be out of allowance for the week
            (see components/sidebar-budget.tsx's own BudgetLine comment on
            why $2/day, $5/week means the weekly figure is what usually
            binds first). Showing only "remaining daily budget" here, as
            this used to, is exactly the number/enforcement mismatch lib/
            render-budget.ts's bindingRenderCap now exists to close. */}
        <p className="flex flex-col gap-0.5 text-sm text-muted-foreground">
          {budget.dailyCapEnabled !== false ? (
            <span>
              Left today:{" "}
              <span className="font-medium text-foreground">
                {usdFormatter.format(remainingForDisplayUsd(budget.dailyRemainingUsd))}
              </span>{" "}
              of {usdFormatter.format(budget.dailyCapUsd)}
            </span>
          ) : null}
          <span>
            Left this week:{" "}
            <span className="font-medium text-foreground">
              {usdFormatter.format(remainingForDisplayUsd(budget.weeklyRemainingUsd))}
            </span>{" "}
            of {usdFormatter.format(budget.weeklyCapUsd)}
          </span>
        </p>

        {readOnly ? (
          <p className="text-right text-sm text-muted-foreground">
            Read-only — only the project owner can queue a render.
          </p>
        ) : !allFramed ? (
          <p className="text-sm text-destructive">
            Not every scene has a reference frame yet — finish the Review Frames gate before
            rendering.
          </p>
        ) : !fpsValid ? (
          <p className="text-sm text-destructive">
            {settings.fps} fps cannot render a {longestSceneS}s scene on {model.label}. Pick a lower
            frame rate before rendering.
          </p>
        ) : (
          <div className="flex flex-col items-end gap-2">
            <div className="flex flex-wrap items-center justify-end gap-3">
              <p className="max-w-64 text-right text-xs text-muted-foreground">
                Costs less — confirms one clip works before committing to the whole batch.
              </p>
              <RenderConfirmDialog
                projectId={projectId}
                kind="test"
                totalUsd={testSceneUsd}
                budget={budget}
                sceneCount={1}
                resolution={settings.resolution}
                fps={settings.fps}
              />
              <RenderConfirmDialog
                projectId={projectId}
                kind="all"
                totalUsd={totalUsd}
                budget={budget}
                sceneCount={scenes.length}
                resolution={settings.resolution}
                fps={settings.fps}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
