"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireProject, AuthorizationError } from "@/actions/guard";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { requireScript } from "@/lib/script-guard";
import { requireTitle } from "@/lib/title-guard";
import type { ActionResult } from "@/lib/action-result";
import type { Database } from "@/types/db";

type SceneRow = Database["public"]["Tables"]["scenes"]["Row"];

export interface UpdateProjectFields {
  title?: string;
  script_raw?: string | null;
  character_desc?: string | null;
}

/**
 * Creates a project from the "New project" form and redirects into the
 * character-setup step. Both title and script are required — a project
 * created without one would carry an empty script all the way to the
 * Character step, where compileScript would be the first thing to notice.
 * The textarea's own `required` attribute is a convenience only; this is
 * the boundary a POST past the browser has to clear. Both the title and the
 * script stay editable after creation (title on settings/page.tsx, script
 * on script/page.tsx — see actions/setup.ts's saveScript and this file's
 * own updateProject below), which is why each emptiness check lives in its
 * own lib/*-guard.ts rather than here — this and the edit path share the
 * one check per field so they can't accept different values.
 */
export async function createProject(formData: FormData): Promise<ActionResult> {
  const { user } = await requireUser();

  const titleResult = requireTitle(formData.get("title"));
  if ("error" in titleResult) {
    return titleResult;
  }

  const scriptResult = requireScript(formData.get("script_raw"));
  if ("error" in scriptResult) {
    return scriptResult;
  }

  const admin = createAdminClient();
  const { data: project, error } = await admin
    .from("projects")
    .insert({
      user_id: user.id,
      title: titleResult.title,
      script_raw: scriptResult.script,
    })
    .select()
    .single();

  if (error || !project) {
    throw new Error(`Failed to create project: ${error?.message ?? "unknown error"}`);
  }

  revalidatePath("/projects");
  redirect(`/projects/${project.id}/character`);
}

/**
 * Updates a project's editable fields. Ownership is enforced by
 * requireProject before the admin client is ever touched.
 *
 * script_raw and character_desc are pre-render inputs, locked the same way
 * every other one is (actions/setup.ts's saveCharacter/saveScript and
 * actions/settings.ts's saveDirection) — once `project.status === 'delivered'`
 * (deriveProjectStatus's output, already resolved onto `project` by
 * requireProject — see actions/guard.ts), the operator's own record of
 * what should render is frozen until they explicitly reopen it
 * (actions/deliver.ts's reopenProject). This is deliberately NOT "once any
 * scene has left draft/frame_ready" — see lib/editable-guard.ts's header
 * comment for why that's a different, narrower question (per-scene
 * concurrency/workflow, not project-level commitment). Rendering having
 * started, or even finished, doesn't corrupt anything here: it just means
 * an edit won't be reflected in clips that already exist until they're
 * re-rendered, a warning each Setup page surfaces (components/setup-lock-
 * banner.tsx), not a write refusal.
 *
 * title is exempt — same asymmetry actions/settings.ts's saveTitle relies on
 * for settings/page.tsx's own Title field: it feeds no prompt and no render, so renaming a finished
 * or even delivered project is completely ordinary. A caller that sends
 * only `title` never pays the lock, even on a locked project.
 *
 * Refused outright (returned, not thrown) when locked and either
 * script_raw or character_desc is present, matching every other lock
 * check in this codebase — the operator can act on this message, so it
 * must survive production's React error #441 redaction (lib/action-
 * result.ts). Nothing is written in that case, not even title: a caller
 * that asked for a locked field to change needs to be told it didn't,
 * not to have it silently dropped.
 */
export async function updateProject(
  id: string,
  fields: UpdateProjectFields,
): Promise<ActionResult> {
  const { project } = await requireProject(id);

  if (
    project.status === "delivered" &&
    (fields.script_raw !== undefined || fields.character_desc !== undefined)
  ) {
    return {
      error:
        "This project has already been delivered — the script and character are locked. Reopen " +
        "the project (Deliver page) to change them; existing clips won't reflect the change until " +
        "they're re-rendered.",
    };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("projects")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to update project: ${error.message}`);
  }

  revalidatePath("/projects");
  revalidatePath(`/projects/${id}`);
}

/**
 * Renames a project from the /projects list's row-actions menu
 * (components/project-row-actions.tsx via components/rename-project-
 * dialog.tsx) — the one write path on that row that ISN'T a redirect or a
 * plain delete, so it gets its own function rather than being folded into
 * updateProject: that function's FormData-shaped callers (saveTitle) and
 * its delivered-project lock don't apply here (title is exempt from that
 * lock anyway — see updateProject's own doc comment), and a rename from a
 * table row has no `id` to redirect to afterward the way createProject and
 * duplicateProject do.
 *
 * Ownership: requireProject, same as every other write in this file
 * (deleteProject, updateProject) — a rename is a write against a project id
 * the CLIENT supplied (the dialog passes whatever `projectId` prop it was
 * given), so it gets the one guard every admin-client write in this file
 * goes through, not a bespoke read-then-check the way duplicateProject's
 * ownership-optional read is.
 *
 * Validation: requireTitle, the exact function createProject and saveTitle
 * already call. A rename that accepted a title creation would have
 * refused (empty, or over MAX_TITLE_LENGTH) would be two different rules
 * for the same column — see lib/title-guard.ts's own header comment for
 * why this is deliberately the ONE place that check is written.
 *
 * An unchanged title (after trimming — the same trim requireTitle already
 * does) is treated as a no-op rather than an ordinary write: the dialog
 * prefills the current title and selects it, so "submit without changing
 * anything" is the expected shape of "I opened this by mistake," and that
 * shouldn't cost an UPDATE or bump updated_at for a row nothing actually
 * changed on.
 */
export async function renameProject(id: string, title: string): Promise<ActionResult> {
  const { project } = await requireProject(id);

  const titleResult = requireTitle(title);
  if ("error" in titleResult) {
    return titleResult;
  }

  if (titleResult.title === project.title) {
    return undefined;
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("projects")
    .update({ title: titleResult.title, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to rename project: ${error.message}`);
  }

  revalidatePath("/projects");
  revalidatePath(`/projects/${id}`);
}

/** Deletes a project (and, via ON DELETE CASCADE, its scenes/assets/runs). */
export async function deleteProject(id: string): Promise<void> {
  await requireProject(id);

  const admin = createAdminClient();
  const { error } = await admin.from("projects").delete().eq("id", id);

  if (error) {
    throw new Error(`Failed to delete project: ${error.message}`);
  }

  revalidatePath("/projects");
  redirect("/projects");
}

/**
 * Deep-copies a project and its scenes into a brand new project owned by
 * the current user. This is the sanctioned way to iterate on a
 * post-render (locked) project (see lib/recompile-guard.ts's own advice to
 * duplicate rather than edit in place), and it is also how a read-only
 * admin acts on someone else's work: the source is read through the
 * RLS-respecting client (which admins can read via the `is_admin()`
 * policy), but the copy is always written with `user_id` set to the
 * *current* user, never the original owner. Assets and runs are
 * intentionally NOT copied — a duplicate starts clean. Copied scenes are
 * reset to 'draft' with their render-attempt columns nulled out so the new
 * project can be reframed and re-rendered from scratch.
 *
 * Every operator-authored project-level setting IS copied, though — script,
 * character, the six directorial fields from 0013_project_direction.sql,
 * include_visual_idea (0024 — the same kind of live, project-wide setting,
 * just added later) and render settings included. See
 * the exhaustive destructure below for the full column-by-column list and
 * why each one is copied or excluded; the short version is that this used
 * to copy only the 5 fields that existed the day this function was
 * written, so a duplicate silently reset to fal's defaults for model,
 * resolution and shooting mode instead of matching the project it was
 * copied from.
 */
export async function duplicateProject(id: string): Promise<void> {
  const { user } = await requireUser();
  const supabase = await createClient();

  const { data: sourceProject, error: sourceError } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .single();

  if (sourceError || !sourceProject) {
    throw new AuthorizationError(`Project ${id} not found or not readable by the current user.`);
  }

  const { data: sourceScenes, error: scenesError } = await supabase
    .from("scenes")
    .select("*")
    .eq("project_id", id)
    .order("idx", { ascending: true });

  if (scenesError) {
    throw new Error(`Failed to read scenes for project ${id}: ${scenesError.message}`);
  }

  // Every column of `projects`, named exactly once, so a migration that
  // adds a new one is a compile error here instead of a silent drop (this
  // is the bug being fixed: 0012/0013/0017/0021 each added a column and
  // this function kept copying only the original 5). Columns not copied
  // verbatim are bound to a throwaway `_`-prefixed name — ESLint's
  // varsIgnorePattern "^_" (eslint.config.mjs) is why that doesn't trip
  // no-unused-vars — and `rest` (the columns copied verbatim) is asserted
  // against `Record<string, never>` below: if a future column is left
  // unnamed here, `rest` picks it up with its real (non-`never`) type and
  // that assertion fails `tsc --noEmit`, forcing whoever added the column
  // to come here and make an explicit copy-or-exclude decision instead of
  // finding out months later that duplicates have been quietly wrong.
  //
  // Excluded, and why:
  //   id                   — must be fresh; this is a new row.
  //   user_id              — ownership belongs to whoever clicked
  //                           Duplicate, never the source owner (see this
  //                           function's own doc comment above).
  //   status               — a cache/fossil column even on the source row
  //                           (0018_derived_project_status.sql); set to
  //                           'draft' explicitly below, not copied.
  //   created_at,
  //   updated_at           — this row's own history; a duplicate's history
  //                           starts now, not when the source was made.
  //   cut_order_updated_at — same reasoning (0039_cut_order.sql): it marks
  //                           when THIS row's scenes.idx was last reordered,
  //                           not an operator-authored input. Copied scenes
  //                           are reset to 'draft' below anyway, so there is
  //                           no rendered cut for this timestamp to describe
  //                           yet — a fresh duplicate starts null, same as
  //                           any brand-new project.
  //   title                — copied, but not verbatim (" (copy)" appended
  //                           below), so it's named here to keep it out of
  //                           `rest` rather than lumped in with the
  //                           verbatim fields.
  //   source_character_id  — per 0021_project_character_source.sql:
  //                           "useCharacter is the only path that SETS
  //                           this column; every other write to
  //                           character_desc or the character reference
  //                           asset is a path that CLEARS it." Duplication
  //                           writes character_desc through a different
  //                           path, and — per this function's own doc
  //                           comment — does not copy assets at all, so
  //                           the new project would carry a label
  //                           claiming a character_ref photo it doesn't
  //                           have. Copying the label here would be
  //                           exactly the stale, misleading badge 0021
  //                           exists to prevent, so the new project starts
  //                           unlabeled, same as any project built from
  //                           scratch.
  //
  // Copied verbatim (`rest`): the two original day-one fields (script_raw,
  // character_desc) plus every field a migration has added since —
  // render_settings (0012), the six directorial columns (0013),
  // product_name (0017), include_visual_idea (0024, the operator's
  // master switch for scenes.visual_idea — see this function's doc comment)
  // and product_appearance (0041 — same operator-authored-input reasoning,
  // and the exact trap this comment warns about: a duplicate that dropped
  // it would silently paste a project whose product-shot scenes go back to
  // inventing packaging).
  // All are operator-authored inputs describing what should render, not
  // this row's own identity, lifecycle or render output — exactly what a
  // duplicate exists to preserve.
  //
  // kind (0064_project_kind.sql) is copied verbatim too, but for a
  // different reason than the fields above: it isn't operator-authored
  // input, it's what TYPE of project this is — the projects table's title
  // link routes on it ('clip' -> /ugc/<id>, 'scripted' -> /projects/<id>).
  // Leaving it out here would fall to the column's own DEFAULT
  // ('scripted'), so duplicating a clip project would silently hand back a
  // row that opens the scripted console instead of the clip one — wrong in
  // the same way an un-named column has always been wrong for this
  // function, just via the schema default instead of via `rest`.
  const {
    id: _id,
    user_id: _userId,
    status: _status,
    created_at: _createdAt,
    updated_at: _updatedAt,
    cut_order_updated_at: _cutOrderUpdatedAt,
    // 0060_final_versions.sql: which assembled cut the SOURCE project shows.
    // Deliberately not copied — the duplicate has no scenes rendered and no
    // final_versions rows of its own, so carrying this forward would point a
    // brand-new project at another project's mp4.
    active_final_version_id: _activeFinalVersionId,
    source_character_id: _sourceCharacterId,
    // 0057_description_edit_tracking.sql: when THIS project's own
    // character_desc/product_appearance last changed, compared against
    // THIS project's own generated portrait/composite asset. A duplicate
    // starts with neither asset, so there is nothing yet for either
    // timestamp to be stale against — carrying the source project's value
    // forward would just be a meaningless copy of an unrelated project's
    // edit history, not lifecycle/identity data worth preserving the way
    // character_desc/product_appearance's actual TEXT is below.
    character_desc_edited_at: _characterDescEditedAt,
    product_appearance_edited_at: _productAppearanceEditedAt,
    title: sourceTitle,
    script_raw,
    character_desc,
    render_settings,
    shooting_mode,
    camera_movement,
    visual_idea,
    voice_profile,
    pronunciation_guide,
    ugc_style,
    product_name,
    product_appearance,
    include_visual_idea,
    // Caption settings travel with the copy for the same reason the
    // direction columns do: they describe what should render, not this
    // row's identity or lifecycle. A duplicate that silently reverted to
    // the shipped purple would be a brand mismatch nobody asked for.
    captions_enabled,
    caption_box_color,
    caption_text_color,
    kind,
    // Never copied: a duplicate of the hidden personal project is an ordinary
    // project (the one-per-user index would refuse a second personal one).
    is_personal: _isPersonal,
    ...rest
  } = sourceProject;

  const _exhaustive: Record<string, never> = rest;

  const admin = createAdminClient();
  const { data: newProject, error: insertProjectError } = await admin
    .from("projects")
    .insert({
      user_id: user.id,
      title: `${sourceTitle} (copy)`,
      script_raw,
      character_desc,
      render_settings,
      shooting_mode,
      camera_movement,
      visual_idea,
      voice_profile,
      pronunciation_guide,
      ugc_style,
      product_name,
      product_appearance,
      include_visual_idea,
      captions_enabled,
      caption_box_color,
      caption_text_color,
      kind,
      status: "draft",
    })
    .select()
    .single();

  if (insertProjectError || !newProject) {
    throw new Error(
      `Failed to duplicate project: ${insertProjectError?.message ?? "unknown error"}`,
    );
  }

  const scenes: SceneRow[] = sourceScenes ?? [];
  if (scenes.length > 0) {
    const { error: insertScenesError } = await admin.from("scenes").insert(
      scenes.map((scene) => ({
        project_id: newProject.id,
        idx: scene.idx,
        script_line: scene.script_line,
        video_prompt: scene.video_prompt,
        // Carried forward like video_prompt/script_line above — this is
        // Claude's record of which visual idea shaped THIS scene's prompt
        // (0024_include_visual_idea_and_scene_visual_idea.sql), and the
        // duplicated scene's video_prompt is the same text that record
        // describes. Dropping it here would silently desync the two the
        // moment a duplicate is made, even though nothing actually changed.
        visual_idea: scene.visual_idea,
        is_talking_head: scene.is_talking_head,
        duration_s: scene.duration_s,
        template_id: scene.template_id,
        edited_by_human: scene.edited_by_human,
        status: "draft" as const,
        kie_task_id: null,
        submitted_at: null,
        ref_frame_asset_id: null,
      })),
    );

    if (insertScenesError) {
      throw new Error(`Failed to duplicate scenes: ${insertScenesError.message}`);
    }
  }

  revalidatePath("/projects");
  redirect(`/projects/${newProject.id}`);
}
