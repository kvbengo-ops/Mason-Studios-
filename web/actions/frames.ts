"use server";

// Gate 2 — the reference-frame review screen (docs/architecture.md §
// "User flow", step 6: "REVIEW FRAMES — operator regenerates bad ones —
// GATE — $0.02 each"). A wrong reference frame guarantees a wrong clip, and
// the clip it seeds costs ~40x what the frame does, so making regeneration
// cheap and one-click is the whole point of this gate.
//
// Same shape as actions/brief.ts: guard first (requireScene/requireProject
// — never skip this), refuse if the scene has moved past draft/frame_ready
// (money is committed beyond that point), then write via
// createAdminClient().

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireScene, requireProject } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { generateImage, modelForImageArgs, ImageGenerationError } from "@/lib/kie";
import { classifyRenderError } from "@/lib/render-error";
import { uploadFromUrl, signedUrl } from "@/lib/storage";
import { runWithConcurrency } from "@/lib/concurrency";
import { guardResult, type ActionResult } from "@/lib/action-result";
import { isSceneContentEditable } from "@/lib/editable-guard";
import { refImageUrlsForScene, type ConditioningRefs } from "@/lib/reference-selection";
import { estimatedRefFrameCostUsd } from "@/lib/models";
import { assertWithinSpendCaps } from "@/lib/spend";
import { recordRun, failedRunFields } from "@/lib/runs";
import type { Database } from "@/types/db";

// This file, and actions/character.ts, were the two holdouts left throwing
// when the rest of the app moved onto lib/action-result.ts's pattern. The
// rule: if a human can act on the message, return it as an ActionResult; if
// it only means something broke, keep throwing and let production redact it
// (React error #441) — a raw Postgres/Storage/vendor failure belongs in a
// server log, not leaked to someone who can't do anything about it.

type SceneRow = Database["public"]["Tables"]["scenes"]["Row"];

/**
 * The SHARED list, not a fourth private copy.
 *
 * This file kept its own `["draft", "frame_ready"]` while
 * lib/editable-guard.ts widened to include rendered scenes — so switching a
 * scene back to an earlier version, and regenerating a frame on a finished
 * scene, were both refused by this guard with a message about money being
 * committed, on the one screen that now offers those buttons. The rule has
 * one home; this reads it.
 */
// Content edits, not the money boundary — see isSceneContentEditable.

/** How many `generateImage` calls run at once — see docs/architecture.md § "Cost model". */
const FRAME_CONCURRENCY = 4;

// Stays a plain throwing function, like the `assert*` guards in
// lib/enqueue-guard.ts — it's converted to an ActionResult at each Server
// Action boundary below via guardResult, not here, so this remains a
// simple unit-testable predicate.
function assertEditable(scene: Pick<SceneRow, "id" | "status">): void {
  if (!isSceneContentEditable(scene.status)) {
    throw new Error(
      `Scene ${scene.id} is "${scene.status}" — while a render is queued or running the ` +
        "worker owns this scene and its prompt and frame cannot change. It unlocks when the " +
        "clip lands or the render fails.",
    );
  }
}

function framesPath(projectId: string): string {
  return `/projects/${projectId}/frames`;
}

/**
 * Signed URLs for the project's character, product, and character-with-
 * product composite reference assets. Which of these actually feeds a
 * given scene's `generateImage` call is decided per scene by
 * refImageUrlsForScene (lib/reference-selection.ts), not here — this just
 * loads everything that might be needed once per batch instead of once
 * per scene.
 *
 * character_ref/composite_ref: most-recently-uploaded row of the kind —
 * neither has grown a grid or a primary designation, only product_ref has
 * (see 0023_asset_position.sql), so this half is unchanged from before that
 * migration's application-code companion.
 *
 * product_ref: the PRIMARY photo (position 0), not "most recently
 * uploaded." With a grid of product photos now allowed, an operator can
 * add a second or third angle after already picking a primary via
 * setPrimaryProductRef (actions/character.ts) — reading "most recent" here
 * would silently condition every scene's generation on whichever photo was
 * added last, ignoring what the operator actually designated. Same fix,
 * same reasoning, as regenerateComposite's identical change
 * (actions/character.ts).
 */
async function loadConditioningRefs(
  admin: SupabaseClient<Database>,
  projectId: string,
): Promise<ConditioningRefs> {
  const [{ data, error }, { data: primaryProduct, error: primaryProductError }] = await Promise.all(
    [
      admin
        .from("assets")
        .select("kind, storage_key, created_at")
        .eq("project_id", projectId)
        .in("kind", ["character_ref", "composite_ref"])
        .order("created_at", { ascending: false }),
      admin
        .from("assets")
        .select("storage_key")
        .eq("project_id", projectId)
        .eq("kind", "product_ref")
        .eq("position", 0)
        .maybeSingle(),
    ],
  );

  if (error) {
    throw new Error(`Failed to load reference assets for project ${projectId}: ${error.message}`);
  }
  if (primaryProductError) {
    throw new Error(
      `Failed to load primary product reference for project ${projectId}: ${primaryProductError.message}`,
    );
  }

  const latestKeyByKind = new Map<string, string>();
  for (const row of data ?? []) {
    if (!latestKeyByKind.has(row.kind)) {
      latestKeyByKind.set(row.kind, row.storage_key);
    }
  }

  async function urlFor(kind: "character_ref" | "composite_ref"): Promise<string | null> {
    const key = latestKeyByKind.get(kind);
    // No transform here, deliberately: this URL feeds generateImage's refImageUrls
    // (generateSceneFrame below), not a <img> tag. A downscaled, lossily
    // recompressed reference would silently degrade every scene generated
    // from it — this must stay full-fidelity, unlike the same storage_key's
    // display-only reads elsewhere (e.g. character/page.tsx).
    return key ? signedUrl(key) : null;
  }

  const [characterUrl, compositeUrl, productUrl] = await Promise.all([
    urlFor("character_ref"),
    urlFor("composite_ref"),
    // Same no-transform reasoning as urlFor above — this is the image vendor's
    // conditioning input, not a thumbnail.
    primaryProduct ? signedUrl(primaryProduct.storage_key) : Promise.resolve(null),
  ]);

  return { characterUrl, productUrl, compositeUrl };
}

/**
 * Generates one scene's reference frame, uploads it, records the `assets`
 * row, and points the scene at it. Shared by `generateFrames` and
 * `updateScenePromptAndRegenerate` — the only difference between them is
 * what happens before this runs.
 */
async function generateSceneFrame(
  admin: SupabaseClient<Database>,
  projectId: string,
  scene: Pick<SceneRow, "id" | "video_prompt">,
  refImageUrls: string[],
): Promise<void> {
  // Stays a throw, not a returned ActionResult: this helper is shared by
  // generateFrames' batch path, where runWithConcurrency already catches
  // it and hands the message back as data in `failed[]` (never crosses the
  // Server Action boundary, so nothing here gets redacted). The two
  // single-scene callers below guard against an empty prompt themselves
  // before reaching this point, so for them this throw is an unreachable
  // backstop, not the normal path.
  const prompt = scene.video_prompt?.trim();
  if (!prompt) {
    throw new Error(`Scene ${scene.id} has no video prompt to generate a reference frame from.`);
  }

  // Cap checks happen at the Server Action boundary (generateFrames prices
  // the whole batch it's about to submit; updateScenePromptAndRegenerate
  // prices its one frame) — not here, since this helper has no user/role to
  // check a cap against and is called at whatever concurrency
  // FRAME_CONCURRENCY allows, which a per-call check here couldn't usefully
  // serialize anyway.
  const model = modelForImageArgs({ prompt, refImageUrls });
  let url: string;
  let costUsd: number | null;
  try {
    ({ url, costUsd } = await generateImage({ prompt, refImageUrls }));
  } catch (err) {
    // Record the attempt even though it failed. failedRunFields owns the one
    // distinction that moves money: a poll-budget timeout means kie is STILL
    // DRAWING and will still bill, so it keeps the task id and HOLDS the
    // estimate. Everything else keeps costUsd null rather than a guess, because
    // generateImage cannot tell a pre-generation rejection apart from a
    // billed-and-lost failure, so this codebase doesn't assert one either.
    await recordRun({
      projectId,
      sceneId: scene.id,
      vendor: "kie",
      model,
      ...failedRunFields(err, estimatedRefFrameCostUsd()),
    });
    throw err;
  }

  const { storageKey } = await uploadFromUrl({
    url,
    projectId,
    kind: "ref_frame",
    sceneId: scene.id,
  });

  const { data: asset, error: assetError } = await admin
    .from("assets")
    .insert({
      project_id: projectId,
      scene_id: scene.id,
      kind: "ref_frame",
      storage_key: storageKey,
    })
    .select()
    .single();

  if (assetError || !asset) {
    throw new Error(
      `Failed to record reference frame asset for scene ${scene.id}: ${assetError?.message ?? "unknown error"}`,
    );
  }

  const { error: sceneError } = await admin
    .from("scenes")
    .update({ ref_frame_asset_id: asset.id, status: "frame_ready" })
    .eq("id", scene.id);

  if (sceneError) {
    throw new Error(`Failed to link reference frame to scene ${scene.id}: ${sceneError.message}`);
  }

  // costUsd is the vendor-reported actual whenever the call returned one
  // non-null on every successful call — kie's response always carries a
  // billing figure. See
  // GenerateImageResult.costUsd's doc comment (lib/kie.ts).
  await recordRun({
    projectId,
    sceneId: scene.id,
    vendor: "kie",
    model,
    costUsd: costUsd ?? estimatedRefFrameCostUsd(),
  });
}

export interface GenerateFramesResult {
  succeeded: string[];
  failed: { sceneId: string; error: string }[];
}

/**
 * Generates a reference frame for every scene in the project that doesn't
 * have one yet, at bounded concurrency (see `runWithConcurrency`). Tolerant
 * of partial failure: a scene whose generation throws is reported in
 * `failed` and left without a frame rather than aborting the whole batch —
 * an operator can retry just that one scene from the grid.
 *
 * `GenerateFramesResult` is this action's own ActionResult shape rather
 * than lib/action-result.ts's `{ error }` — per-scene failure is already
 * returned as data (`failed[].error`, built from `result.reason.message`
 * below), never thrown across the Server Action boundary, so it was never
 * subject to the #441 redaction this task exists to fix. `succeeded`/
 * `failed` is a superset of `{ error }`, not a competing shape.
 */
/**
 * Switch a scene to one of its earlier versions.
 *
 * A version is the triple — prompt, frame, and the clip rendered from them
 * (0058_scene_versions.sql) — so this restores all three at once. The prompt
 * and frame are copied back onto `scenes`, because those two columns are
 * what the compiler and the Go worker actually read; active_version_id alone
 * would change the label and nothing else. The clip is not copied anywhere:
 * it is resolved from the version's own window at read time (see
 * lib/scene-versions.ts).
 *
 * Refuses a version belonging to another scene. The id arrives from the
 * client, and an unchecked update here would let one project's scene adopt
 * another project's prompt and frame.
 */
export async function setActiveSceneVersion(
  sceneId: string,
  versionId: string,
): Promise<ActionResult> {
  const { scene } = await requireScene(sceneId);

  const editableResult = guardResult(() => assertEditable(scene));
  if (editableResult) return editableResult;

  const admin = createAdminClient();

  const { data: version, error: versionError } = await admin
    .from("scene_versions")
    .select("id, video_prompt, ref_frame_asset_id, render_settings, duration_s")
    .eq("id", versionId)
    .eq("scene_id", sceneId)
    .maybeSingle();

  if (versionError) {
    throw new Error(`Failed to look up version ${versionId}: ${versionError.message}`);
  }
  if (!version) {
    return { error: "That version does not belong to this scene." };
  }

  // The settings snapshot travels with the version (0059). Without this,
  // picking v1 gives you v1's prompt and frame at TODAY's model and length —
  // the same lie the migration exists to stop, just relocated to the switch.
  //
  // The snapshot is the EFFECTIVE merged settings; the column it is written
  // to holds an OVERRIDE. Writing the merged answer as the override is
  // deliberate: it pins the scene to exactly what the version recorded, so a
  // later change to the project's defaults cannot silently move a scene the
  // operator has just rewound. (An override is sticky by design — see
  // 0045_scene_render_settings_override.sql.)
  //
  // A version with a NULL snapshot — backfilled by 0058, predating these
  // columns — leaves the scene's settings ALONE rather than writing null over
  // them. Null there means "not known", not "no override"; blanking a live
  // override on the strength of a record that was never written would be
  // inventing an answer, which is the failure mode 0059 is guarding against.
  const settingsPatch =
    version.render_settings === null || version.render_settings === undefined
      ? {}
      : { render_settings_override: version.render_settings };
  const durationPatch = version.duration_s === null ? {} : { duration_s: version.duration_s };

  const { error } = await admin
    .from("scenes")
    .update({
      active_version_id: version.id,
      video_prompt: version.video_prompt,
      ref_frame_asset_id: version.ref_frame_asset_id,
      ...settingsPatch,
      ...durationPatch,
    })
    .eq("id", sceneId);

  if (error) {
    throw new Error(`Failed to switch scene ${sceneId} to version ${versionId}: ${error.message}`);
  }

  revalidatePath(`/projects/${scene.project_id}/scenes/${sceneId}`);
  revalidatePath(framesPath(scene.project_id));
  return undefined;
}

export async function generateFrames(projectId: string): Promise<GenerateFramesResult> {
  const { user, profile } = await requireProject(projectId);
  const admin = createAdminClient();

  const { data: scenes, error } = await admin
    .from("scenes")
    .select("id, status, video_prompt, is_talking_head")
    .eq("project_id", projectId)
    .is("ref_frame_asset_id", null)
    .order("idx", { ascending: true });

  if (error) {
    throw new Error(`Failed to load scenes for project ${projectId}: ${error.message}`);
  }

  // Defensive: a scene without a frame should always be draft/frame_ready
  // per the status contract, but a concurrently queued scene is skipped
  // rather than thrown on, consistent with this action tolerating partial
  // failure instead of aborting the batch.
  const targets = (scenes ?? []).filter((scene) => isSceneContentEditable(scene.status));

  if (targets.length === 0) {
    return { succeeded: [], failed: [] };
  }

  // Priced on the whole batch about to be submitted, not per scene — same
  // reasoning as enqueueRender pricing `pending` as one total rather than
  // checking each scene in isolation. This is Gate 2's regenerate-all
  // control (SMN-feature-spec.md's "REVIEW FRAMES — GATE — $0.02 each"),
  // and before this change it was the one paid batch operation in the app
  // with no cap in front of it at all.
  const frameBatchUsd = targets.length * estimatedRefFrameCostUsd();
  const capResult = await assertWithinSpendCaps(user.id, profile, frameBatchUsd);
  if (capResult) {
    return {
      succeeded: [],
      failed: targets.map((scene) => ({ sceneId: scene.id, error: capResult.error })),
    };
  }

  const refs = await loadConditioningRefs(admin, projectId);

  const settled = await runWithConcurrency(
    targets.map((scene) => async (): Promise<void> => {
      await generateSceneFrame(admin, projectId, scene, refImageUrlsForScene(refs, scene));
    }),
    FRAME_CONCURRENCY,
  );

  const succeeded: string[] = [];
  const failed: { sceneId: string; error: string }[] = [];

  settled.forEach((result) => {
    const scene = targets[result.index];
    if (scene === undefined) return;
    const sceneId = scene.id;
    if (result.status === "fulfilled") {
      succeeded.push(sceneId);
    } else {
      failed.push({
        sceneId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  revalidatePath(framesPath(projectId));
  return { succeeded, failed };
}

/** Saves an operator-edited prompt, then immediately regenerates that scene's frame from it. */
export async function updateScenePromptAndRegenerate(
  sceneId: string,
  prompt: string,
): Promise<ActionResult> {
  const { scene, project, user, profile } = await requireScene(sceneId);
  const editableResult = guardResult(() => assertEditable(scene));
  if (editableResult) return editableResult;

  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return { error: "Video prompt cannot be empty." };
  }

  // Checked before the prompt is saved: an over-cap regenerate must refuse
  // outright, not save the new prompt and then fail the (metered, capped)
  // part of the click — see enqueue.ts's guards for the same "check first,
  // write nothing on refusal" shape.
  const capResult = await assertWithinSpendCaps(user.id, profile, estimatedRefFrameCostUsd());
  if (capResult) return capResult;

  const admin = createAdminClient();
  const { error } = await admin
    .from("scenes")
    .update({ video_prompt: trimmed, edited_by_human: true })
    .eq("id", sceneId);

  if (error) {
    throw new Error(`Failed to save scene prompt: ${error.message}`);
  }

  const refs = await loadConditioningRefs(admin, project.id);

  // The prompt was just saved successfully, so a vendor failure here is about
  // the generation itself, not the write, and the operator needs to read
  // why — same reasoning ImageGenerationError gets everywhere else in this
  // file.
  try {
    await generateSceneFrame(
      admin,
      project.id,
      { id: scene.id, video_prompt: trimmed },
      refImageUrlsForScene(refs, scene),
    );
  } catch (err) {
    if (err instanceof ImageGenerationError) {
      // Through classifyRenderError, not raw: kie's own message is whatever
      // the vendor echoed back, and in the signing path that can contain the
      // signed reference-image URL we sent — a Supabase signed URL carries an
      // access token (see lib/render-error.ts). It also turns a recognised
      // cause into something the operator can act on: a content-policy
      // refusal is inconsistent about the same input, and saying "try again"
      // is the difference between a dead end and a retry that usually works.
      // Anything unrecognised falls through as the sanitised original.
      return { error: classifyRenderError(err.message).message };
    }
    throw err;
  }

  // The scene's OWN route as well as the frames grid. Regenerating rewrites
  // scenes.ref_frame_asset_id and the prompt, both of which this scene's
  // page renders — and the caller (scene-workbench.tsx) was making up the
  // difference with a client-side router.refresh() after the action
  // resolved. That is a second server round trip inside the same pending
  // transition, and the transition is what the operator is stuck behind:
  // clicking another scene in the rail during it queues the navigation
  // until the whole thing settles. Revalidating here folds that refresh
  // into the action's own response, which the router applies to the current
  // route on its own.
  revalidatePath(`/projects/${project.id}/scenes/${sceneId}`);
  revalidatePath(framesPath(project.id));
}

/**
 * Approves Gate 2 and hands off to the render flow. Refuses unless every
 * scene has a reference frame — this does NOT change `scenes.status`; the
 * enqueue action (owned by another part of this pipeline) is what
 * transitions scenes to 'queued'. This just gates navigation to the render
 * page once the operator has confirmed every frame is right.
 */
export async function approveFrames(projectId: string): Promise<ActionResult> {
  await requireProject(projectId);

  const admin = createAdminClient();
  const { data: scenes, error } = await admin
    .from("scenes")
    .select("id, ref_frame_asset_id")
    .eq("project_id", projectId);

  if (error) {
    throw new Error(`Failed to load scenes for project ${projectId}: ${error.message}`);
  }

  // Both of these are backstops, not the primary UX — frames/page.tsx only
  // renders the "Continue to render" button once `allFramed` is true, which
  // already implies both conditions below. Operator-actionable if somehow
  // reached (stale tab, a scene added mid-review), so returned rather than
  // thrown, same as regenerateCharacter's unreachable-in-UI backstop.
  if (!scenes || scenes.length === 0) {
    return { error: `Project ${projectId} has no scenes to approve.` };
  }

  const missing = scenes.filter((scene) => !scene.ref_frame_asset_id);
  if (missing.length > 0) {
    return {
      error: `Cannot proceed to render: ${missing.length} of ${scenes.length} scene(s) are still missing a reference frame.`,
    };
  }

  // redirect() throws a NEXT_REDIRECT-tagged error — Next's own control
  // flow, not a failure — and must be left to propagate uncaught here.
  // action-form.tsx's unstable_rethrow is what lets it through instead of
  // being misreported as a failed submission; see lib/action-result.ts.
  redirect(`/projects/${projectId}/render`);
}
