"use server";

// Writes to projects.render_settings — the resolution/fps/model choice the
// Render gate prices against (0012_render_settings.sql).
//
// Two rules this file exists to enforce, both of which the jsonb column
// itself cannot:
//
//   1. Validate before writing. The column has no CHECK constraint by
//      design — the legal values depend on which model is selected, which
//      is knowledge SQL does not have. That makes Zod the only validation
//      there is, so an unvalidated write here would make the column an
//      untyped blob that the worker later hands straight to fal.
//   2. Refuse while a scene is actually in flight. This is a CONCURRENCY
//      guard, not the "commitment" one every other pre-render field on this
//      project uses (see lib/editable-guard.ts's header comment) — it does
//      NOT move to projects.status === 'delivered' the way
//      actions/character.ts's lock did. The worker reads
//      projects.render_settings fresh at claim/dispatch time, joined
//      straight off the scene row (worker/internal/loop/dispatch.go,
//      worker/internal/store/store.go), not a value snapshotted when the
//      scene was queued. Changing resolution/fps/model while a scene is
//      'queued' (about to be claimed) or 'rendering' would change what that
//      SPECIFIC in-flight submission actually renders with — a live
//      correctness bug, not just a stale record. A project whose scenes are
//      all 'done'/'failed' (rendered, not delivered) has nothing in flight
//      to disturb, so it's free to change settings for its NEXT render —
//      same as every other pre-render field, that just leaves the
//      already-produced clips describing the old settings until whichever
//      of them get re-rendered.

import { revalidatePath } from "next/cache";
import { requireProject, requireScene } from "@/actions/guard";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import {
  isModelAvailableForSelection,
  renderSettingsSchemaFor,
  type RenderSettings,
} from "@/lib/models";
import { isSceneInFlight } from "@/lib/editable-guard";
import type { ActionResult } from "@/lib/action-result";
import type { Database } from "@/types/db";

type SceneRow = Database["public"]["Tables"]["scenes"]["Row"];

function renderPath(projectId: string): string {
  return `/projects/${projectId}/render`;
}

function scenePath(projectId: string, sceneId: string): string {
  return `/projects/${projectId}/scenes/${sceneId}`;
}

/**
 * Persists a project's render settings.
 *
 * Takes the three fields as a plain object rather than FormData because the
 * caller is a client component reacting to a select change, not a form
 * submission — and because it must be validated as a whole (the fps rule
 * depends on the model) rather than field by field.
 */
export async function updateRenderSettings(
  projectId: string,
  settings: { model: string; resolution: string; fps: number },
): Promise<ActionResult> {
  const { project } = await requireProject(projectId);

  const supabase = await createClient();
  const { data: scenes, error: scenesError } = await supabase
    .from("scenes")
    .select("status, duration_s")
    .eq("project_id", projectId);

  if (scenesError) {
    throw new Error(`Failed to load scenes for project ${projectId}: ${scenesError.message}`);
  }

  const sceneRows: Pick<SceneRow, "status" | "duration_s">[] = scenes ?? [];

  // Concurrency guard, not the project-wide commitment lock — see this
  // file's header comment. Only refuses while something is actually
  // 'queued'/'rendering'; a project sitting on nothing but 'done'/'failed'
  // scenes (rendered, not yet delivered) is free to change settings for
  // whatever it re-renders next. Operator-actionable ("wait for the
  // in-flight render to finish"), so returned rather than thrown — see
  // lib/action-result.ts.
  if (sceneRows.some((scene) => isSceneInFlight(scene.status))) {
    return {
      error:
        "A scene in this project is currently queued or rendering — render settings are locked " +
        "until it finishes, since the worker reads them fresh the moment it submits. Settings can " +
        "be changed again as soon as nothing is in flight.",
    };
  }

  // The 50fps/<=10s rule is a cross-field constraint between the settings
  // and the scene table, so the schema has to be built against this
  // project's longest scene. A project with no scenes yields 0, which makes
  // every fps legal — correct, since there is nothing to render and
  // enqueueRender refuses an empty project anyway.
  const longestSceneS = sceneRows.reduce(
    (longest, scene) => Math.max(longest, scene.duration_s),
    0,
  );

  const parsed = renderSettingsSchemaFor(longestSceneS).safeParse(settings);
  if (!parsed.success) {
    return {
      error: `Invalid render settings: ${parsed.error.issues.map((issue) => issue.message).join(" ")}`,
    };
  }

  const value: RenderSettings = parsed.data;
  if (!isModelAvailableForSelection(value.model, value.resolution)) {
    return { error: "Gemini Omni Video is unavailable until a paid receipt exists." };
  }

  // render_settings is one jsonb blob shared with the compiler-model choice
  // (lib/models.ts's parseCompilerModel/compileModel key) — RenderSettingsSchema
  // only knows about {model,resolution,fps}, so writing `value` verbatim
  // would silently wipe out compileModel the next time the operator touches
  // resolution or fps. Spread the column's CURRENT raw contents first so any
  // key this schema doesn't know about survives; `value`'s three fields
  // still win for the ones it does.
  const currentRaw: Record<string, unknown> =
    typeof project.render_settings === "object" && project.render_settings !== null
      ? (project.render_settings as Record<string, unknown>)
      : {};

  const admin = createAdminClient();
  const { error } = await admin
    .from("projects")
    .update({
      render_settings: { ...currentRaw, ...value },
      updated_at: new Date().toISOString(),
    })
    .eq("id", project.id);

  if (error) {
    throw new Error(`Failed to save render settings: ${error.message}`);
  }

  revalidatePath(renderPath(project.id));
  // The Brief gate's cost badge is priced with these settings too, so it
  // would otherwise keep showing the old total from cache.
  revalidatePath(`/projects/${project.id}/brief`);
}

/**
 * Persists ONE scene's render settings override — the per-scene sibling of
 * updateRenderSettings above, writing scenes.render_settings_override
 * (0045_scene_render_settings_override.sql) instead of
 * projects.render_settings.
 *
 * This is the write path the scene workbench's header picker needs: "hero
 * scene on Seedance, the rest on LTX" ($3.56/ad in the hybrid) is a
 * PER-SCENE decision, not a project setting. Until this existed,
 * render_settings_override was only ever written by the retry path
 * (actions/enqueue.ts's resolveOverride) — sticky once set, but never
 * something an operator could choose up front, before anything had failed.
 *
 * Takes the full {model,resolution,fps} triple, the SAME shape
 * updateRenderSettings takes — deliberately NOT RenderSettingsOverrideSchema's
 * {model}-only shape (actions/enqueue.ts). That schema exists for the RETRY
 * flow, where resolution/fps are documented to deliberately keep following
 * the project (see its own doc comment: "there is exactly one place those
 * two are chosen") because a retry is "same clip, different model," not a
 * durable per-scene choice. This action is the opposite case: the operator
 * is choosing this scene's OWN settings — including resolution, which the
 * scene header makes pickable — so all three fields are written and become
 * sticky together. Once a scene has an override written from here, the
 * project's own resolution/fps no longer reach it either, same as its model
 * already didn't; see clearSceneRenderOverride for the way back.
 *
 * Guards mirror updateRenderSettings exactly, scoped to one scene instead of
 * the whole project:
 *   - requireScene (write guard — requireProject alone is a read boundary
 *     with no scene ownership check attached).
 *   - isSceneInFlight: the worker reads render_settings_override fresh,
 *     joined off the scene row, at claim/dispatch time
 *     (worker/internal/loop/dispatch.go) — changing it out from under an
 *     already-queued attempt would change what that specific submission
 *     renders with, not just leave a stale record. A 'done'/'failed' scene
 *     has nothing in flight to disturb, so — same as updateRenderSettings —
 *     it stays free to change settings for whatever renders next.
 *   - renderSettingsSchemaFor(scene.duration_s), not the project's longest
 *     scene: the fps/duration cross-field rule is a property of ONE clip,
 *     and this action only ever has one scene in view — unlike
 *     updateRenderSettings, which has to fold every scene in the project
 *     into one longestSceneS because it writes one shared value for all of
 *     them.
 *   - Merge, not replace, onto scenes.render_settings_override's current raw
 *     contents — same rule updateRenderSettings applies to
 *     projects.render_settings, so a key this write doesn't know about (none
 *     exist today, but the column is partial by design and makes no promise
 *     one won't land here from elsewhere) survives.
 */
export async function updateSceneRenderOverride(
  sceneId: string,
  settings: { model: string; resolution: string; fps: number },
): Promise<ActionResult> {
  const { scene } = await requireScene(sceneId);

  if (isSceneInFlight(scene.status)) {
    return {
      error:
        `Scene ${sceneId} is "${scene.status}" — its render settings are locked until the ` +
        "current attempt finishes, since the worker reads them fresh the moment it submits. " +
        "They can be changed again as soon as nothing is in flight for this scene.",
    };
  }

  const parsed = renderSettingsSchemaFor(scene.duration_s).safeParse(settings);
  if (!parsed.success) {
    return {
      error: `Invalid render settings: ${parsed.error.issues.map((issue) => issue.message).join(" ")}`,
    };
  }
  const value: RenderSettings = parsed.data;
  if (!isModelAvailableForSelection(value.model, value.resolution)) {
    return { error: "Gemini Omni Video is unavailable until a paid receipt exists." };
  }

  const currentRaw: Record<string, unknown> =
    typeof scene.render_settings_override === "object" && scene.render_settings_override !== null
      ? (scene.render_settings_override as Record<string, unknown>)
      : {};

  const admin = createAdminClient();
  const { error } = await admin
    .from("scenes")
    .update({ render_settings_override: { ...currentRaw, ...value } })
    .eq("id", sceneId);

  if (error) {
    throw new Error(`Failed to save render override for scene ${sceneId}: ${error.message}`);
  }

  revalidatePath(scenePath(scene.project_id, sceneId));
  // Both quote a price derived from this scene's effective settings —
  // groupByEffectiveSettings (lib/estimate.ts) folds a scene's override into
  // both the render gate's total and (once compiled) the brief's.
  revalidatePath(renderPath(scene.project_id));
  revalidatePath(`/projects/${scene.project_id}/brief`);
}

/**
 * Clears one scene's render override, returning it to the project's default
 * settings — the "back to default" half of updateSceneRenderOverride above.
 *
 * A SEPARATE function rather than overloading updateSceneRenderOverride with
 * a null/empty `settings` argument: that action's parameter is a full,
 * freshly-validated {model,resolution,fps} triple, and every other caller in
 * this codebase (updateRenderSettings included) keeps "write a value" and
 * "clear a value" as distinct functions rather than one function whose
 * meaning depends on whether its argument is present — a null sentinel here
 * would need either a second, looser parameter type (weakening what every
 * other call site has to satisfy) or an implicit "empty object means clear"
 * reading that isn't obvious from the call site. A distinctly-named function
 * reads unambiguously at its one real caller (a "Reset to project default"
 * button) and needs no branching on what its argument means.
 *
 * Same in-flight guard as updateSceneRenderOverride, for the identical
 * reason: clearing the override while a render is in flight would change
 * what an already-submitted attempt renders with, same as changing it would.
 */
export async function clearSceneRenderOverride(sceneId: string): Promise<ActionResult> {
  const { scene } = await requireScene(sceneId);

  if (isSceneInFlight(scene.status)) {
    return {
      error:
        `Scene ${sceneId} is "${scene.status}" — its render settings are locked until the ` +
        "current attempt finishes, since the worker reads them fresh the moment it submits. " +
        "They can be changed again as soon as nothing is in flight for this scene.",
    };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("scenes")
    .update({ render_settings_override: null })
    .eq("id", sceneId);

  if (error) {
    throw new Error(`Failed to clear render override for scene ${sceneId}: ${error.message}`);
  }

  revalidatePath(scenePath(scene.project_id, sceneId));
  revalidatePath(renderPath(scene.project_id));
  revalidatePath(`/projects/${scene.project_id}/brief`);
}
