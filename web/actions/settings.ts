"use server";

// The two writes settings/page.tsx's own fields need, beyond the render
// settings actions/render-settings.ts already owns:
//
//   - saveTitle: adapts actions/project.ts's updateProject (a plain `(id,
//     fields)` call, not a Server Action FormData handler on its own) to
//     the `(id, formData) => Promise<ActionResult | void>` shape ActionForm
//     requires. Title never locks — same asymmetry the old, unsplit
//     Character Setup page's TitleField documented: it feeds no prompt, no
//     render, no cost, so renaming a delivered project is ordinary.
//
//   - saveDirection: the six lib/direction.ts columns (formerly folded into
//     actions/character.ts's now-removed saveCharacterSetup) plus the three
//     caption columns (0049). Moved here, off the split Character/Product/
//     Script pages, because they're project-wide defaults — the same
//     category as render settings, not something any one of the three
//     split pages individually owns. See this feature's task for why this
//     write couldn't just stay wherever it landed on whichever page: three
//     narrow actions that each touch only their own columns (actions/
//     setup.ts) is the whole point of the split, and a fourth set of
//     columns bolted onto any one of them would be the exact "field that
//     appears to save on the wrong page" confusion the split exists to
//     avoid.

import { revalidatePath } from "next/cache";
import { requireProject } from "@/actions/guard";
import { updateProject } from "@/actions/project";
import { createAdminClient } from "@/lib/supabase/server";
import { requireTitle } from "@/lib/title-guard";
import { DirectionSchema } from "@/lib/direction";
import { CaptionStyleSchema } from "@/lib/caption-style";
import type { ActionResult } from "@/lib/action-result";

const LOCKED_MESSAGE =
  "This project has been delivered — reopen it before changing what should render.";

/** Adapts updateProject's `(id, fields)` shape to the `(id, formData)` shape ActionForm submits. */
export async function saveTitle(projectId: string, formData: FormData): Promise<ActionResult> {
  const titleResult = requireTitle(formData.get("title"));
  if ("error" in titleResult) {
    return titleResult;
  }
  return updateProject(projectId, { title: titleResult.title });
}

/**
 * Reads the seven lib/direction.ts fields off a submitted FormData — same
 * shape actions/character.ts's now-removed directionFromFormData used. A
 * checkbox that is unchecked (or unmounted — see ShootingModeFields) sends
 * no entry at all, so `camera_movement` and `include_visual_idea` are read
 * as "was the key present" rather than parsed from their value.
 */
function directionFromFormData(formData: FormData): unknown {
  return {
    shooting_mode: formData.get("shooting_mode") ?? undefined,
    camera_movement: formData.get("camera_movement") != null,
    visual_idea: formData.get("visual_idea") ?? "",
    voice_profile: formData.get("voice_profile") ?? "",
    pronunciation_guide: formData.get("pronunciation_guide") ?? "",
    ugc_style: formData.get("ugc_style") ?? undefined,
    include_visual_idea: formData.get("include_visual_idea") != null,
  };
}

/**
 * Saves the six directorial columns and the three caption columns in one
 * write — same "one Save, one moment the page is saved" reasoning the old
 * saveCharacterSetup used, scoped down to just the fields this page owns.
 */
export async function saveDirection(projectId: string, formData: FormData): Promise<ActionResult> {
  const { project } = await requireProject(projectId);
  if (project.status === "delivered") {
    return { error: LOCKED_MESSAGE };
  }

  const parsedDirection = DirectionSchema.safeParse(directionFromFormData(formData));
  if (!parsedDirection.success) {
    const issue = parsedDirection.error.issues[0];
    if (!issue) {
      return { error: "Invalid direction." };
    }
    const field = issue.path.length > 0 ? issue.path.join(".") : "direction";
    return { error: `${field}: ${issue.message}` };
  }

  const parsedCaptions = CaptionStyleSchema.safeParse({
    captions_enabled: formData.get("captions_enabled") != null,
    caption_box_color: formData.get("caption_box_color") ?? undefined,
    caption_text_color: formData.get("caption_text_color") ?? undefined,
  });
  if (!parsedCaptions.success) {
    const issue = parsedCaptions.error.issues[0];
    if (!issue) {
      return { error: "Invalid caption settings." };
    }
    return { error: issue.message };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("projects")
    .update({
      ...parsedDirection.data,
      ...parsedCaptions.data,
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId);

  if (error) {
    throw new Error(`Failed to save direction settings: ${error.message}`);
  }

  revalidatePath(`/projects/${projectId}/settings`);
}
