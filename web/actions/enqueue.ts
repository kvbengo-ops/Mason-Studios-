"use server";

// Step 7 — Render (docs/architecture.md § "User flow", § "The contract").
//
// CRITICAL CONSTRAINT: nothing in this file calls kie. The only thing the
// web app ever does to start a render is write `scenes.status = 'queued'`
// (with `dev`, below) and stop — the Go worker's dispatch loop is the only
// thing that submits a job to kie. Every function below writes status (and
// dev) only; there is no video generation call anywhere here, and there
// must never be one.
//
// Every write below also sets `dev: isDev()`. This is the write half of the
// MODE contract (lib/mode.ts's header has the full incident): a worker only
// claims scenes.dev rows matching its own mode
// (worker/internal/store/store.go's ClaimQueuedScenes), so a scene queued
// by a MODE=development process here can never be picked up, submitted, or
// billed by the deployed production worker, no matter how many workers are
// polling this same table.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireProject, requireScene } from "@/actions/guard";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isDev } from "@/lib/mode";
import {
  estimateCost,
  estimateUsdForScenes,
  groupByEffectiveSettings,
  type EstimatableBrief,
} from "@/lib/estimate";
import {
  RenderSettingsOverrideSchema,
  getModel,
  isAudioEnabled,
  isModelAvailableForSelection,
  mergeRenderSettings,
  type RenderSettings,
} from "@/lib/models";
import { assertWithinSpendCaps } from "@/lib/spend";
import {
  assertAllFramed,
  assertSettingsAllowedForDurations,
  assertNotAlreadySpent,
  assertRenderableDurations,
  assertSceneRerenderable,
  scenesAwaitingRender,
} from "@/lib/enqueue-guard";
import { guardResult, type ActionResult } from "@/lib/action-result";
import { latestErrorsByScene, type RenderErrorInfo } from "@/lib/render-error";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

type SceneRow = Database["public"]["Tables"]["scenes"]["Row"];

function renderPath(projectId: string): string {
  return `/projects/${projectId}/render`;
}

type PricedSceneRow = SceneRow & { videoReferenceDurationsS?: readonly (number | null)[] };

function toBrief(scenes: readonly PricedSceneRow[]): EstimatableBrief {
  return {
    character: "",
    scenes: scenes.map((scene) => ({
      script_line: scene.script_line ?? "",
      video_prompt: scene.video_prompt ?? "",
      is_talking_head: scene.is_talking_head,
      duration_s: scene.duration_s,
      ...(scene.videoReferenceDurationsS === undefined
        ? {}
        : { videoReferenceDurationsS: scene.videoReferenceDurationsS }),
    })),
  };
}

async function withSceneVideoReferenceDurations(scene: SceneRow): Promise<PricedSceneRow> {
  const [priced] = await withScenesVideoReferenceDurations([scene]);
  // The one-element input above always yields one element. This branch only
  // satisfies noUncheckedIndexedAccess without weakening the return type.
  if (!priced) throw new Error(`Failed to price scene ${scene.id}`);
  return priced;
}

async function withScenesVideoReferenceDurations(
  scenes: readonly SceneRow[],
): Promise<PricedSceneRow[]> {
  if (scenes.length === 0) return [];

  const admin = createAdminClient();
  const { data: references, error: referencesError } = await admin
    .from("scene_references")
    .select("scene_id, asset_id, kind")
    .in(
      "scene_id",
      scenes.map((scene) => scene.id),
    );
  if (referencesError) {
    throw new Error(`Failed to read scene video references: ${referencesError.message}`);
  }

  const referencesByScene = new Map<string, { asset_id: string; kind: string }[]>();
  for (const reference of references ?? []) {
    const sceneReferences = referencesByScene.get(reference.scene_id) ?? [];
    sceneReferences.push(reference);
    referencesByScene.set(reference.scene_id, sceneReferences);
  }

  const liveVideoAssetIds = scenes.flatMap((scene) => {
    const sceneReferences = referencesByScene.get(scene.id) ?? [];
    const videoIds = sceneReferences
      .filter((reference) => reference.kind === "video")
      .map((reference) => reference.asset_id);
    // Preserve the pre-scene_references fallback for old scenes. The worker
    // treats ref_frame_asset_id as the sole live reference when no rows exist.
    return sceneReferences.length === 0 && scene.ref_frame_asset_id
      ? [scene.ref_frame_asset_id]
      : videoIds;
  });
  if (liveVideoAssetIds.length === 0) {
    return scenes.map((scene) => ({ ...scene, videoReferenceDurationsS: [] }));
  }

  const { data: assets, error: assetsError } = await admin
    .from("assets")
    .select("id, kind, duration_s")
    .in("id", [...new Set(liveVideoAssetIds)]);
  if (assetsError) throw new Error(`Failed to read scene video references: ${assetsError.message}`);

  const durationById = new Map(
    (assets ?? [])
      .filter((asset) => asset.kind === "video_ref")
      .map((asset) => [asset.id, asset.duration_s]),
  );
  return scenes.map((scene) => {
    const sceneReferences = referencesByScene.get(scene.id) ?? [];
    const usingLegacyFallback = sceneReferences.length === 0 && Boolean(scene.ref_frame_asset_id);
    const videoAssetIds = usingLegacyFallback
      ? [scene.ref_frame_asset_id!]
      : sceneReferences
          .filter((reference) => reference.kind === "video")
          .map((reference) => reference.asset_id);
    if (usingLegacyFallback && !durationById.has(scene.ref_frame_asset_id!)) {
      return { ...scene, videoReferenceDurationsS: [] };
    }
    return {
      ...scene,
      videoReferenceDurationsS: videoAssetIds.map((assetId) => durationById.get(assetId) ?? null),
    };
  });
}

/**
 * Validates an operator-supplied model id for a retry and turns it into the
 * partial jsonb blob scenes.render_settings_override holds.
 *
 * Returns `null` for "no override requested" (the ordinary retry), an
 * `{ error }` ActionResult for a model that cannot be selected — an
 * operator-actionable refusal, not a thrown failure, same as every other
 * guard in this file (lib/action-result.ts) — and the blob otherwise.
 */
function resolveOverride(
  modelId: string | undefined,
  projectSettings: unknown,
): { override: Record<string, string> | null } | { error: string } {
  if (modelId === undefined) return { override: null };

  const parsed = RenderSettingsOverrideSchema.safeParse({ model: modelId });
  if (!parsed.success) {
    return { error: `Invalid retry model: ${parsed.error.issues.map((i) => i.message).join(" ")}` };
  }
  const settings = mergeRenderSettings(projectSettings, { model: parsed.data.model });
  if (!isModelAvailableForSelection(settings.model, settings.resolution)) {
    return { error: "Gemini Omni Video is unavailable until a paid receipt exists." };
  }
  return { override: { model: parsed.data.model } };
}

function unavailableModelResult(settings: RenderSettings): ActionResult | null {
  if (!isModelAvailableForSelection(settings.model, settings.resolution)) {
    return { error: "Gemini Omni Video is unavailable until a paid receipt exists." };
  }
  return null;
}

async function loadOrderedScenes(projectId: string): Promise<SceneRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("scenes")
    .select("*")
    .eq("project_id", projectId)
    .order("idx", { ascending: true });

  if (error) {
    throw new Error(`Failed to load scenes for project ${projectId}: ${error.message}`);
  }
  return data ?? [];
}

/**
 * Enqueues a render — the money step (docs/architecture.md § "Cost model":
 * "Everything before step 7 costs under a dollar. Step 7 is irreversible.").
 *
 * Only ever submits scenesAwaitingRender(scenes) — draft/frame_ready — not
 * the whole project. That's what lets this run a second time after a test
 * render (enqueueTestScene) or an interrupted batch: scenes already
 * queued/rendering/done/failed are left untouched rather than refused
 * outright or re-charged, which is what makes the render gate survive a
 * partial render instead of being a one-shot "all or nothing" button.
 *
 * Refuses unless every scene being submitted has passed both gates
 * (ref_frame_asset_id set) and none of them has already been
 * queued/rendered/failed, then checks the daily spend cap — priced on just
 * those scenes — before writing anything. The only write here is
 * `scenes.status = 'queued'` and `projects.status = 'rendering'` — the Go
 * worker's dispatch loop does everything from there.
 */
export async function enqueueRender(projectId: string): Promise<ActionResult> {
  const { project, user, profile } = await requireProject(projectId);

  const scenes = await loadOrderedScenes(projectId);
  if (scenes.length === 0) {
    return { error: `Project ${projectId} has no scenes to render.` };
  }

  const pending = scenesAwaitingRender(scenes);
  if (pending.length === 0) {
    return {
      error:
        `Every scene in project ${projectId} has already been queued or rendered — ` +
        "nothing left to enqueue.",
    };
  }

  // Re-read the settings server-side rather than trusting anything the
  // client sent: the render gate shows an optimistic total while the
  // operator clicks through resolutions, and the only price allowed to
  // reach the daily-cap check is the one actually persisted.
  // Grouped by EFFECTIVE settings, not read as one project-wide object: a
  // scene carrying a render_settings_override from an earlier retry keeps it
  // (0045 — the override is sticky, deliberately), and unfreezeScene
  // (actions/brief.ts) can put such a scene back to 'draft' where
  // scenesAwaitingRender picks it up again. So a batch reaching this point
  // may legitimately contain scenes bound for two different models, and both
  // the guards and the price below have to see that.
  const groups = groupByEffectiveSettings(pending, project.render_settings);
  // Read once and reused everywhere below (the duration guard, the
  // estimate) rather than called again at each site — the same "must use
  // the same read the operator was quoted with" reasoning the estimateCost
  // comment below already gives, now also applying to which model each
  // scene validates its duration against.
  const audioEnabled = isAudioEnabled();

  // Each of these is an operator-actionable guard (a message that tells them
  // what to fix), not an unexpected failure — see lib/action-result.ts for
  // why that means "return", not "throw". Scoped to `pending`, not `scenes`
  // — a scene that already rendered already passed these when it was
  // queued (as itself or as part of an earlier batch) and re-checking it
  // here would just be re-validating a fact that can no longer change.
  const framedResult = guardResult(() => assertAllFramed(pending));
  if (framedResult) return framedResult;
  const spentResult = guardResult(() => assertNotAlreadySpent(pending));
  if (spentResult) return spentResult;
  // Validates each scene against the model IT will actually render on
  // (lib/models.ts's pickModel, mirroring the worker's PickModel) rather
  // than against one project-wide model — those agree only while every
  // scene renders silent on the project's own settings. See
  // assertRenderableDurations's doc comment.
  //
  // Both of the settings-dependent guards run once per effective-settings
  // group. assertRenderableDurations already resolves the model per scene
  // within a group (lib/models.ts's pickModel), but it can only do that
  // relative to the settings it is handed — handing it the project's
  // settings for a scene overridden onto another model would validate that
  // scene's duration against a model it will never touch.
  for (const group of groups) {
    const unavailableResult = unavailableModelResult(group.settings);
    if (unavailableResult) return unavailableResult;
    const durationsResult = guardResult(() =>
      assertRenderableDurations(group.scenes, group.settings, audioEnabled),
    );
    if (durationsResult) return durationsResult;
    // 50 fps is legal, and a 12s clip is legal, but not together — a
    // cross-field rule neither the settings object nor the scene rows can
    // catch alone. Last chance before kie 422s the whole batch. Checked
    // against this group's one model rather than per scene — see this
    // guard's own doc comment in lib/enqueue-guard.ts.
    const settingsResult = guardResult(() =>
      assertSettingsAllowedForDurations(
        group.scenes,
        getModel(group.settings.model),
        group.settings,
      ),
    );
    if (settingsResult) return settingsResult;
  }

  // Must use the same AUDIO_ENABLED read and the same resolution as the
  // "Ready to render" card the operator just approved — otherwise the
  // daily-cap check enforces a different price than what they were shown.
  // Resolution matters most here: at 2160p the real bill is 4x the 1080p
  // estimate, so a cap check run at the wrong resolution would wave through
  // a render four times larger than the budget allows. Priced on `pending`
  // only — a scene already rendered already spent its own money, counted
  // separately in getDailySpend below, and must not be billed twice here.
  // Summed per effective-settings group (estimateUsdForScenes above), so a
  // scene overridden onto a pricier model is billed to the cap check at THAT
  // model's rate rather than the project's — the cap bypass 0045's header
  // calls out as the dangerous half of this feature.
  // Scene references are mutable independently of scenes, so hydrate their
  // live video durations immediately before the cap check. Gemini's fixed
  // source-video price cannot be derived from the scene row alone.
  const pricedPending = await withScenesVideoReferenceDurations(pending);
  const estimatedUsd = estimateUsdForScenes(pricedPending, audioEnabled, project.render_settings);
  // Global, then weekly, then daily-burst — see assertWithinSpendCaps'
  // own doc comment (lib/spend.ts) for why that order is fixed there
  // rather than re-decided at each of enqueue.ts's five call sites.
  // getGlobalDailySpend/getWeeklySpend/getDailySpend can each fail on a
  // genuine Postgres error (unexpected — stays thrown); the three
  // assert*NotExceeded calls inside are the operator-actionable guards
  // (returned) — assertWithinSpendCaps keeps that split without every
  // call site re-typing it.
  //
  // NOTE — concurrency: every read inside is a point-in-time snapshot with
  // no lock. Two editors who click Confirm in the same window can both
  // read the same total, both pass, and both proceed — see the
  // CONCURRENCY HOLE comment in lib/spend.ts for the full explanation and
  // what a real fix requires.
  const capResult = await assertWithinSpendCaps(user.id, profile, estimatedUsd);
  if (capResult) return capResult;

  const admin = createAdminClient();

  // One version per scene, sequentially: each needs its own `n`, and the
  // counter is read-then-written, so firing them together would race two
  // scenes onto the same number. A batch is already a multi-second call and
  // this is a handful of tiny writes inside it.
  for (const scene of pending) {
    // Per scene, not per project: a scene carrying an override renders on
    // ITS merged settings, which is what its version has to record.
    await openSceneVersion(
      admin,
      scene,
      mergeRenderSettings(project.render_settings, scene.render_settings_override),
    );
  }

  const { error: sceneError } = await admin
    .from("scenes")
    .update({ status: "queued", dev: isDev() })
    .in(
      "id",
      pending.map((scene) => scene.id),
    );

  if (sceneError) {
    throw new Error(`Failed to enqueue scenes for project ${projectId}: ${sceneError.message}`);
  }

  // Mostly a cache write, same as the two below and compile.ts's —
  // lib/project-status.ts's deriveProjectStatus() recomputes the real
  // status from `scenes` on every read, which is what lets it reach
  // 'complete' at all (this column never gets a writer for that value — see
  // 0018_derived_project_status.sql). The one value this write DOES matter
  // for is 'delivered': deriveProjectStatus trusts that one directly rather
  // than recomputing it, so if this project had been marked delivered, this
  // unconditional write is what takes it back out — a second, later render
  // batch against a project that already reports "delivered" is exactly the
  // stale-fact bug 0018's column comment warns about.
  const { error: projectError } = await admin
    .from("projects")
    .update({ status: "rendering", updated_at: new Date().toISOString() })
    .eq("id", projectId);

  if (projectError) {
    throw new Error(`Failed to update project status: ${projectError.message}`);
  }

  revalidatePath(renderPath(project.id));
  revalidatePath("/projects");
  redirect(renderPath(project.id));
}

/**
 * Queues only the lowest-`idx` scene — the "Test scene 1 only (saves
 * credits)" control SMN-feature-spec.md § 3.5 names as the product's ONE
 * in-flow cost control: watch one clip land before committing to the rest
 * of an eighteen-scene batch. loadOrderedScenes already sorts by idx
 * ascending, so `scenes[0]` is scene 1 with no separate min() needed.
 *
 * Same guards as enqueueRender, each scoped to that single scene instead of
 * the whole project — reused, not copied, from lib/enqueue-guard.ts. Only
 * writes scenes.status/projects.status; never calls kie.
 */
/**
 * Queue ONE named scene for render, from the scene's own screen.
 *
 * enqueueTestScene next to this does the same work but only ever for
 * scenes[0] — it is the render gate's "try one first" control, not a
 * per-scene action. Without this, a scene that had never rendered had no
 * control of its own anywhere: the workbench said "render to generate" and
 * the only way to do it was the project-wide gate, which renders every
 * scene.
 *
 * Same four guards, same cap ordering, same per-scene effective settings as
 * enqueueTestScene — a single-scene render is still real money and an
 * override set here is still what the worker will bill. Deliberately does
 * NOT redirect: the operator is standing on the scene they just queued and
 * the page they are on is the one that shows it running.
 */
/**
 * Open a new version for a scene that is about to render.
 *
 * A version is one ATTEMPT — the prompt and the frame as they are at this
 * moment, which is exactly the pair the render is about to be billed for.
 * Created on every path that queues a scene (first render, re-render,
 * retry, the batch) so the boundary is always the same event: money being
 * spent. Editing a prompt does not open one; nothing has been bought yet.
 *
 * The clip is deliberately NOT written here — it does not exist yet, and the
 * Go worker is what inserts it. It is resolved at read time from the clip
 * assets that landed inside this version's own window (see
 * lib/scene-versions.ts), which keeps the worker out of this entirely and
 * means a clip cannot be attributed to a version that had already been
 * superseded when it arrived.
 *
 * Best-effort by design: a failure to record the version must not stop a
 * render the operator has already paid the cap check for. The version is
 * bookkeeping; the render is the thing.
 */
export async function openSceneVersion(
  admin: SupabaseClient<Database>,
  scene: Pick<SceneRow, "id" | "video_prompt" | "ref_frame_asset_id" | "duration_s">,
  // The EFFECTIVE settings this render is being submitted with — project
  // defaults already merged with whatever override applies (0059). Passed in
  // rather than merged here because the caller is the only one that knows
  // which override counts: retryScene may be applying a brand-new one that is
  // not on the scene row yet.
  settings: RenderSettings,
): Promise<void> {
  const { data: latest } = await admin
    .from("scene_versions")
    .select("n")
    .eq("scene_id", scene.id)
    .order("n", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: version, error } = await admin
    .from("scene_versions")
    .insert({
      scene_id: scene.id,
      n: (latest?.n ?? 0) + 1,
      video_prompt: scene.video_prompt,
      ref_frame_asset_id: scene.ref_frame_asset_id,
      render_settings: settings,
      duration_s: scene.duration_s,
    })
    .select("id")
    .single();

  if (error || !version) {
    console.error(`Failed to open a version for scene ${scene.id}`, error);
    return;
  }

  const { error: sceneError } = await admin
    .from("scenes")
    .update({ active_version_id: version.id })
    .eq("id", scene.id);

  if (sceneError) {
    console.error(`Failed to point scene ${scene.id} at its new version`, sceneError);
  }
}

/**
 * Re-use the CURRENT version for this render instead of opening a new one.
 *
 * The operator's choice, taken at the moment they press Re-render: keep one
 * row and replace what is in it, or keep both. Neither is right by default —
 * a genuine second attempt at the same idea deserves its own row, and a
 * re-roll of a clip nobody liked deserves not to litter the picker with
 * versions that are all the same idea.
 *
 * Overwriting means the version's snapshot moves to whatever the prompt and
 * frame are NOW (they may have been edited since it was opened) and the clip
 * it produced is deleted — that is the part that is not undoable, and it is
 * why this is a choice rather than a default.
 */
async function reuseSceneVersion(
  admin: SupabaseClient<Database>,
  scene: Pick<
    SceneRow,
    "id" | "video_prompt" | "ref_frame_asset_id" | "duration_s" | "active_version_id"
  >,
  settings: RenderSettings,
): Promise<void> {
  if (!scene.active_version_id) {
    // Nothing to re-use — a scene that has never rendered since 0058. Open
    // one instead, so the render is still recorded.
    await openSceneVersion(admin, scene, settings);
    return;
  }

  const { data: version } = await admin
    .from("scene_versions")
    .select("clip_asset_id")
    .eq("id", scene.active_version_id)
    .maybeSingle();

  if (version?.clip_asset_id) {
    await admin.from("assets").delete().eq("id", version.clip_asset_id);
  }

  // The settings snapshot is REFRESHED, not preserved (0059). This row is
  // about to describe a clip that does not exist yet, rendered now, with the
  // settings in force now — the old clip has just been deleted above. Keeping
  // the previous snapshot would leave the version claiming a model and length
  // that produced nothing that still exists, which is the same lie 0059
  // exists to stop, only pointing backwards. "Update this version" means the
  // whole row moves to the current attempt: prompt, frame, settings, length.
  const { error } = await admin
    .from("scene_versions")
    .update({
      video_prompt: scene.video_prompt,
      ref_frame_asset_id: scene.ref_frame_asset_id,
      clip_asset_id: null,
      render_settings: settings,
      duration_s: scene.duration_s,
    })
    .eq("id", scene.active_version_id);

  if (error) {
    console.error(`Failed to re-use version for scene ${scene.id}`, error);
  }
}

export async function enqueueScene(sceneId: string): Promise<ActionResult> {
  const { scene, project, user, profile } = await requireScene(sceneId);

  const settings = mergeRenderSettings(project.render_settings, scene.render_settings_override);
  const model = getModel(settings.model);
  const audioEnabled = isAudioEnabled();
  const unavailableResult = unavailableModelResult(settings);
  if (unavailableResult) return unavailableResult;

  const framedResult = guardResult(() => assertAllFramed([scene]));
  if (framedResult) return framedResult;
  const spentResult = guardResult(() => assertNotAlreadySpent([scene]));
  if (spentResult) return spentResult;
  const durationsResult = guardResult(() =>
    assertRenderableDurations([scene], settings, audioEnabled),
  );
  if (durationsResult) return durationsResult;
  const settingsResult = guardResult(() =>
    assertSettingsAllowedForDurations([scene], model, settings),
  );
  if (settingsResult) return settingsResult;

  const pricedScene = await withSceneVideoReferenceDurations(scene);
  const estimate = estimateCost(toBrief([pricedScene]), audioEnabled, settings);
  const capResult = await assertWithinSpendCaps(user.id, profile, estimate.totalUsd);
  if (capResult) return capResult;

  const admin = createAdminClient();

  await openSceneVersion(admin, scene, settings);

  const { error: sceneError } = await admin
    .from("scenes")
    .update({ status: "queued", dev: isDev() })
    .eq("id", scene.id);

  if (sceneError) {
    throw new Error(`Failed to enqueue scene ${scene.id}: ${sceneError.message}`);
  }

  const { error: projectError } = await admin
    .from("projects")
    .update({ status: "rendering", updated_at: new Date().toISOString() })
    .eq("id", project.id);

  if (projectError) {
    throw new Error(`Failed to update project status: ${projectError.message}`);
  }

  revalidatePath(renderPath(project.id));
  revalidatePath(`/projects/${project.id}/scenes/${scene.id}`);
  revalidatePath("/projects");
  return undefined;
}

export async function enqueueTestScene(projectId: string): Promise<ActionResult> {
  const { project, user, profile } = await requireProject(projectId);

  const scenes = await loadOrderedScenes(projectId);
  if (scenes.length === 0) {
    return { error: `Project ${projectId} has no scenes to render.` };
  }

  // loadOrderedScenes sorts by idx ascending and the length check above
  // already ruled out an empty array — this is just satisfying
  // noUncheckedIndexedAccess, not a real possibility.
  const scene = scenes[0];
  if (!scene) {
    return { error: `Project ${projectId} has no scenes to render.` };
  }

  // This scene's own effective settings, not the project's raw blob: scene 1
  // can carry a render_settings_override from an earlier retry (0045 — it is
  // sticky and survives an unfreeze back to 'draft'), and validating or
  // pricing it against the project's model would be checking a model it
  // isn't going to render on.
  const settings = mergeRenderSettings(project.render_settings, scene.render_settings_override);
  const model = getModel(settings.model);
  const audioEnabled = isAudioEnabled();

  const framedResult = guardResult(() => assertAllFramed([scene]));
  if (framedResult) return framedResult;
  const spentResult = guardResult(() => assertNotAlreadySpent([scene]));
  if (spentResult) return spentResult;
  const durationsResult = guardResult(() =>
    assertRenderableDurations([scene], settings, audioEnabled),
  );
  if (durationsResult) return durationsResult;
  const settingsResult = guardResult(() =>
    assertSettingsAllowedForDurations([scene], model, settings),
  );
  if (settingsResult) return settingsResult;

  // Same estimateCost() the batch uses, not a flat priceForSecond() call —
  // scene 1 might be the talking-head scene that bills at Kling's rate, and
  // the daily-cap check (and the price the gate quoted) has to agree with
  // what the worker will actually charge.
  const estimate = estimateCost(toBrief([scene]), audioEnabled, settings);
  // Same ordering and reasoning as enqueueRender: global, then weekly, then
  // daily-burst — see assertWithinSpendCaps' doc comment (lib/spend.ts).
  const capResult = await assertWithinSpendCaps(user.id, profile, estimate.totalUsd);
  if (capResult) return capResult;

  const admin = createAdminClient();

  await openSceneVersion(admin, scene, settings);

  const { error: sceneError } = await admin
    .from("scenes")
    .update({ status: "queued", dev: isDev() })
    .eq("id", scene.id);

  if (sceneError) {
    throw new Error(`Failed to enqueue test scene for project ${projectId}: ${sceneError.message}`);
  }

  const { error: projectError } = await admin
    .from("projects")
    .update({ status: "rendering", updated_at: new Date().toISOString() })
    .eq("id", projectId);

  if (projectError) {
    throw new Error(`Failed to update project status: ${projectError.message}`);
  }

  revalidatePath(renderPath(project.id));
  revalidatePath("/projects");
  redirect(renderPath(project.id));
}

export type ScenePollStatus = Pick<SceneRow, "id" | "status" | "submitted_at"> & {
  /**
   * Classified reason for the newest `runs` row carrying an error for this
   * scene — see lib/render-error.ts. Only ever populated when status is
   * 'failed' (a scene that has since succeeded on a later run row shouldn't
   * drag an old failure's message back onto a 'done'/'rendering' tile).
   * `null` covers both "no error row exists yet" (a race between the
   * scene flipping to 'failed' and its `runs` insert landing) and "this
   * scene isn't failed" — the render/watch UI treats both the same way,
   * rendering the tile without a reason line.
   */
  error: RenderErrorInfo | null;
};

/**
 * Lightweight scene-status snapshot for render-progress.tsx's polling
 * fallback AND its Realtime handler's failed-transition refresh (see that
 * component's file header). Its primary source of truth is a Supabase
 * Realtime subscription (`scenes:${projectId}`, postgres_changes UPDATE) —
 * but on a flaky mobile connection (carrier firewall, captive portal, a
 * socket that drops without visibly erroring) that channel can go quiet
 * while a render keeps running, and running up a bill, in the background.
 * This is what that screen polls instead, and only while its channel isn't
 * SUBSCRIBED — see that component's `connectionStatus`/`usingFallback`.
 * Realtime's own `scenes` payload never carries `runs.error` (the worker
 * never writes it to `scenes`), so the moment a scene transitions to
 * 'failed' this function is also called once, directly, so the failure
 * reason arrives live instead of only after a manual reload.
 *
 * Returns id/status/submitted_at plus the newest classified error per
 * scene, not full scene rows: idx, is_talking_head, and duration_s are set
 * once at scene creation and never touched again — only the Go worker's
 * claim/mark-done/mark-failed writes touch status/kie_task_id/
 * submitted_at/runs, the same fact render-progress.tsx's Realtime handler
 * already relies on — so there is nothing else worth re-fetching here.
 *
 * One query per table, not one query per scene: `runs` is fetched once for
 * the whole project (`project_id = X`, `error is not null`, newest first)
 * via runs.project_id (0030_runs_project_id.sql), then reduced to the
 * newest row per scene_id in TypeScript by
 * lib/render-error.ts's latestErrorsByScene — never a per-scene query, and
 * no new database view.
 *
 * No ActionResult here: unlike the guard failures elsewhere in this file, a
 * failed poll isn't something the operator can act on (it'll just retry on
 * the next tick), so this follows hasFinalAsset's (actions/deliver.ts)
 * plain-return, throw-on-failure shape instead.
 */
export async function getSceneStatuses(projectId: string): Promise<ScenePollStatus[]> {
  await requireProject(projectId);
  const supabase = await createClient();

  const [scenesResult, runsResult] = await Promise.all([
    supabase.from("scenes").select("id, status, submitted_at").eq("project_id", projectId),
    supabase
      .from("runs")
      .select("scene_id, error, created_at")
      .eq("project_id", projectId)
      .not("error", "is", null)
      .order("created_at", { ascending: false }),
  ]);

  if (scenesResult.error) {
    throw new Error(
      `Failed to poll scene statuses for project ${projectId}: ${scenesResult.error.message}`,
    );
  }
  if (runsResult.error) {
    throw new Error(
      `Failed to load run errors for project ${projectId}: ${runsResult.error.message}`,
    );
  }

  const errorsByScene = latestErrorsByScene(runsResult.data ?? []);

  return (scenesResult.data ?? []).map((scene) => ({
    id: scene.id,
    status: scene.status,
    submitted_at: scene.submitted_at,
    error: scene.status === "failed" ? (errorsByScene.get(scene.id) ?? null) : null,
  }));
}

/**
 * THE FINAL CUT IS NOT DELETED ANY MORE — read this before "restoring" a
 * cleanup that looks missing below.
 *
 * Until 0060_final_versions.sql, deleteStaleFinalAssets lived here and every
 * retry, unfreeze and re-render called it: it deleted the project's `final`
 * asset row and the project-level `poster` beside it, so that a scene going
 * back into flight could not leave an mp4 on the Deliver page that no longer
 * contained what it claimed to. That deletion was also the trigger — the
 * worker's ProjectsReadyToAssemble armed re-assembly solely on the ABSENCE
 * of a `final` row — so the cleanup and the rebuild request were the same
 * gesture.
 *
 * Under versioning both halves are wrong:
 *
 *   - The request is now a row, not an absence. A final version with
 *     `built_at is null` is what the assemble loop claims, so nothing has to
 *     be destroyed to ask for a rebuild (reassembleProject,
 *     actions/deliver.ts).
 *   - The cut is a record, not a cache. A final version says "this is what
 *     was built, from these scenes at these versions" — and that stays TRUE
 *     after a scene is re-rendered. Deleting it would destroy an accurate
 *     record of something that really happened, and take a 10-30MB artifact
 *     the operator paid for with it, to avoid a claim it was never making.
 *
 * What replaced it is a signal rather than a deletion: getCutStatus
 * (actions/deliver.ts) compares the active version's RECIPE — the scenes and
 * scene versions it was built from — against the project's scenes as they
 * stand now, and reports `stale` with `reason: "recipe"` when they differ. A
 * re-rendered scene moves onto a new scene version, so the recipe stops
 * matching the moment this file re-queues anything, and the Deliver page
 * says so and offers the rebuild. The failure the old deletion prevented —
 * an operator downloading a cut that silently predates the fix — is still
 * prevented; the difference is that it is now prevented by telling them,
 * which is reversible, instead of by destroying the file, which is not.
 *
 * The one thing that is genuinely LOST: a stale cut is still downloadable
 * while it is flagged. That is the deliberate trade — see this comment's
 * cross-reference from each call site below.
 */

/**
 * Resets a single failed scene back to 'queued' so the worker's dispatch
 * loop picks it up again. Deliberately per-scene, not per-project — one bad
 * clip costs ~$0.80 to fix, not the whole ~$19 batch (architecture.md
 * § "User flow"). Only writes status/kie_task_id/submitted_at and the
 * asset cleanup below; never calls kie.
 *
 * Re-reads render_settings and checks the daily cap before re-queuing, same
 * shape as enqueueRender/enqueueTestScene/rerenderScene: a retry submits a
 * real paid job to kie, so it needs the same guard the other three spend
 * paths in this file already have (AGENTS.md § retries are where the
 * budget actually goes).
 *
 * `modelId` (optional) re-renders this scene on a DIFFERENT model than the
 * project's, by writing that model as this scene's
 * scenes.render_settings_override (0045_scene_render_settings_override.sql)
 * in the same statement that re-queues it. Omitted, nothing about the
 * scene's model changes — including any override a previous retry left on
 * it, which is deliberate: 0045's overrides are sticky and only an explicit
 * write replaces one.
 *
 * The same parameter exists on retryAllFailed, not just there: one scene is
 * a degenerate bulk retry, and an operator who can move three failed scenes
 * to a cheaper model but not one is a gap that only gets discovered in
 * production. Both price the retry at the OVERRIDDEN model before the cap
 * check — pricing at the project's model while rendering on another is a
 * straight spend-cap bypass (0045's header).
 *
 * Also writes `projects.status = 'rendering'` unconditionally, same cache
 * write enqueueRender/rerenderScene already make — this is what clears a
 * stale 'delivered': a project that was marked delivered must not keep
 * reporting that status once one of its scenes is back in flight and the
 * assembled cut it was delivered as has gone stale. Harmless on a project that was never
 * delivered — the value is recomputed from `scenes` on every read anyway
 * (deriveProjectStatus, lib/project-status.ts), so this is only ever
 * actually load-bearing for the delivered case.
 *
 * `versionMode` (optional, default "new") is /ugc's own addition
 * (actions/ugc.ts's regenerateClip) — once Regenerate became the only
 * requeue control on that route (its own "Try again" removed), a FAILED
 * scene needed the same new-vs-update choice a DONE one already gets from
 * rerenderScene's own versionMode. "update" reuses the failed attempt's own
 * version row via reuseSceneVersion — there is no clip on it to lose, only
 * its snapshot moves to the settings this requeue is about to submit — and
 * "new" (the default, and the only thing every OTHER caller of this
 * function has ever asked for) opens another, leaving the failed row as
 * history. Every other caller (scene-rerender-dialog.tsx's built-in "retry"
 * kind, scene-workbench.tsx) omits it and keeps opening a new version,
 * exactly as before.
 */
export async function retryScene(
  sceneId: string,
  modelId?: string,
  versionMode: "new" | "update" = "new",
): Promise<ActionResult> {
  const { scene, project, user, profile } = await requireScene(sceneId);

  if (scene.status !== "failed") {
    return {
      error:
        `Scene ${sceneId} is "${scene.status}", not "failed" — retryScene only applies to ` +
        "scenes that have already failed a render attempt.",
    };
  }

  const overrideResult = resolveOverride(modelId, project.render_settings);
  if ("error" in overrideResult) return overrideResult;
  const { override } = overrideResult;

  // The settings this retry will ACTUALLY render on: the new override when
  // one was picked, otherwise whatever this scene already carries. Never the
  // project's raw blob — pricing an overridden scene at the project's model
  // is the spend-cap bypass 0045's header describes, and it is the same hole
  // whether the override arrived on this call or on a previous one.
  const settings = mergeRenderSettings(
    project.render_settings,
    override ?? scene.render_settings_override,
  );
  const unavailableResult = unavailableModelResult(settings);
  if (unavailableResult) return unavailableResult;

  const pricedScene = await withSceneVideoReferenceDurations(scene);
  const estimatedUsd = estimateCost(toBrief([pricedScene]), isAudioEnabled(), settings).totalUsd;
  // Same ordering and reasoning as enqueueRender: global, then weekly, then
  // daily-burst — see assertWithinSpendCaps' doc comment (lib/spend.ts).
  const capResult = await assertWithinSpendCaps(user.id, profile, estimatedUsd);
  if (capResult) return capResult;

  const admin = createAdminClient();

  // No final-asset cleanup here on purpose — see "THE FINAL CUT IS NOT
  // DELETED ANY MORE" above. The project's assembled cut stays, and
  // getCutStatus flags it stale once this retry moves the scene onto a new
  // version.

  // A retry is a fresh attempt and gets its own version, same as any other
  // path that queues a scene — it is billed like one. "update" (see this
  // function's own doc comment) reuses the failed attempt's row instead.
  if (versionMode === "update") {
    await reuseSceneVersion(admin, scene, settings);
  } else {
    await openSceneVersion(admin, scene, settings);
  }

  const { error } = await admin
    .from("scenes")
    .update({
      status: "queued",
      dev: isDev(),
      kie_task_id: null,
      submitted_at: null,
      // Written in the SAME statement that re-queues the scene, not a
      // separate one before it: the worker's claim query is what reads this
      // (ClaimQueuedScenes merges it in SQL), and it only looks at scenes
      // that are already 'queued'. Splitting the two writes would open a
      // window where the scene is claimable at the OLD model. Only written
      // when an override was actually requested — a plain retry must leave
      // the column exactly as it found it (0045: sticky, nothing clears it
      // implicitly, including a retry that says nothing about the model).
      ...(override ? { render_settings_override: override } : {}),
    })
    .eq("id", sceneId);

  if (error) {
    throw new Error(`Failed to retry scene ${sceneId}: ${error.message}`);
  }

  // See this function's doc comment for why this also clears a stale
  // 'delivered'.
  const { error: projectError } = await admin
    .from("projects")
    .update({ status: "rendering", updated_at: new Date().toISOString() })
    .eq("id", project.id);

  if (projectError) {
    throw new Error(`Failed to update project status: ${projectError.message}`);
  }

  revalidatePath(renderPath(project.id));
}

/**
 * Same as retryScene, applied to every failed scene in a project at once.
 * Still one write per scene under the hood via a single filtered update —
 * no kie calls, no change to scenes that aren't 'failed'.
 *
 * Priced and cap-checked on the whole failed set in one shot, not once per
 * scene: this queues all of them in the same batch, so the cap has to see
 * the batch's total, exactly like enqueueRender prices `pending` rather
 * than checking each scene in isolation. Returns ActionResult (not void)
 * for the same reason retryScene does — a cap refusal is something the
 * operator can act on, so it must come back as data, not a thrown/redacted
 * error (see lib/action-result.ts).
 *
 * Also writes `projects.status = 'rendering'` unconditionally, same as
 * retryScene — see that function's doc comment for why this is what clears
 * a stale 'delivered' rather than leaving it pointing at an assembled cut a
 * scene has just moved out from under.
 *
 * `modelId` (optional) is the point of 0045: re-render this project's failed
 * scenes on a different model than the project's own, without repointing the
 * scenes that already rendered correctly and are already paid for. It is
 * written as a per-scene render_settings_override onto exactly the scenes
 * this call re-queues, in the same statement, and the batch is priced at
 * that model before the cap check. Omitted, every failed scene keeps
 * whatever settings it already had — which, for a scene retried onto another
 * model earlier, is that model (0045: sticky), so the estimate is taken per
 * effective-settings group rather than assuming the project's.
 */
export async function retryAllFailed(projectId: string, modelId?: string): Promise<ActionResult> {
  const { project, user, profile } = await requireProject(projectId);

  const scenes = await loadOrderedScenes(projectId);
  const failed = scenes.filter((scene) => scene.status === "failed");
  if (failed.length === 0) {
    // Nothing to do.
    return { error: `Project ${projectId} has no failed scenes to retry.` };
  }

  const overrideResult = resolveOverride(modelId, project.render_settings);
  if ("error" in overrideResult) return overrideResult;
  const { override } = overrideResult;

  // A plain bulk retry preserves each scene's sticky override, so check
  // every effective setting before either pricing or writing. A newly
  // supplied override is one shared effective setting for the whole batch.
  const effectiveSettings = override
    ? [mergeRenderSettings(project.render_settings, override)]
    : groupByEffectiveSettings(failed, project.render_settings).map((group) => group.settings);
  for (const settings of effectiveSettings) {
    const unavailableResult = unavailableModelResult(settings);
    if (unavailableResult) return unavailableResult;
  }

  // Priced at what these scenes will actually render on. With an override,
  // that is one model for the whole set, so the merge is applied uniformly;
  // without one, each scene keeps whatever it already carries and the set
  // may genuinely be mixed — hence the grouped estimate rather than a single
  // estimateCost() call. Getting this wrong in either direction is a real
  // cap bypass: see 0045's header and estimateUsdForScenes above.
  const pricedFailed = await withScenesVideoReferenceDurations(failed);
  let estimatedUsd: number;
  if (override) {
    const overriddenSettings = mergeRenderSettings(project.render_settings, override);
    estimatedUsd = estimateCost(
      toBrief(pricedFailed),
      isAudioEnabled(),
      overriddenSettings,
    ).totalUsd;
  } else {
    // No override: each scene keeps whatever it already carries, which may
    // genuinely be a mixed set of models (0045) — hence the grouped
    // estimate, same reasoning as enqueueRender's own
    // groupByEffectiveSettings/estimateUsdForScenes pair.
    estimatedUsd = estimateUsdForScenes(pricedFailed, isAudioEnabled(), project.render_settings);
  }
  // Same ordering and reasoning as enqueueRender: global, then weekly, then
  // daily-burst — see assertWithinSpendCaps' doc comment (lib/spend.ts).
  const capResult = await assertWithinSpendCaps(user.id, profile, estimatedUsd);
  if (capResult) return capResult;

  const admin = createAdminClient();

  // No final-asset cleanup here either — see "THE FINAL CUT IS NOT DELETED
  // ANY MORE" above.

  const { error } = await admin
    .from("scenes")
    .update({
      status: "queued",
      dev: isDev(),
      kie_task_id: null,
      submitted_at: null,
      // Same statement as the re-queue, same reason as retryScene's: the
      // worker claims on status='queued' and reads this column in that same
      // claim, so the override must land no later than the status does. The
      // filter below is unchanged (`status = 'failed'`), so this writes the
      // override onto exactly the scenes being re-queued and nothing else.
      ...(override ? { render_settings_override: override } : {}),
    })
    .eq("project_id", projectId)
    .eq("status", "failed");

  if (error) {
    throw new Error(`Failed to retry failed scenes for project ${projectId}: ${error.message}`);
  }

  // See retryScene's doc comment for why this also clears a stale 'delivered'.
  const { error: projectError } = await admin
    .from("projects")
    .update({ status: "rendering", updated_at: new Date().toISOString() })
    .eq("id", project.id);

  if (projectError) {
    throw new Error(`Failed to update project status: ${projectError.message}`);
  }

  revalidatePath(renderPath(project.id));
}

/**
 * Re-renders one already-`done` scene — the selective-regeneration path
 * SMN-feature-spec.md § 3.7 calls THE recovery when a clip's framing or
 * expression comes out wrong, as distinct from retryScene's job (a scene
 * that already failed a render attempt). Re-reads render_settings and the
 * daily cap the same way enqueueRender does, for the same reason: the price
 * shown on the scene's card must be the price actually checked against the
 * cap, not whatever the client last rendered.
 *
 * Two cleanups happen before the scene is re-queued, both required by how
 * the worker writes data, not by preference:
 *
 * - The scene's existing 'clip' AND 'poster' assets are deleted first.
 *   assets has no unique constraint on (scene_id, kind)
 *   (supabase/migrations/0001_init.sql § "assets"), and both store.MarkDone
 *   (the clip) and store.InsertAsset (the best-effort poster,
 *   worker/internal/ingest's extractAndStorePoster, migration
 *   0022_asset_poster_kind.sql) do a plain INSERT with no ON CONFLICT — so
 *   leaving either old row in place would leave two rows for this scene
 *   once the new render lands. SceneClipsForProject has no dedup on
 *   scene_id, so both clips would be downloaded and concatenated into the
 *   final video; deliver/page.tsx's posterAssetByScene lookup has no
 *   ordering guarantee either, so a stale poster row could keep showing the
 *   old clip's frame after the new one renders.
 * - The project's existing 'final' asset and ITS poster, by contrast,
 *   are NOT deleted any more (0060_final_versions.sql) — see "THE FINAL CUT
 *   IS NOT DELETED ANY MORE" above for why the deletion that used to happen
 *   here would now destroy a true record, and what flags the superseded cut
 *   instead.
 *
 * Only writes status and asset rows; never calls kie.
 */
export async function rerenderScene(
  sceneId: string,
  /**
   * "new" opens another version and keeps the current clip alongside it;
   * "update" replaces this version's clip in place. Defaults to "new" — the
   * non-destructive one, so a caller that says nothing cannot lose a clip.
   */
  versionMode: "new" | "update" = "new",
): Promise<ActionResult> {
  const { scene, project, user, profile } = await requireScene(sceneId);

  const rerenderableResult = guardResult(() => assertSceneRerenderable(scene.status));
  if (rerenderableResult) return rerenderableResult;

  // Re-read rather than trust the price the UI showed on click, for the same
  // reason enqueueRender does: the render gate's settings can change between
  // page load and click, and the only price allowed to reach the daily-cap
  // check is the one actually persisted on the project.
  // Merged with this scene's own override (0045) rather than read straight
  // off the project: a scene that was previously retried onto a different
  // model still renders on that model, so this is the model the price and
  // the duration guard below both have to use.
  const settings = mergeRenderSettings(project.render_settings, scene.render_settings_override);
  const unavailableResult = unavailableModelResult(settings);
  if (unavailableResult) return unavailableResult;
  const audioEnabled = isAudioEnabled();

  // No project-wide `model` variable here — assertRenderableDurations
  // resolves the model per scene (lib/models.ts's pickModel), and this
  // action only ever validates the one scene it's re-rendering.
  const durationsResult = guardResult(() =>
    assertRenderableDurations([scene], settings, audioEnabled),
  );
  if (durationsResult) return durationsResult;

  // estimateCost, not a flat priceForSecond() — the same reason
  // enqueueTestScene uses it. A talking-head scene is billed on the
  // lip-synced route, which costs several times the silent rate, so the
  // flat rate that used to be here under-quoted exactly the scenes that
  // cost the most. It happens to agree today only because AUDIO_ENABLED is
  // off and every scene routes silent; the moment audio is switched on,
  // this button would have quoted a price it does not charge.
  const pricedScene = await withSceneVideoReferenceDurations(scene);
  const estimatedUsd = estimateCost(toBrief([pricedScene]), audioEnabled, settings).totalUsd;
  // Same ordering and reasoning as enqueueRender: global, then weekly, then
  // daily-burst — see assertWithinSpendCaps' doc comment (lib/spend.ts).
  const capResult = await assertWithinSpendCaps(user.id, profile, estimatedUsd);
  if (capResult) return capResult;

  const admin = createAdminClient();

  // The old clip is NOT deleted any more (0058_scene_versions.sql). It
  // belongs to the version that paid for it, and the whole point of versions
  // is that a $1.89 clip stops disappearing the moment someone decides to
  // try again. The scene's own clip reads take the newest asset, so the
  // superseded one simply stops being shown.
  //
  // The project's assembled final does NOT go either, as of
  // 0060_final_versions.sql — see "THE FINAL CUT IS NOT DELETED ANY MORE"
  // above. It was built from the clip about to be superseded, which is
  // exactly what its recipe records; getCutStatus reports it stale rather
  // than this deleting it.

  if (versionMode === "update") {
    await reuseSceneVersion(admin, scene, settings);
  } else {
    await openSceneVersion(admin, scene, settings);
  }

  const { error: sceneError } = await admin
    .from("scenes")
    .update({ status: "queued", dev: isDev(), kie_task_id: null, submitted_at: null })
    .eq("id", sceneId);

  if (sceneError) {
    throw new Error(`Failed to re-render scene ${sceneId}: ${sceneError.message}`);
  }

  const { error: projectError } = await admin
    .from("projects")
    .update({ status: "rendering", updated_at: new Date().toISOString() })
    .eq("id", project.id);

  if (projectError) {
    throw new Error(`Failed to update project status: ${projectError.message}`);
  }

  revalidatePath(renderPath(project.id));
}
