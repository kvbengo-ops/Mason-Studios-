"use server";

// The three narrow writes behind the split Setup screens — Character,
// Product and Script, each its own route with its own Save.
//
// These REPLACE actions/character.ts's saveCharacterSetup, which wrote every
// setup column in one update because every field lived on one page. Splitting
// the page without splitting the action would have broken immediately:
// saveCharacterSetup calls requireTitle AND requireScript on every save, so a
// Character form that (correctly) carries no script_raw would be refused for
// a field it does not own and cannot show.
//
// The obvious way around that — have each page carry the other pages' values
// as hidden inputs — is the one shape deliberately NOT taken. It reintroduces
// exactly the overwrite this codebase has now been bitten by twice (Apply
// replacing a hand-edited scene prompt; Accept replacing a description edited
// while the preview was open): a stale hidden value, rendered when the page
// loaded, silently winning over an edit made somewhere else since. Three
// actions that each touch only their own columns cannot do that, because
// there is no value present to lose.
//
// What each of them still shares, and why:
//
//   - requireProject, not requireProjectReadable. Every function here writes.
//     A non-owning admin can read these screens (the layout's guard allows
//     it) and must be refused here, which is the same boundary
//     saveCharacterSetup enforced.
//   - The delivered lock. Once a project is delivered, the operator's record
//     of what should have rendered is frozen; editing an input that produced
//     paid clips would leave the record describing something other than what
//     was made. Returned as { error }, never thrown — it is an ordinary state
//     the operator can act on (reopen the project), which is what
//     lib/action-result.ts reserves a returned error for.
//   - revalidatePath on the screen that was saved, plus anywhere the value is
//     quoted back. A price or a gate rendered from a stale cache is how an
//     operator ends up trusting a number nobody will honour.
//
// Title deliberately does NOT lock, and is deliberately NOT here: it feeds no
// prompt, no render and no cost, so renaming a delivered project is ordinary.
// It has its own write in actions/project.ts's updateProject.

import { revalidatePath } from "next/cache";
import { requireProject } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { requireScript } from "@/lib/script-guard";
import type { ActionResult } from "@/lib/action-result";

const LOCKED_MESSAGE =
  "This project has been delivered — reopen it before changing what should render.";

/**
 * Empty text is stored as null, never "". "Nothing set" and "set to nothing"
 * are the same fact for these fields, and every reader already tests them
 * with `?.trim()` or a null check; keeping a stored empty string as a third
 * state would give those readers something to disagree about.
 */
function textOrNull(value: FormDataEntryValue | null): string | null {
  return (typeof value === "string" ? value.trim() : "") || null;
}

/**
 * Character description only.
 *
 * source_character_id (0021_project_character_source.sql) is a label meaning
 * "this copy came from that library row", and it is only honest while the
 * copy still matches — so an actual change clears it. Re-saving identical
 * text must not: blanking an accurate label for a save that changed nothing
 * loses real provenance for free.
 *
 * character_desc_edited_at (0057) follows the same "did the VALUE change"
 * test rather than "was a save submitted", for a reason that cuts both ways:
 * marking an unchanged save would raise a staleness warning against a
 * portrait that still matches its description, and skipping a changed one
 * would leave a genuinely stale portrait looking current.
 */
export async function saveCharacter(projectId: string, formData: FormData): Promise<ActionResult> {
  const { project } = await requireProject(projectId);
  if (project.status === "delivered") {
    return { error: LOCKED_MESSAGE };
  }

  const characterDesc = textOrNull(formData.get("description"));
  const changed = characterDesc !== project.character_desc;
  const nowIso = new Date().toISOString();

  const admin = createAdminClient();
  const { error } = await admin
    .from("projects")
    .update({
      character_desc: characterDesc,
      updated_at: nowIso,
      ...(changed ? { source_character_id: null, character_desc_edited_at: nowIso } : {}),
    })
    .eq("id", projectId);

  if (error) {
    throw new Error(`Failed to save character: ${error.message}`);
  }

  revalidatePath(`/projects/${projectId}/character`);
}

/**
 * Product name and appearance.
 *
 * Two fields with two different readers, which is the whole reason this
 * screen exists apart from Character: the reference PHOTO is what the image
 * model conditions on, and product_appearance is what the compiler reads —
 * the compiler never sees the photo. When the two disagree, the text wins
 * silently, which is precisely how a lime-green pouch shipped described as
 * matte kraft paper.
 */
export async function saveProduct(projectId: string, formData: FormData): Promise<ActionResult> {
  const { project } = await requireProject(projectId);
  if (project.status === "delivered") {
    return { error: LOCKED_MESSAGE };
  }

  const productAppearance = textOrNull(formData.get("product_appearance"));
  const changed = productAppearance !== project.product_appearance;
  const nowIso = new Date().toISOString();

  const admin = createAdminClient();
  const { error } = await admin
    .from("projects")
    .update({
      product_name: textOrNull(formData.get("product_name")),
      product_appearance: productAppearance,
      updated_at: nowIso,
      ...(changed ? { product_appearance_edited_at: nowIso } : {}),
    })
    .eq("id", projectId);

  if (error) {
    throw new Error(`Failed to save product: ${error.message}`);
  }

  revalidatePath(`/projects/${projectId}/product`);
}

/**
 * The script — the gate everything downstream hangs off.
 *
 * Shares createProject's own non-empty check (lib/script-guard.ts) rather
 * than repeating one, so the two cannot drift into accepting different
 * scripts. Saving does NOT compile: compiling spends money and is its own
 * explicitly priced control, the same separation saveCharacterSetup drew
 * between saving a description and paying to regenerate a portrait from it.
 */
export async function saveScript(projectId: string, formData: FormData): Promise<ActionResult> {
  const { project } = await requireProject(projectId);
  if (project.status === "delivered") {
    return { error: LOCKED_MESSAGE };
  }

  const scriptResult = requireScript(formData.get("script_raw"));
  if ("error" in scriptResult) {
    return scriptResult;
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("projects")
    .update({
      script_raw: scriptResult.script,
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId);

  if (error) {
    throw new Error(`Failed to save script: ${error.message}`);
  }

  revalidatePath(`/projects/${projectId}/script`);
  // The Brief reads the compiled scenes, but its gate copy quotes whether a
  // script exists at all.
  revalidatePath(`/projects/${projectId}/brief`);
}
