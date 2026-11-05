"use server";

// Gate 1 — the brief review screen (docs/architecture.md § "User flow", step
// 4: "REVIEW BRIEF — operator edits prompts — GATE — free"). Everything
// here mutates `scenes` while a project sits in the free part of the
// pipeline, before any render money is spent.
//
// Every mutating action here follows the same shape: guard first
// (requireScene/requireProject — never skip this), refuse if the scene(s)
// involved have moved past draft/frame_ready (money is committed past that
// point and edits must not silently diverge from what may already be
// queued or rendered), then write via createAdminClient().
//
// The guard is scoped to the scene(s) the write actually touches, not the
// whole project — a test render (enqueueTestScene, actions/enqueue.ts)
// leaves most of a project in draft/frame_ready with one scene already
// spent, and locking every field on every scene the moment any one of them
// renders would defeat the entire point of testing first. deleteScene and
// addScene only ever touch the scene(s) named in the call, so they check
// only those. reorderScenes touches every scene's `idx` (lib/scene-order.ts
// repacks the whole list), so it can't refuse on "any scene is locked" —
// instead it asserts the weaker, correct property: assertLockedOrderPreserved
// (lib/editable-guard.ts) lets pre-render scenes move freely while pinning
// already-rendered scenes to their existing relative order.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireScene, requireProject } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { insertAfter, removeSceneId, repackIds } from "@/lib/scene-order";
import { splitScriptLine } from "@/lib/scene-split";
import {
  isAudioEnabled,
  mergeRenderSettings,
  pickModel,
  parseCompilerModel,
  applySceneCostUsd,
} from "@/lib/models";
import {
  assertLockedOrderPreserved,
  isSceneInFlight,
  isSceneContentEditable,
} from "@/lib/editable-guard";
import { assertScenesComplete } from "@/lib/brief-guard";
import { guardResult, type ActionResult } from "@/lib/action-result";
import { compileScene, CLAUDE_VENDOR } from "@/lib/claude";
import { projectDirectionFrom } from "@/lib/direction";
import { loadLatestTemplate } from "@/actions/compile";
import { preserveTalkingHead } from "@/lib/talking-head";
import { assertWithinSpendCaps } from "@/lib/spend";
import { recordRun, recordedCall } from "@/lib/runs";

type SceneRow = Database["public"]["Tables"]["scenes"]["Row"];
type SceneStatus = SceneRow["status"];

/**
 * Content edits — the prompt, the script line, the roll, the duration.
 *
 * isSceneContentEditable, not isEditable: a finished scene is the
 * operator's again, because a re-render opens a new version rather than
 * overwriting the clip (0058_scene_versions.sql). isEditable answers the
 * MONEY question ("has this project committed render spend yet") and is
 * what enqueue and recompile still ask — see EDITABLE_STATUSES' own comment
 * for what happened when those two were briefly the same function.
 */
function assertEditable(scene: Pick<SceneRow, "id" | "status">): void {
  if (!isSceneContentEditable(scene.status)) {
    throw new Error(
      `Scene ${scene.id} is "${scene.status}" — while a render is queued or running the worker ` +
        "owns this scene and its brief cannot change. It unlocks when the clip lands or the " +
        "render fails.",
    );
  }
}

function assertAllEditable(scenes: readonly Pick<SceneRow, "id" | "status">[]): void {
  for (const scene of scenes) {
    assertEditable(scene);
  }
}

// Manual duration edits on the brief-review gate must land on one of the
// fal-allowed clip lengths, read from the project's selected model
// descriptor rather than a global constant — 0012_render_settings.sql moved
// the allowed set out of the schema for exactly this reason, and this is
// one of the three layers that now carries the rule. The same literal_error
// that broke production for compiler output ("Input should be 6, 8, 10, 12,
// 14, 16, 18 or 20") applies just as much to a value the operator typed in
// by hand. Snap to the nearest allowed value rather than clamping to a
// range, since arbitrary values in [6, 20] are still invalid.
function clampDuration(seconds: number, allowed: readonly number[]): number {
  return allowed.reduce((closest, candidate) =>
    Math.abs(candidate - seconds) < Math.abs(closest - seconds) ? candidate : closest,
  );
}

/**
 * The clip lengths this project's selected model accepts. Reads
 * projects.render_settings leniently (parseRenderSettings never throws and
 * always returns a populated object) so a project whose settings blob is
 * malformed still edits against the default model rather than 500ing.
 */
function allowedDurationsFor(
  project: { render_settings: unknown },
  sceneOverride: unknown,
  scene?: { is_talking_head: boolean },
): readonly number[] {
  // The SCENE's effective model, not the project's. A scene may override the
  // model (scenes.render_settings_override), and the allowed lengths differ
  // per model — [4,6,8] on one, [3..15] on another. Clamping against the
  // PROJECT's model meant a scene overridden onto a longer-capable model had
  // its chosen length silently snapped to a value the operator never picked:
  // click 3s, get 4s, no error, and the next paid render is a 4s clip at the
  // 4s price. The picker offers the scene's list, so the guard has to judge
  // by the same one.
  const settings = mergeRenderSettings(project.render_settings, sceneOverride);
  // pickModel, not getModel: an audio model on a silent scene (or with
  // audio off account-wide) is SUBSTITUTED at render time, and the
  // substitute has its own list. Kling allows 3s and Seedance 2.5 starts at
  // 4s, so judging by the picked model would accept a 3s scene that the
  // model actually rendering it cannot produce. `scene` is optional because
  // one caller has no scene yet — a brand-new row, which is talking-head
  // false by default, matching what it is about to be inserted as.
  return pickModel(scene?.is_talking_head ?? false, isAudioEnabled(), settings).allowedDurationsS;
}

function briefPath(projectId: string): string {
  return `/projects/${projectId}/brief`;
}

/**
 * Writes the final `idx` values for an ordered list of scene ids using a
 * two-phase update. A single-phase, row-by-row update to the target
 * positions can collide with `scenes`' `unique (project_id, idx)`
 * constraint mid-sequence (e.g. swapping scenes at idx 0 and 1). Moving
 * everything to a disjoint negative range first guarantees no intermediate
 * state ever collides with another row's current or future idx.
 *
 * Exported so actions/deliver.ts's reorderCut can reuse this exact
 * two-phase write for the assembled-cut reorder instead of a second
 * implementation of the same collision-avoidance trick — see reorderCut's
 * own doc comment for why that action exists separately from reorderScenes
 * below rather than sharing its guard.
 */
export async function persistOrder(
  admin: SupabaseClient<Database>,
  orderedIds: readonly string[],
): Promise<void> {
  const targets = repackIds(orderedIds);

  const toNegative = await Promise.all(
    targets.map(({ id }, position) =>
      admin
        .from("scenes")
        .update({ idx: -(position + 1) })
        .eq("id", id),
    ),
  );
  const negativeError = toNegative.find((result) => result.error)?.error;
  if (negativeError) {
    throw new Error(`Failed to re-pack scene order (phase 1): ${negativeError.message}`);
  }

  const toFinal = await Promise.all(
    targets.map(({ id, idx }) => admin.from("scenes").update({ idx }).eq("id", id)),
  );
  const finalError = toFinal.find((result) => result.error)?.error;
  if (finalError) {
    throw new Error(`Failed to re-pack scene order (phase 2): ${finalError.message}`);
  }
}

async function orderedSceneIds(
  admin: SupabaseClient<Database>,
  projectId: string,
): Promise<{ id: string; status: SceneStatus }[]> {
  const { data, error } = await admin
    .from("scenes")
    .select("id, status, idx")
    .eq("project_id", projectId)
    .order("idx", { ascending: true });

  if (error) {
    throw new Error(`Failed to load scenes for project ${projectId}: ${error.message}`);
  }
  return data ?? [];
}

/** Sets the video prompt an operator hand-edited, flagging it as human-touched. */
export async function updateScenePrompt(sceneId: string, prompt: string): Promise<ActionResult> {
  const { scene, project } = await requireScene(sceneId);
  const editableResult = guardResult(() => assertEditable(scene));
  if (editableResult) return editableResult;

  const admin = createAdminClient();
  const { error } = await admin
    .from("scenes")
    .update({ video_prompt: prompt, edited_by_human: true })
    .eq("id", sceneId);

  if (error) {
    throw new Error(`Failed to update scene prompt: ${error.message}`);
  }
  revalidatePath(briefPath(project.id));
}

/** Sets the source script line for a scene. */
export async function updateSceneLine(sceneId: string, line: string): Promise<ActionResult> {
  const { scene, project } = await requireScene(sceneId);
  const editableResult = guardResult(() => assertEditable(scene));
  if (editableResult) return editableResult;

  const admin = createAdminClient();
  const { error } = await admin.from("scenes").update({ script_line: line }).eq("id", sceneId);

  if (error) {
    throw new Error(`Failed to update scene line: ${error.message}`);
  }
  revalidatePath(briefPath(project.id));
}

/**
 * Flips a scene between A-roll (talking head, native-audio lip-sync,
 * $0.14/s) and B-roll (silent, $0.04/s) — the single lever that controls
 * ~60% of render spend (docs/architecture.md § "Cost model").
 */
export async function toggleTalkingHead(sceneId: string): Promise<ActionResult> {
  const { scene, project } = await requireScene(sceneId);
  const editableResult = guardResult(() => assertEditable(scene));
  if (editableResult) return editableResult;

  const admin = createAdminClient();
  const { error } = await admin
    .from("scenes")
    .update({ is_talking_head: !scene.is_talking_head })
    .eq("id", sceneId);

  if (error) {
    throw new Error(`Failed to toggle scene: ${error.message}`);
  }
  revalidatePath(briefPath(project.id));
}

/** Sets a scene's clip duration, snapped to the nearest fal-allowed length. */
export async function updateSceneDuration(sceneId: string, seconds: number): Promise<ActionResult> {
  const { scene, project } = await requireScene(sceneId);
  const editableResult = guardResult(() => assertEditable(scene));
  if (editableResult) return editableResult;

  const admin = createAdminClient();
  const { error } = await admin
    .from("scenes")
    .update({
      duration_s: clampDuration(
        seconds,
        allowedDurationsFor(project, scene.render_settings_override, scene),
      ),
    })
    .eq("id", sceneId);

  if (error) {
    throw new Error(`Failed to update scene duration: ${error.message}`);
  }
  revalidatePath(briefPath(project.id));
}

/**
 * Regenerates one scene's video prompt from its current script line (spec
 * §3.5: `Apply` — "Generates fitting Veo 3 + Nano Banana prompts from the
 * script line above"). Delegates the actual generation to compileScene
 * (lib/claude.ts), which reuses the full compiler's direction-block
 * assembly, shooting-mode hints, "never put words on screen" rule and
 * allowed-duration set — the point of going through that function instead of
 * hand-rolling a second Claude call here is that a re-applied scene cannot
 * drift from how the rest of the project's brief was written.
 *
 * script_line itself is untouched: it is this call's input, not its output.
 * `edited_by_human` is cleared, since a freshly machine-generated prompt is
 * definitionally not a human edit anymore — leaving it set would show the
 * "edited" badge on a scene the operator never actually typed into.
 *
 * is_talking_head is NOT taken from compileScene's output: preserveTalkingHead
 * (lib/talking-head.ts) overrides it back to the scene's existing value
 * before the write. compileScene re-derives is_talking_head from scratch
 * every time (the template has no "operator already decided this" input),
 * so without that override, re-applying a scene can silently flip it between
 * A-roll and B-roll — under MOCK_CLAUDE=1 it always does, forcing A-roll.
 * See lib/talking-head.ts for why this is a write-back override rather than
 * a prompt hint.
 *
 * scenes.visual_idea is handled the exact same way, for the exact same
 * reason: it is passed INTO compileScene (so a re-Apply keeps expanding the
 * operator's own per-line visual idea, not inventing one) but is carried
 * forward unchanged in the write below, never taken from compileScene's
 * output — SceneBrief (lib/claude.ts) doesn't even have a visual_idea field
 * to take it from. An operator-authored value must not be silently
 * rewritten by a recompile, same as is_talking_head above.
 */
export async function applyScenePrompt(sceneId: string): Promise<ActionResult> {
  const { scene, project, user, profile } = await requireScene(sceneId);
  const editableResult = guardResult(() => assertEditable(scene));
  if (editableResult) return editableResult;

  if (!scene.script_line || scene.script_line.trim().length === 0) {
    return { error: "This scene has no script line to generate a prompt from." };
  }

  // The project's own compiler-model choice — same resolution
  // actions/compile.ts uses for the full compile (parseCompilerModel's own
  // doc comment, lib/models.ts), read once and reused below for the
  // spend-cap check, the actual compileScene call, AND the `runs` row, so
  // the quoted price, the enforced price, and the model that actually ran
  // can never drift apart.
  const compilerModel = parseCompilerModel(project.render_settings);
  const sceneCostUsd = applySceneCostUsd(compilerModel);

  const capResult = await assertWithinSpendCaps(user.id, profile, sceneCostUsd);
  if (capResult) return capResult;

  const template = await loadLatestTemplate();
  const claudeModel = compilerModel.id;
  let sceneBrief: Awaited<ReturnType<typeof compileScene>>;
  try {
    sceneBrief = await compileScene({
      scriptLine: scene.script_line,
      characterDesc: project.character_desc ?? undefined,
      productName: project.product_name ?? undefined,
      productAppearance: project.product_appearance ?? undefined,
      templateBody: template.body,
      direction: projectDirectionFrom(project),
      visualIdea: scene.visual_idea ?? undefined,
      model: claudeModel,
    });
  } catch (err) {
    // costUsd null — see actions/compile.ts's identical recordRun/catch for
    // why this codebase won't guess whether a failed Claude call was billed.
    await recordRun({
      projectId: project.id,
      sceneId: scene.id,
      vendor: CLAUDE_VENDOR,
      model: claudeModel,
      costUsd: null,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  await recordRun({
    projectId: project.id,
    sceneId: scene.id,
    vendor: CLAUDE_VENDOR,
    model: claudeModel,
    costUsd: sceneCostUsd,
  });

  const generated = preserveTalkingHead(scene, sceneBrief);

  const admin = createAdminClient();
  const { error } = await admin
    .from("scenes")
    .update({
      video_prompt: generated.video_prompt,
      is_talking_head: generated.is_talking_head,
      duration_s: generated.duration_s,
      edited_by_human: false,
      // Carried forward unchanged, not taken from compileScene's output —
      // see this function's doc comment.
      visual_idea: scene.visual_idea,
    })
    .eq("id", sceneId);

  if (error) {
    throw new Error(`Failed to apply generated prompt: ${error.message}`);
  }
  revalidatePath(briefPath(project.id));
}

/**
 * Removes a scene and re-packs `idx` so no gap is left behind. Only the
 * deleted scene itself has to be editable — removing a pre-render scene
 * just shifts the `idx` of whatever comes after it (lib/scene-order.ts
 * preserves everyone's relative order), which is harmless even if some of
 * those later scenes have already rendered.
 */
export async function deleteScene(sceneId: string): Promise<ActionResult> {
  const { scene, project } = await requireScene(sceneId);
  // Narrower than assertEditable on purpose. That guard widened to include
  // rendered scenes (lib/editable-guard.ts) because everything it gates can
  // be re-done by spending again — a regenerated frame, a rewritten prompt,
  // another render, all recoverable, and the old version stays pickable.
  // Deleting the scene is the one thing here that takes the versions with
  // it, so it keeps the old, tighter rule.
  if (scene.status !== "draft" && scene.status !== "frame_ready") {
    return {
      error: `Scene ${scene.id} has already rendered — delete is only available before a clip exists. Re-render or switch versions instead.`,
    };
  }

  const admin = createAdminClient();
  const existing = await orderedSceneIds(admin, project.id);

  const { error: deleteError } = await admin.from("scenes").delete().eq("id", sceneId);
  if (deleteError) {
    throw new Error(`Failed to delete scene: ${deleteError.message}`);
  }

  const remainingIds = removeSceneId(
    existing.map((row) => row.id),
    sceneId,
  );
  await persistOrder(admin, remainingIds);
  revalidatePath(briefPath(project.id));
}

/**
 * Splits one scene into two (spec §3.5: `Split`, alongside `+ Below` and
 * `✕ Delete` — "full scene-list surgery"), for a scene that tries to carry
 * too much dialogue for one shot.
 *
 * Script line: divided by lib/scene-split.ts's splitScriptLine, which cuts
 * at the sentence boundary nearest the midpoint (falling back to a word
 * boundary for a single-sentence line) rather than an arbitrary character
 * count. A line too short to produce two non-empty halves (a single word)
 * is refused rather than silently producing an empty-dialogue scene.
 *
 * Video prompt: neither half reuses or truncates the original scene's
 * prompt, because that prompt was written to cover the *whole* original
 * line — once the line is divided, neither half's content is a subset of
 * it. Both halves instead get a fresh prompt from compileScene, the exact
 * same single-scene Claude call Apply uses, so a split scene is never left
 * with an empty or stale video_prompt that would fail at the render gate.
 *
 * Duration: fal's allowed set (6/8/10/12/14/16/18/20s, model-dependent) has
 * no notion of "half of X seconds" — halving an arbitrary allowed value
 * essentially never lands back on the set (10s -> 5s + 5s, both invalid),
 * and independently snapping each half to its nearest allowed value is
 * exactly the "arbitrary value in range" trap clampDuration's own comment
 * warns against; there's no principled way to derive two valid durations
 * from one without guessing at how long each new line's footage should run.
 * Both halves instead start at the model's shortest allowed clip length —
 * the same rule addScene already uses for a brand-new blank scene — and the
 * operator adjusts via the existing duration control once they've read what
 * Claude wrote for each half.
 *
 * Only the split scene itself needs to be editable: like addScene, this
 * only ever touches the one scene being split (rewritten in place as the
 * first half) plus a brand-new inserted scene (the second half); every other
 * scene's `idx` shift from the insert is harmless regardless of its status
 * (lib/scene-order.ts preserves relative order).
 *
 * is_talking_head: both halves inherit the ORIGINAL scene's value (via
 * preserveTalkingHead, lib/talking-head.ts) rather than each re-deriving
 * its own from compileScene's output. A split is a text operation — the
 * operator asked for one shot's dialogue to become two, not for either half
 * to be re-judged as A-roll vs B-roll — and letting compileScene decide
 * independently per half risks the two new scenes disagreeing with each
 * other, or with the scene they came from, on a field that drives both
 * reference-image routing and render cost.
 *
 * visual_idea: both halves inherit the ORIGINAL scene's visual_idea too,
 * same pattern and same reasoning as is_talking_head above — it's fed INTO
 * both compileScene calls (so each half's prompt still expands the
 * operator's own visual idea) but the persisted column is carried forward
 * unchanged rather than taken from either compileScene result, since
 * SceneBrief has no visual_idea field to take it from in the first place.
 * A split doesn't ask Claude to decide a new visual idea for either half.
 */
export async function splitScene(sceneId: string): Promise<ActionResult> {
  const { scene, project, user, profile } = await requireScene(sceneId);
  const editableResult = guardResult(() => assertEditable(scene));
  if (editableResult) return editableResult;

  const [firstLine, secondLine] = splitScriptLine(scene.script_line ?? "");
  if (firstLine.length === 0 || secondLine.length === 0) {
    return { error: "This scene's script line is too short to split into two scenes." };
  }

  // Same per-project compiler-model resolution as applyScenePrompt above —
  // see that function's comment. sceneCostUsd is priced at THIS model's
  // rate, not the flat APPLY_SCENE_COST_USD.
  const compilerModel = parseCompilerModel(project.render_settings);
  const sceneCostUsd = applySceneCostUsd(compilerModel);

  // Two compileScene calls below (one per half) — priced and cap-checked as
  // one 2x batch up front, matching what scene-table.tsx's Split button
  // already quotes (`2 * APPLY_SCENE_COST_USD`), but at the resolved
  // model's derived rate rather than the flat default.
  const capResult = await assertWithinSpendCaps(user.id, profile, 2 * sceneCostUsd);
  if (capResult) return capResult;

  const template = await loadLatestTemplate();
  const direction = projectDirectionFrom(project);
  const characterDesc = project.character_desc ?? undefined;
  const productName = project.product_name ?? undefined;
  const productAppearance = project.product_appearance ?? undefined;
  // This scene's own model decides the floor — same reason the duration
  // guard uses the effective settings rather than the project's.
  const shortestAllowed = allowedDurationsFor(project, scene.render_settings_override, scene)[0]!;
  const claudeModel = compilerModel.id;
  const runMeta = {
    projectId: project.id,
    sceneId: scene.id,
    vendor: CLAUDE_VENDOR,
    model: claudeModel,
  };

  const [firstCompiled, secondCompiled] = await Promise.all([
    recordedCall(runMeta, sceneCostUsd, () =>
      compileScene({
        scriptLine: firstLine,
        characterDesc,
        productName,
        productAppearance,
        templateBody: template.body,
        direction,
        visualIdea: scene.visual_idea ?? undefined,
        model: claudeModel,
      }),
    ),
    recordedCall(runMeta, sceneCostUsd, () =>
      compileScene({
        scriptLine: secondLine,
        characterDesc,
        productName,
        productAppearance,
        templateBody: template.body,
        direction,
        visualIdea: scene.visual_idea ?? undefined,
        model: claudeModel,
      }),
    ),
  ]);
  // Both halves inherit the pre-split scene's is_talking_head — see the
  // doc comment above and lib/talking-head.ts.
  const firstGenerated = preserveTalkingHead(scene, firstCompiled);
  const secondGenerated = preserveTalkingHead(scene, secondCompiled);

  const admin = createAdminClient();
  const existing = await orderedSceneIds(admin, project.id);

  const { error: updateError } = await admin
    .from("scenes")
    .update({
      script_line: firstLine,
      video_prompt: firstGenerated.video_prompt,
      is_talking_head: firstGenerated.is_talking_head,
      duration_s: shortestAllowed,
      edited_by_human: false,
      // Inherited from the parent scene unchanged — see this function's
      // doc comment.
      visual_idea: scene.visual_idea,
    })
    .eq("id", sceneId);
  if (updateError) {
    throw new Error(`Failed to split scene: ${updateError.message}`);
  }

  const { data: inserted, error: insertError } = await admin
    .from("scenes")
    .insert({
      project_id: project.id,
      // Same disjoint-negative placeholder trick as addScene — persistOrder
      // assigns the real, gapless index right after.
      idx: -(existing.length + 1),
      script_line: secondLine,
      video_prompt: secondGenerated.video_prompt,
      is_talking_head: secondGenerated.is_talking_head,
      duration_s: shortestAllowed,
      status: "draft",
      // Inherited from the parent scene unchanged — see this function's
      // doc comment.
      visual_idea: scene.visual_idea,
    })
    .select()
    .single();
  if (insertError || !inserted) {
    throw new Error(`Failed to insert split scene: ${insertError?.message ?? "unknown error"}`);
  }

  const orderedIds = insertAfter(
    existing.map((row) => row.id),
    scene.idx,
    inserted.id,
  );
  await persistOrder(admin, orderedIds);
  revalidatePath(briefPath(project.id));
}

/**
 * Inserts a blank scene after the scene currently at `afterIdx` (pass
 * `null` to insert at the top), re-packing `idx` for the rest of the
 * project. No editability check on the project as a whole — a new scene
 * doesn't touch any existing one's content, and inserting it just shifts
 * the `idx` of whatever comes after (lib/scene-order.ts preserves relative
 * order), harmless even next to a scene that's already rendered.
 */
export async function addScene(projectId: string, afterIdx: number | null): Promise<ActionResult> {
  const { project } = await requireProject(projectId);

  const admin = createAdminClient();
  const existing = await orderedSceneIds(admin, projectId);

  const { data: inserted, error: insertError } = await admin
    .from("scenes")
    .insert({
      project_id: projectId,
      // Temporary placeholder outside the valid 0..n-1 range, guaranteed
      // not to collide with any existing (project_id, idx) row; persistOrder
      // assigns the real, gapless index right after.
      idx: -(existing.length + 1),
      script_line: "",
      video_prompt: "",
      is_talking_head: false,
      // Shortest fal-allowed clip length for the selected model — a
      // blank scene must already be render-valid, not just schema-valid.
      // A new scene carries no override yet, so the project's model is its
      // effective one — null is the honest argument, not a shortcut.
      duration_s: allowedDurationsFor(project, null)[0],
      status: "draft",
    })
    .select()
    .single();

  if (insertError || !inserted) {
    throw new Error(`Failed to add scene: ${insertError?.message ?? "unknown error"}`);
  }

  const orderedIds = insertAfter(
    existing.map((row) => row.id),
    afterIdx,
    inserted.id,
  );
  await persistOrder(admin, orderedIds);
  revalidatePath(briefPath(projectId));
  // Explicit, not just falling off the end — addScene has no guard branch
  // that returns an ActionResult (an insert never conflicts with another
  // scene's editability the way delete/reorder can), so without this the
  // compiler has no return statement anywhere in the body to infer
  // Promise<ActionResult>'s `undefined` arm from.
  return undefined;
}

/**
 * Re-packs `idx` to match a caller-supplied order (e.g. after a
 * drag-and-drop reorder). Unlike delete/add, a reorder can touch every
 * scene's position at once, so "every scene editable" isn't the right
 * guard here — assertLockedOrderPreserved instead lets pre-render scenes
 * move freely while refusing any reorder that would change an
 * already-rendered scene's position relative to the others.
 *
 * Two additional guards beyond assertLockedOrderPreserved:
 *
 *   - Refused outright once `project.status === 'delivered'` — the same
 *     commitment-point lock every other project-level write in this
 *     codebase now reads directly (lib/editable-guard.ts's header comment;
 *     actions/character.ts, actions/project.ts, actions/character-library.ts).
 *     A delivered project's `final` asset is the thing that was handed to
 *     the client; silently reshuffling the cut order underneath it without
 *     an explicit reopen would leave 'delivered' pointing at a video that
 *     no longer matches the order the operator most recently set.
 *   - Refused while any scene is 'queued'/'rendering' (isSceneInFlight,
 *     lib/editable-guard.ts) — the same pure-concurrency reasoning
 *     render-settings.ts's updateRenderSettings already uses: the worker
 *     claims scenes off `idx` order (worker/internal/loop's dispatch and
 *     assemble both read it), so rewriting `idx` while something is
 *     mid-claim risks the worker acting on a position that changes out
 *     from under it, not just leaving a stale record.
 *
 * On success, also stamps `projects.cut_order_updated_at = now()`
 * (0039_cut_order.sql) — see that migration for why this is a dedicated
 * column rather than projects.updated_at. This is a SEPARATE write from
 * persistOrder's own two-phase idx rewrite, issued only after it succeeds,
 * so a partial failure can leave `idx` rewritten with the stamp not yet
 * written (readable as "not stale" a beat longer than is strictly true) —
 * the Supabase JS client has no multi-statement transaction here, and
 * persistOrder's own two update phases already carry the same class of
 * non-atomicity for the same reason. The exposure is narrow: the next
 * successful write to this column (another reorder) or the worker's next
 * assemble pass corrects it, and nothing reads `idx` and
 * `cut_order_updated_at` together as a single invariant that this window
 * could violate.
 */
export async function reorderScenes(
  projectId: string,
  orderedIds: string[],
): Promise<ActionResult> {
  const { project } = await requireProject(projectId);

  if (project.status === "delivered") {
    return {
      error:
        "This project has already been delivered — the cut order is locked. Reopen the project " +
        "(Deliver page) to reorder scenes.",
    };
  }

  const admin = createAdminClient();
  const existing = await orderedSceneIds(admin, projectId);

  if (existing.some((scene) => isSceneInFlight(scene.status))) {
    return {
      error:
        "A scene in this project is currently queued or rendering — the cut order is locked " +
        "until it finishes, since the worker claims scenes by their position. It can be " +
        "reordered again as soon as nothing is in flight.",
    };
  }

  const lockedOrderResult = guardResult(() => assertLockedOrderPreserved(existing, orderedIds));
  if (lockedOrderResult) return lockedOrderResult;

  const existingIds = new Set(existing.map((row) => row.id));
  const validOrderedIds = orderedIds.filter((id) => existingIds.has(id));
  if (validOrderedIds.length !== existing.length) {
    // A mismatch here means the caller's ordered list and the project's
    // actual scene set disagree — a client/server desync bug, not something
    // an operator can act on by reading a message, so this stays thrown
    // rather than returned (see lib/action-result.ts).
    throw new Error(
      `reorderScenes: orderedIds does not match project ${projectId}'s scene set ` +
        `(expected ${existing.length}, matched ${validOrderedIds.length}).`,
    );
  }

  await persistOrder(admin, validOrderedIds);

  const { error: stampError } = await admin
    .from("projects")
    .update({ cut_order_updated_at: new Date().toISOString() })
    .eq("id", projectId);

  if (stampError) {
    throw new Error(
      `Failed to stamp cut_order_updated_at for project ${projectId}: ${stampError.message}`,
    );
  }

  revalidatePath(briefPath(projectId));
}

/**
 * Approves the brief — the operator has read every prompt — and advances
 * the project to Gate 2 (reference frames). This is the last point before
 * the pipeline starts spending money in earnest.
 */
export async function approveBrief(projectId: string): Promise<ActionResult> {
  const { project } = await requireProject(projectId);

  const admin = createAdminClient();
  const { data: scenes, error: scenesError } = await admin
    .from("scenes")
    .select("id, status, idx, script_line, video_prompt")
    .eq("project_id", projectId)
    .order("idx", { ascending: true });

  if (scenesError) {
    throw new Error(`Failed to load scenes for project ${projectId}: ${scenesError.message}`);
  }

  const existing = scenes ?? [];
  if (existing.length === 0) {
    return { error: `Project ${projectId} has no scenes to approve.` };
  }
  const allEditableResult = guardResult(() => assertAllEditable(existing));
  if (allEditableResult) return allEditableResult;
  const completeResult = guardResult(() => assertScenesComplete(existing));
  if (completeResult) return completeResult;

  const { error } = await admin
    .from("projects")
    .update({ status: "framed", updated_at: new Date().toISOString() })
    .eq("id", project.id);

  if (error) {
    throw new Error(`Failed to approve brief: ${error.message}`);
  }

  revalidatePath(briefPath(projectId));
  revalidatePath("/projects");
  redirect(`/projects/${projectId}/frames`);
}
