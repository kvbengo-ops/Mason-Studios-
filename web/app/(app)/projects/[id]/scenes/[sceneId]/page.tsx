import type { JSX } from "react";
import { requireProjectReadable } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { signedUrl, getImageUrl } from "@/lib/storage";
import { buildSceneVersions } from "@/lib/scene-versions";
import {
  mergeRenderSettings,
  isAudioEnabled,
  pickModel,
  parseCompilerModel,
  applySceneCostUsd,
  estimatedRefFrameCostUsd,
} from "@/lib/models";
import { estimateCost } from "@/lib/estimate";
import { classifyRenderError, type RenderErrorInfo } from "@/lib/render-error";
import { getKieAccountBalanceUsd } from "@/lib/kie-balance";
import { getAccountBudgetSnapshot, type AccountBudgetSnapshot } from "@/lib/spend";
import type { RenderBudgetFigures } from "@/lib/render-budget";
import { SceneWorkbench, type SceneWorkbenchProps } from "@/components/scene-workbench";
import { SceneSettingsPanel } from "@/components/scene-settings-panel";
import { ProjectSettingsSidebar } from "@/components/project-settings-sidebar";
import { SceneBusyFieldset } from "@/components/scene-busy-fieldset";
import { isSceneInFlight, isEditable } from "@/lib/editable-guard";
import type { Database } from "@/types/db";

type AssetRow = Database["public"]["Tables"]["assets"]["Row"];

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

/**
 * kie sells credits, not dollars — see lib/project-rail.ts's own
 * formatKieCredits for the full reasoning (a real balance reads as "$0.32"
 * when it is in fact 64 credits, and the operator tops up, and is quoted,
 * only ever in credits). The rail's budget block and the Re-render button
 * have to name the SAME quantity in the SAME unit or the button's "left"
 * figure and the rail's disagree on screen, so this deliberately mirrors
 * that formatter rather than inventing a second presentation.
 *
 * Duplicated rather than imported because lib/project-rail.ts keeps
 * formatKieCredits private; hoisting it into a shared module is a
 * cross-file change this screen doesn't own (see the report's "needs
 * another owner").
 */
const KIE_USD_PER_CREDIT = 0.005;

function formatVendorBalance(balanceUsd: number | null): string | null {
  // null stays null all the way to the button: "we don't know" and "you
  // have nothing" must not look the same to someone about to spend, which
  // is lib/kie-balance.ts's own rule for this number.
  if (balanceUsd === null) return null;
  return `${Math.round(balanceUsd / KIE_USD_PER_CREDIT).toLocaleString("en-US")} cr`;
}

export default async function ScenePage({
  params,
}: {
  params: Promise<{ id: string; sceneId: string }>;
}): Promise<JSX.Element> {
  const { id: projectId, sceneId } = await params;
  const { project, user, profile, isOwner } = await requireProjectReadable(projectId);

  const supabase = await createClient();

  // Load the scene
  const { data: scene, error: sceneError } = await supabase
    .from("scenes")
    .select("*")
    .eq("id", sceneId)
    .eq("project_id", projectId)
    .single();

  if (sceneError || !scene) {
    throw new Error(`Scene ${sceneId} not found in project ${projectId}`);
  }

  // Every attempt at this scene, newest first, each paired with the clip it
  // produced (lib/scene-versions.ts derives that pairing from time rather
  // than a column the Go worker would have to write).
  const [{ data: versionRows }, { data: clipRows }] = await Promise.all([
    supabase
      .from("scene_versions")
      .select(
        "id, n, created_at, video_prompt, ref_frame_asset_id, clip_asset_id, render_settings, duration_s",
      )
      .eq("scene_id", sceneId),
    supabase
      .from("assets")
      .select("id, created_at")
      .eq("scene_id", sceneId)
      .eq("kind", "clip")
      .order("created_at", { ascending: true }),
  ]);

  const sceneVersions = buildSceneVersions(versionRows ?? [], clipRows ?? []);

  // Just the ACTIVE frame. The version picker switches
  // scenes.ref_frame_asset_id along with the prompt (setActiveSceneVersion),
  // so this column already answers "which frame am I looking at" — signing
  // every historical frame to then pick one out of the list was paying for
  // URLs nothing renders.
  let refFrameUrl: string | null = null;
  if (scene.ref_frame_asset_id) {
    const { data: refFrameAsset } = await supabase
      .from("assets")
      .select("storage_key")
      .eq("id", scene.ref_frame_asset_id)
      .maybeSingle();

    if (refFrameAsset) {
      refFrameUrl = await getImageUrl(refFrameAsset.storage_key, "medium");
    }
  }

  // The clip belonging to the ACTIVE VERSION — not "the scene's clip".
  //
  // This used to be a `.single()` on kind='clip', which was correct only
  // while re-rendering deleted the previous clip first. Superseded clips
  // survive now (0058_scene_versions.sql), so that query would have thrown
  // on the second render and, before it did, showed whichever row came
  // back — including a clip belonging to a version the operator had just
  // switched away from. Switching to a version that never produced a clip
  // has to show no clip; that is most of the point of switching.
  let clipAsset: AssetRow | null = null;
  let clipUrl: string | null = null;
  {
    const activeClipId = sceneVersions.find(
      (version) => version.id === scene.active_version_id,
    )?.clipAssetId;

    if (activeClipId) {
      const { data: asset } = await supabase
        .from("assets")
        .select("*")
        .eq("id", activeClipId)
        .maybeSingle();

      if (asset) {
        clipAsset = asset;
        clipUrl = await signedUrl(asset.storage_key);
      }
    } else if (!scene.active_version_id && (scene.status === "done" || scene.status === "failed")) {
      // No version at all — a scene that has not rendered since 0058. Fall
      // back to the pre-0058 answer rather than blanking a clip that is
      // genuinely there.
      const { data: asset } = await supabase
        .from("assets")
        .select("*")
        .eq("scene_id", sceneId)
        .eq("kind", "clip")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (asset) {
        clipAsset = asset;
        clipUrl = await signedUrl(asset.storage_key);
      }
    }
  }

  // Why this scene's render failed, in the operator's language. Same source
  // and same classifier the render page's per-scene cards use
  // (actions/enqueue.ts's getSceneStatuses → lib/render-error.ts), so the
  // two screens can never disagree about whether a retry is worth paying
  // for: classifyRenderError's `retryable: false` categories (out of
  // credit, content rejected) are the ones where a Retry button would only
  // spend money to fail identically.
  //
  // Only read for a 'failed' scene — a 'done' scene may still have a stale
  // error row from an earlier attempt that has since been retried
  // successfully, and surfacing that would report a failure that no longer
  // exists.
  let failure: RenderErrorInfo | null = null;
  if (scene.status === "failed") {
    const { data: failedRuns } = await supabase
      .from("runs")
      .select("error, created_at")
      .eq("scene_id", sceneId)
      .not("error", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    failure = classifyRenderError(failedRuns?.[0]?.error ?? null);
  }

  // What this scene has ACTUALLY been billed, summed from runs. The clip
  // card used to print the list price and call it "what the rendered clip
  // cost", on the reasoning that a rendered scene's settings are frozen —
  // which is not true: settingsEditable in the workbench deliberately leaves
  // the model chip live on a done scene, and updateSceneRenderOverride only
  // refuses queued/rendering. So changing the model after a render silently
  // rewrote the price of a clip that had already been paid for.
  const { data: sceneRuns } = await supabase
    .from("runs")
    .select("cost_usd")
    .eq("scene_id", sceneId);
  const clipSpentUsd = (sceneRuns ?? []).reduce(
    (sum, run) => sum + (typeof run.cost_usd === "number" ? run.cost_usd : 0),
    0,
  );

  // Compute render settings and costs
  const effectiveSettings = mergeRenderSettings(
    project.render_settings as unknown,
    scene.render_settings_override as unknown,
  );
  const audioEnabled = isAudioEnabled();

  // The model that will ACTUALLY receive this scene, not the one the
  // project selected: pickModel falls a non-qualifying scene back off
  // Kling to the silent default, so reading `nativeAudio` (and the vendor)
  // off the selected descriptor would claim audio on a clip that is
  // rendering silently. Both of these are displayed on the clip card, so
  // they have to describe the real render.
  const renderedModel = pickModel(scene.is_talking_head, audioEnabled, effectiveSettings);
  const clipHasAudio = renderedModel.nativeAudio;

  // Was a hardcoded `0.0398` with the real helper call commented out beside
  // it, and the button's own comment still saying "$0.02" — three numbers
  // that could each drift on their own. This is the same helper
  // updateScenePromptAndRegenerate's cap check spends against
  // (actions/frames.ts).
  const frameCostUsd = estimatedRefFrameCostUsd();
  // What the prompt column's "Rewrite with AI" button spends — priced on
  // the project's OWN compiler-model choice, exactly as applyScenePrompt
  // (actions/brief.ts) prices the call it is about to make, rather than the
  // flat APPLY_SCENE_COST_USD placeholder the Brief table still shows.
  const rewriteCostUsd = applySceneCostUsd(parseCompilerModel(project.render_settings));
  const clipCostEstimate = estimateCost(
    {
      character: "",
      scenes: [
        {
          script_line: scene.script_line ?? "",
          video_prompt: scene.video_prompt ?? "",
          is_talking_head: scene.is_talking_head,
          duration_s: scene.duration_s,
        },
      ],
    },
    audioEnabled,
    effectiveSettings,
  ).totalUsd;

  // Budget for the spend buttons, and the balance the Re-render button
  // actually names. These are DIFFERENT quantities and both are real: the
  // three caps are this account's own spending ceilings (enforced by
  // assertWithinSpendCaps), while kie's balance is the money that exists to
  // be spent at all — an account can sit well inside every cap while kie's
  // credits are exhausted, and vice versa. The button shows kie's balance
  // (the design's point: the number that refuses the call), the dialog
  // keeps showing the caps.
  const [budget, vendorBalanceUsd] = await Promise.all([
    getAccountBudgetSnapshot(user.id, profile),
    getKieAccountBalanceUsd(),
  ]);
  const budgetFigures = toRenderBudgetFigures(budget);

  // scenes.render_settings_override is a PARTIAL jsonb blob (0045) — a null
  // or empty object means "no override," not "an override of nothing," so
  // this checks for at least one key rather than just non-null. Server-
  // computed rather than re-derived client-side, same reason every other
  // gate in this file lives on the server: the scene row is the only source
  // of truth for whether an override actually exists.
  const sceneIsOverridden =
    typeof scene.render_settings_override === "object" &&
    scene.render_settings_override !== null &&
    Object.keys(scene.render_settings_override as Record<string, unknown>).length > 0;

  const sceneWorkbenchProps: SceneWorkbenchProps = {
    scene,
    refFrameUrl,
    versions: sceneVersions.map((version) => ({
      id: version.id,
      n: version.n,
      createdAt: version.createdAt,
      hasClip: version.clipAssetId !== null,
      renderSettings: version.renderSettings,
      durationS: version.durationS,
    })),
    activeVersionId: scene.active_version_id,
    clipAsset,
    clipUrl,
    isOwner,
    frameCostUsd,
    rewriteCostUsd,
    clipCostUsd: clipCostEstimate,
    // The three values clipCostEstimate is priced from, for the confirm
    // dialogs. renderedModel, not the project's selected descriptor: that is
    // the model pickModel actually routes this scene to, and it is what
    // estimateCost above billed against.
    clipSettingsLabel: `${renderedModel.label} · ${effectiveSettings.resolution} · ${scene.duration_s}s`,
    clipSpentUsd,
    clipVendor: "kie",
    clipHasAudio,
    vendorBalanceLabel: formatVendorBalance(vendorBalanceUsd),
    failure,
    budget: budgetFigures,
  };

  // Two columns, and only here. The settings panel rides the SCENE page
  // rather than the project layout: these are decisions about this scene,
  // and on Character, Product or Deliver a column of render pickers would be
  // furniture beside work it has nothing to do with.
  //
  // Because it lives on the page that owns the scene, the panel takes the
  // scene as a prop — no portal, no slot, no id shared between a layout and
  // its child.
  return (
    <div className="flex flex-col xl:flex-row xl:items-stretch">
      <div className="min-w-0 flex-1">
        <SceneWorkbench {...sceneWorkbenchProps} />
      </div>
      {/* Sticky and independently scrollable on the same terms as the rail
          opposite it — see the layout's aside for why xl is the breakpoint
          and why self-start is required in an items-stretch row.
          Below xl it stacks under the workbench instead of disappearing:
          unlike the project-wide settings, these controls have no other
          route to be reached from. */}
      <aside className="flex flex-col divide-y divide-border border-t border-border px-4 [&>*]:py-5 [&>*:first-child]:pt-4 xl:sticky xl:top-0 xl:max-h-svh xl:w-[400px] xl:shrink-0 xl:self-start xl:overflow-y-auto xl:no-scrollbar xl:border-l xl:border-t-0">
        <SceneSettingsPanel
          projectId={projectId}
          sceneId={scene.id}
          durationS={scene.duration_s}
          initialSettings={effectiveSettings}
          // The careful predicate, not `!== null`: an override written and
          // then emptied leaves `{}` behind, which is not an override and
          // must not offer a "return to project default" control.
          initialIsOverridden={sceneIsOverridden}
          editable={sceneWorkbenchProps.isOwner && !isSceneInFlight(scene.status)}
          isTalkingHead={scene.is_talking_head}
          audioEnabled={audioEnabled}
          lengthEditable={isEditable(scene.status)}
          status={scene.status}
        />
        {/* The project's own settings, directly under this scene's.
            Shooting Mode, Direction and Captions shape every scene's prompt
            before a render is ever submitted, and none of them has a
            per-scene twin. The project's RENDER defaults are left out: the
            panel above already carries those three pickers for the scene in
            front of you, and two model rows in one narrow column is a
            question about which one you are touching. They stay reachable
            at /settings, where the rail's row leads. */}
        {/* The client-side half of the same lock. frozenReason below covers
            what the SERVER can see — the worker owning this scene — and this
            covers what only the browser knows: a frame regeneration or a
            rewrite the operator started moments ago. Two sources, one
            outcome, and neither can answer for the other. */}
        <SceneBusyFieldset sceneId={scene.id}>
          <ProjectSettingsSidebar
            project={project}
            isOwner={isOwner}
            showRenderDefaults={false}
            // Frozen for the same reason the panel above is: the worker is
            // reading a prompt these settings shaped, and a render in flight
            // cannot be re-aimed. It unlocks when the clip lands or fails.
            frozenReason={
              isSceneInFlight(scene.status)
                ? `This scene is ${scene.status}. Direction, Shooting Mode and Captions are read-only until it finishes — they shape the prompt the worker is reading right now.`
                : null
            }
          />
        </SceneBusyFieldset>
      </aside>
    </div>
  );
}
