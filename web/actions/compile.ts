"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireProject } from "@/actions/guard";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { compileBrief, CLAUDE_VENDOR } from "@/lib/claude";
import { assertRecompilable } from "@/lib/recompile-guard";
import { assertHasCharacter } from "@/lib/compile-guard";
import { auditProductCoverage } from "@/lib/reference-selection";
import { guardResult, type ActionResult } from "@/lib/action-result";
import {
  parseTwoColumnScript,
  scriptRowsHaveVisualIdea,
  scriptTextFromRows,
} from "@/lib/script-columns";
import { parseCompilerModel } from "@/lib/models";
import { assertWithinSpendCaps } from "@/lib/spend";
import { recordRun } from "@/lib/runs";
import type { Database } from "@/types/db";

const TEMPLATE_NAME = "ugc-v1";

/**
 * The compiler's "does a product exist at all" signal (see
 * CompileBriefArgs.hasProduct in lib/claude.ts). product_name alone isn't
 * enough — the character step lets an operator upload a product/composite
 * reference image before ever typing a name for it — so this also checks
 * for a product_ref or composite_ref asset row, same kind list
 * actions/frames.ts's loadConditioningRefs reads for the same project.
 * Runs on the RLS-scoped client, not admin: this only reads, and runCompile
 * already ran requireProject to confirm the caller owns projectId.
 */
async function projectHasProduct(
  supabase: SupabaseClient<Database>,
  projectId: string,
  productName: string | null,
): Promise<boolean> {
  if (productName && productName.trim().length > 0) {
    return true;
  }
  const { data, error } = await supabase
    .from("assets")
    .select("id")
    .eq("project_id", projectId)
    .in("kind", ["product_ref", "composite_ref"])
    .limit(1);

  if (error) {
    throw new Error(`Failed to check product assets for project ${projectId}: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Whether the project has an uploaded/generated character reference photo
 * — the second input assertHasCharacter (lib/compile-guard.ts) checks,
 * alongside a typed character_desc. A photo alone no longer satisfies the
 * guard on its own: it must be paired with a description, since an
 * undescribed photo is exactly the combination that let Claude invent a
 * mismatched character (see assertHasCharacter's doc comment). Same kind
 * list and same RLS-scoped client as projectHasProduct above, for the same
 * reason.
 */
async function projectHasCharacterRefAsset(
  supabase: SupabaseClient<Database>,
  projectId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("assets")
    .select("id")
    .eq("project_id", projectId)
    .eq("kind", "character_ref")
    .limit(1);

  if (error) {
    throw new Error(`Failed to check character assets for project ${projectId}: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Exported so actions/brief.ts's Apply/Split (compileScene calls) load the
 * exact same system prompt a full compile uses, rather than a second copy of
 * this query drifting to a different template version over time.
 */
export async function loadLatestTemplate(): Promise<{ id: string; body: string }> {
  const supabase = await createClient();
  const { data: template, error } = await supabase
    .from("prompt_templates")
    .select("id, body")
    .eq("name", TEMPLATE_NAME)
    .order("version", { ascending: false })
    .limit(1)
    .single();

  if (error || !template) {
    throw new Error(
      `Failed to load prompt template '${TEMPLATE_NAME}': ${error?.message ?? "no rows found"}.`,
    );
  }

  return template;
}

async function runCompile(projectId: string): Promise<ActionResult> {
  const { user, profile, project } = await requireProject(projectId);

  const script = project.script_raw?.trim();
  if (!script) {
    return { error: "Project has no script to compile." };
  }

  const supabase = await createClient();
  const hasCharacterRefAsset = await projectHasCharacterRefAsset(supabase, projectId);
  const characterResult = guardResult(() =>
    assertHasCharacter(!!project.character_desc?.trim(), hasCharacterRefAsset),
  );
  if (characterResult) return characterResult;

  const template = await loadLatestTemplate();
  const hasProduct = await projectHasProduct(supabase, projectId, project.product_name);

  // SMN-feature-spec.md §3.3's two-column Script | Visual Idea input
  // (lib/script-columns.ts). Parsed fresh from script_raw on every compile
  // rather than read from a persisted column — script_raw is already the
  // single source of truth for the script, and re-parsing it here is both
  // cheap (a pure, synchronous function over a string already in memory)
  // and the only way this can never drift from what the operator most
  // recently saved. See 0024_include_visual_idea_and_scene_visual_idea.sql
  // for the fuller version of this argument.
  //
  // `rows` only actually changes what gets sent to Claude when at least one
  // row carries a visual idea — scriptRowsHaveVisualIdea is what tells a
  // plain single-column script (every project before this feature existed,
  // and the common case going forward) apart from a genuine two-column
  // paste. Below that check, `script` is passed through untouched, byte for
  // byte, exactly as it always was.
  const rows = parseTwoColumnScript(script);
  const isTwoColumn = scriptRowsHaveVisualIdea(rows);

  // The project's own compiler-model choice (Character page picker,
  // actions/compiler-model.ts) — resolved to Haiku if never set or if the
  // stored value names a disabled/unknown descriptor (parseCompilerModel's
  // own doc comment, lib/models.ts). Read once and reused below for the
  // spend-cap check, the actual compileBrief call, AND the `runs` row, so
  // the quoted price, the enforced price, and the model that actually ran
  // can never drift apart the way the project's own docs warn this class of
  // bug has already shipped once.
  const compilerModel = parseCompilerModel(project.render_settings);

  // Checked before the Claude call, priced on the selected model's own flat
  // ceiling (compilerModel.costUsd) — same "check first, spend nothing on
  // refusal" shape every render/image path in this codebase already uses.
  const capResult = await assertWithinSpendCaps(user.id, profile, compilerModel.costUsd);
  if (capResult) return capResult;

  const claudeModel = compilerModel.id;
  let brief: Awaited<ReturnType<typeof compileBrief>>;
  try {
    brief = await compileBrief({
      // scriptTextFromRows rebuilds a clean, delimiter-free script from just
      // the `.script` cells — Claude must never see raw tab/pipe characters
      // or unlabeled visual-idea text sitting inside what is supposed to be
      // spoken dialogue. This rebuild happens regardless of
      // include_visual_idea below: that flag controls whether the visual
      // ideas are used as a directive, not whether the script text itself
      // gets cleaned of delimiter noise.
      script: isTwoColumn ? scriptTextFromRows(rows) : script,
      scriptRows: isTwoColumn ? rows : undefined,
      characterDesc: project.character_desc ?? undefined,
      productName: project.product_name ?? undefined,
      productAppearance: project.product_appearance ?? undefined,
      hasProduct,
      templateBody: template.body,
      // Explicit, not left to compileBrief's own defaultClaudeModel()
      // fallback — this project has already resolved its choice above, and
      // passing it through here is what makes claudeModel (recorded below,
      // in both the success and failure paths) name the model that
      // actually ran rather than a second, separately-derived guess.
      model: claudeModel,
      direction: {
        shooting_mode: project.shooting_mode,
        camera_movement: project.camera_movement,
        visual_idea: project.visual_idea ?? "",
        voice_profile: project.voice_profile ?? "",
        pronunciation_guide: project.pronunciation_guide ?? "",
        ugc_style: project.ugc_style,
        include_visual_idea: project.include_visual_idea,
      },
    });
  } catch (err) {
    // Record the attempt even though it failed. costUsd is null, not a
    // guess: the Anthropic SDK call above can fail before any tokens are
    // generated (a validation error) or after (a truncation/parse failure —
    // see compileBrief's own "did not return parseable structured output"
    // throw), and this codebase has no reliable way to tell those apart
    // from here, the same honesty this task's write-up asks for on the
    // fal-image-generation side (lib/fal.ts's generateImage has the
    // identical problem — see actions/frames.ts's own recordRun call for
    // the mirrored comment).
    await recordRun({
      projectId,
      vendor: CLAUDE_VENDOR,
      model: claudeModel,
      costUsd: null,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  await recordRun({
    projectId,
    vendor: CLAUDE_VENDOR,
    model: claudeModel,
    costUsd: compilerModel.costUsd,
  });

  // Advisory only — see auditProductCoverage's doc comment for why this
  // logs instead of throwing. A server log is enough to catch a repeat of
  // the coffee-ad incident in the wild without turning a legitimate
  // all-talking-head compile into a dead end for the operator.
  const coverageWarning = auditProductCoverage(brief.scenes, hasProduct);
  if (coverageWarning) {
    console.warn(coverageWarning, { projectId });
  }

  const admin = createAdminClient();

  const { error: deleteError } = await admin.from("scenes").delete().eq("project_id", projectId);
  if (deleteError) {
    throw new Error(`Failed to clear existing scenes: ${deleteError.message}`);
  }

  const { error: insertError } = await admin.from("scenes").insert(
    brief.scenes.map((scene, idx) => ({
      project_id: projectId,
      idx,
      script_line: scene.script_line,
      video_prompt: scene.video_prompt,
      is_talking_head: scene.is_talking_head,
      duration_s: scene.duration_s,
      // Claude's own echo of which operator-authored visual idea (if any)
      // shaped this scene — see Brief.scenes[].visual_idea's doc comment
      // in lib/claude.ts. `?? null`, not left undefined: every scene from
      // a compile that never sent a visual-idea section (single-column
      // script, or include_visual_idea off) gets an explicit null here,
      // same as the column's own default.
      visual_idea: scene.visual_idea ?? null,
      template_id: template.id,
      edited_by_human: false,
      status: "draft" as const,
    })),
  );

  if (insertError) {
    throw new Error(`Failed to insert compiled scenes: ${insertError.message}`);
  }

  // Cache write only — nothing reads this back as truth. lib/project-status.ts's
  // deriveProjectStatus() recomputes the real status from `scenes` on every
  // read (see 0018_derived_project_status.sql for why: this column never got
  // a writer for 'complete', so trusting it left finished projects showing
  // as 'rendering' forever). Kept for a human skimming the table in the DB
  // dashboard, not for the app.
  const { error: statusError } = await admin
    .from("projects")
    .update({ status: "briefed", updated_at: new Date().toISOString() })
    .eq("id", projectId);

  if (statusError) {
    throw new Error(`Failed to update project status: ${statusError.message}`);
  }

  revalidatePath(`/projects/${projectId}`);
}

/**
 * Where an operator belongs the moment a compile finishes: inside the first
 * scene it produced.
 *
 * Both compile paths used to land on /brief, a review gate that made sense
 * when the brief was a table you approved before anything else could
 * happen. The work is per-scene now — one screen holding a scene's frame,
 * prompt and clip — and the rail has no Brief row, so the gate had become a
 * stop on the way to the place you were always going.
 *
 * Falls back to /brief when the compile produced nothing to open. That is
 * not an ordinary state (a compile that returns no scenes has failed
 * somewhere upstream), but redirecting into a scene id that does not exist
 * would turn it into a 404 instead of a page that can explain itself.
 */
async function redirectToFirstScene(projectId: string): Promise<never> {
  const supabase = await createClient();
  const { data: first } = await supabase
    .from("scenes")
    .select("id")
    .eq("project_id", projectId)
    .order("idx", { ascending: true })
    .limit(1)
    .maybeSingle();

  redirect(first ? `/projects/${projectId}/scenes/${first.id}` : `/projects/${projectId}/brief`);
}

/**
 * Splits `projects.script_raw` into scenes via Claude (see
 * docs/architecture.md § "The prompt compiler") and lands the operator in
 * the first scene it produced. Always safe to call on a fresh/draft project
 * since no scenes exist yet to destroy.
 */
export async function compileScript(projectId: string): Promise<ActionResult> {
  const result = await runCompile(projectId);
  if (result?.error) return result;
  await redirectToFirstScene(projectId);
}

/**
 * Re-compiles a project's script, refusing if any scene has progressed
 * past draft/frame_ready — see assertRecompilable.
 */
export async function recompile(projectId: string): Promise<ActionResult> {
  const { project } = await requireProject(projectId);
  const supabase = await createClient();

  const { data: scenes, error } = await supabase
    .from("scenes")
    .select("status")
    .eq("project_id", project.id);

  if (error) {
    throw new Error(`Failed to load scenes for project ${project.id}: ${error.message}`);
  }

  const recompilableResult = guardResult(() => assertRecompilable(scenes ?? []));
  if (recompilableResult) return recompilableResult;

  const result = await runCompile(projectId);
  if (result?.error) return result;
  await redirectToFirstScene(projectId);
}
