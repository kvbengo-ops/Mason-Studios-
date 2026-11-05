// Step 7/8 — Render + Watch (docs/architecture.md § "User flow"). Before
// any scene is queued, this page is the confirmation panel — the last free
// moment before step 7 spends real money. Once enqueueRender or
// enqueueTestScene has run, it becomes the live Realtime progress screen —
// and stays there, rather than flipping back to the confirmation panel,
// for as long as any scene is still draft/frame_ready. A test render only
// ever moves ONE scene past that boundary, so "any scene left" is enough to
// leave the gate behind for good; components/render-progress.tsx is what
// then offers to queue the rest. This page never calls kie; the only write
// it triggers is via actions/enqueue.ts, which sets `scenes.status =
// 'queued'` and nothing else.

import type { JSX } from "react";
import { requireProjectReadable } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { estimateUsdForScenes } from "@/lib/estimate";
import { getModel, isAudioEnabled, parseRenderSettings } from "@/lib/models";
import { getAccountBudgetSnapshot, type AccountBudgetSnapshot } from "@/lib/spend";
import type { RenderBudgetFigures } from "@/lib/render-budget";
import { isEditable } from "@/lib/editable-guard";
import { scenesAwaitingRender } from "@/lib/enqueue-guard";
import { hasMockVideoEvidence } from "@/lib/mock-flags";
import { latestErrorsByScene } from "@/lib/render-error";
import { RenderProgress } from "@/components/render-progress";
import { RenderGate } from "@/components/render-gate";
import { MockModeBanner } from "@/components/mock-mode-banner";

/**
 * Trims lib/spend.ts's AccountBudgetSnapshot (which also carries
 * bindingCap/grantWouldUnblock — sidebar concerns this page doesn't need)
 * down to the plain RenderBudgetFigures shape RenderGate/RenderProgress
 * accept. Both interfaces share every field name deliberately, so this is
 * a pick, not a transform — nothing here can drift the two shapes apart.
 */
function toRenderBudgetFigures(snapshot: AccountBudgetSnapshot): RenderBudgetFigures {
  return {
    dailyCapEnabled: snapshot.dailyCapEnabled,
    dailyRemainingUsd: snapshot.dailyRemainingUsd,
    dailyCapUsd: snapshot.dailyCapUsd,
    weeklyRemainingUsd: snapshot.weeklyRemainingUsd,
    weeklyCapUsd: snapshot.weeklyCapUsd,
    globalRemainingUsd: snapshot.globalRemainingUsd,
    globalCapUsd: snapshot.globalCapUsd,
    globalCapEnabled: snapshot.globalCapEnabled,
    globalCapPeriod: snapshot.globalCapPeriod,
    hourlyRemainingUsd: snapshot.hourlyRemainingUsd,
    hourlyCapUsd: snapshot.hourlyCapUsd,
  };
}

export default async function RenderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  const { project, user, profile, isOwner } = await requireProjectReadable(id);

  const supabase = await createClient();
  const { data: scenes, error } = await supabase
    .from("scenes")
    .select("*")
    .eq("project_id", id)
    .order("idx", { ascending: true });

  if (error) {
    throw new Error(`Failed to load scenes for project ${id}: ${error.message}`);
  }

  const sceneRows = scenes ?? [];
  // Derived, not read from the cached `projects.status` column (see
  // architecture.md § "Derived status") — true once any scene has left the
  // pre-render statuses that actions/enqueue.ts guards on. Same predicate
  // enqueueRender/enqueueTestScene use to decide what's still theirs to
  // queue (isEditable, lib/editable-guard.ts) — a test render trips this
  // exactly like a full one does, on purpose: the gate is a one-time
  // confirmation, not something a partial render should ever show again.
  const hasStartedRendering = sceneRows.some((scene) => !isEditable(scene.status));

  if (!hasStartedRendering) {
    const allFramed = sceneRows.length > 0 && sceneRows.every((scene) => scene.ref_frame_asset_id);
    // Unwrapped, unlike lib/sidebar-budget.ts's fail-soft use of the same
    // function — see getAccountBudgetSnapshot's own doc comment. RenderGate
    // IS the spend gate on this page; a failed read has to throw through to
    // Next's error boundary, not degrade to "no limit" and let a render
    // past every cap this exists to enforce.
    const budget = await getAccountBudgetSnapshot(user.id, profile);

    // No mocked-render banner belongs on this branch: every scene here is
    // still draft/frame_ready, so none has a kie_task_id yet, so there is
    // no evidence to show one way or the other (see
    // lib/mock-flags.ts's hasMockVideoEvidence doc comment on why the web
    // app can prove a past mock render but not the worker's current
    // setting). The honest answer before Confirm is "unknown," not a
    // banner claiming otherwise.
    return (
      <div className="flex flex-col gap-6 p-6">
        <div>
          <h1 className="text-2xl font-medium text-foreground">{project.title}</h1>
          <p className="text-sm text-muted-foreground">Render</p>
        </div>

        {/* Everything below the heading is one client component so that
            changing resolution moves the estimated total immediately — see
            components/render-gate.tsx. Only plain serializable data crosses
            this boundary: no functions, which would typecheck and lint
            cleanly and then fail at runtime. */}
        <RenderGate
          projectId={id}
          scenes={sceneRows.map((scene) => ({
            script_line: scene.script_line,
            video_prompt: scene.video_prompt,
            is_talking_head: scene.is_talking_head,
            duration_s: scene.duration_s,
            // Needed so the gate's total can be grouped by effective
            // settings (groupByEffectiveSettings, lib/estimate.ts) instead
            // of pricing every scene at the picker's current model — a
            // scene an earlier retry pointed at a pricier model keeps it
            // (0045: sticky) even after unfreezeScene returns it to draft
            // and lands back here. See render-gate.tsx's RenderGateScene.
            render_settings_override: scene.render_settings_override,
          }))}
          audioEnabled={isAudioEnabled()}
          initialSettings={parseRenderSettings(project.render_settings)}
          budget={toRenderBudgetFigures(budget)}
          allFramed={allFramed}
          readOnly={!isOwner}
        />
      </div>
    );
  }

  // Same settings enqueueRender persisted for this project, re-read here for
  // the same reason as rerenderScene itself: a scene's re-render button must
  // quote the price the project actually rendered at, not a stale default.
  const settings = parseRenderSettings(project.render_settings);
  const model = getModel(settings.model);
  // Same snapshot-at-load budget the render gate uses, needed here too so
  // each SceneRerenderDialog's Confirm button can disable itself before the
  // server has to refuse — see render-confirm-dialog.tsx's comment on why
  // that check moved to the client as well as the server. Unwrapped, same
  // reasoning as the pre-render branch above.
  const budget = await getAccountBudgetSnapshot(user.id, profile);

  // What a test-scene (or any partial) render leaves behind: the scenes
  // enqueueRender would still queue if run again right now. Priced with the
  // same estimateCost() the batch total uses — never a flat per-second
  // multiply — so a talking-head scene left in the remainder prices the
  // same here as it would on the worker's bill.
  const pending = scenesAwaitingRender(sceneRows);
  // Priced per effective-settings group (estimateUsdForScenes,
  // lib/estimate.ts) rather than with the project's `settings` above: a
  // pending scene can carry a render_settings_override from an earlier retry
  // (0045_scene_render_settings_override.sql — overrides are sticky and
  // survive an unfreeze back to 'draft'), and this card must quote the same
  // number enqueueRender will check against the spend caps, which it now
  // also computes this way.
  const pendingCostUsd =
    pending.length > 0
      ? estimateUsdForScenes(pending, isAudioEnabled(), project.render_settings)
      : 0;

  // One query for the whole project, not one per scene (same shape as
  // actions/enqueue.ts's getSceneStatuses, which this page-load render
  // mirrors) — reduced to the newest classified error per scene_id by
  // lib/render-error.ts's latestErrorsByScene. This covers the page-load
  // render; the live "a scene just failed" case is handled client-side by
  // RenderProgress calling getSceneStatuses itself, since Realtime's
  // `scenes` payload can't carry runs.error — see that component's file
  // header.
  const { data: runsWithErrors, error: runsError } = await supabase
    .from("runs")
    .select("scene_id, error, created_at")
    .eq("project_id", id)
    .not("error", "is", null)
    .order("created_at", { ascending: false });

  if (runsError) {
    throw new Error(`Failed to load run errors for project ${id}: ${runsError.message}`);
  }

  const errorsByScene = latestErrorsByScene(runsWithErrors ?? []);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-medium text-foreground">{project.title}</h1>
        <p className="text-sm text-muted-foreground">Rendering</p>
      </div>

      {hasMockVideoEvidence(sceneRows) ? (
        <MockModeBanner>
          MODE=development was on for at least one scene below — its clip is the worker&apos;s
          canned fixture, not a real kie render. This does not confirm the worker&apos;s current
          setting, only that these specific scenes were mocked when submitted.
        </MockModeBanner>
      ) : null}

      <RenderProgress
        projectId={id}
        initialScenes={sceneRows.map((scene) => ({
          id: scene.id,
          idx: scene.idx,
          is_talking_head: scene.is_talking_head,
          status: scene.status,
          duration_s: scene.duration_s,
          submitted_at: scene.submitted_at,
          // Needed client-side so the "Retry all failed" price is computed
          // at the model each failed scene is actually bound for, not the
          // project's — see RenderProgressScene's own comment and
          // 0045_scene_render_settings_override.sql.
          render_settings_override: scene.render_settings_override,
          error: scene.status === "failed" ? (errorsByScene.get(scene.id) ?? null) : null,
        }))}
        model={model}
        // Load-bearing, even though it reads like a detail: RenderProgress
        // prices the "retry all failed" button with estimateCost(), and
        // retryAllFailed() prices the same set server-side with the live
        // isAudioEnabled(). Leaving this unset would default the client to
        // false, so the moment AUDIO_ENABLED is switched on, a failed
        // talking-head scene would be quoted at LTX's silent rate and billed
        // at the native-audio model's several-times-higher one. The quoted
        // price and the enforced price have to come from the same input.
        audioEnabled={isAudioEnabled()}
        resolution={settings.resolution}
        fps={settings.fps}
        budget={toRenderBudgetFigures(budget)}
        pendingCount={pending.length}
        pendingCostUsd={pendingCostUsd}
        readOnly={!isOwner}
      />
    </div>
  );
}
