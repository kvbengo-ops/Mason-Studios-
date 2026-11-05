"use server";

// Writes to projects.render_settings.compileModel — the compiler-model
// choice the Character page's picker (character-setup-form.tsx's
// CompileAction) persists per project, mirroring
// actions/render-settings.ts's updateRenderSettings for the video model.
//
// Same two rules that file's header states, applied to the compiler side:
//   1. Validate before writing — CompilerModelIdSchema (lib/models.ts) is
//      the only thing standing between this jsonb key and an arbitrary
//      string, since the column has no CHECK constraint.
//   2. Preserve the OTHER half of the blob on write. render_settings is one
//      jsonb value shared with the video RenderSettings fields
//      (model/resolution/fps) — see updateRenderSettings's own comment for
//      the mirror image of this problem. Spread the column's current raw
//      contents first so a compiler-model save never wipes out whatever
//      resolution/fps the operator already chose on the Render gate.
//
// Deliberately NOT locked to draft/frame_ready the way updateRenderSettings
// is: choosing a compiler model only affects the NEXT compile, and compiling
// itself is already refused once scenes have progressed past draft/frame_ready
// (assertRecompilable, actions/compile.ts) — there is nothing here for a
// lock to protect that isn't already protected one step downstream.
//
// THIS is the only write path for render_settings.compileModel. There used
// to be a second one — actions/render-settings.ts's updateCompilerModel,
// which the Render settings card's own compile picker called. Same jsonb
// key, two functions, two separate validation rules (this file's
// CompilerModelIdSchema vs. that one's COMPILER_MODELS membership check),
// written independently and never reconciled. It existed because the compile
// picker itself was duplicated — one copy on the Render settings card
// (priced per-ad in a card of per-second choices, on a route that never
// compiles anything), one here beside the Compile button that actually
// spends it. Removing the Render settings copy removed its action too. If a
// second compiler-model control shows up again anywhere, wire it to
// updateCompileModel below — do not write a third function against this key.

import { revalidatePath } from "next/cache";
import { requireProject } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { CompilerModelIdSchema } from "@/lib/models";
import type { ActionResult } from "@/lib/action-result";

/**
 * Persists a project's compiler-model choice. Takes the bare model id
 * (not FormData) for the same reason updateRenderSettings does: the caller
 * is a client component reacting to a button click, not a form submission.
 */
export async function updateCompileModel(
  projectId: string,
  modelId: string,
): Promise<ActionResult> {
  const { project } = await requireProject(projectId);

  const parsed = CompilerModelIdSchema.safeParse(modelId);
  if (!parsed.success) {
    return {
      error: `Invalid compiler model: ${parsed.error.issues.map((issue) => issue.message).join(" ")}`,
    };
  }

  const currentRaw: Record<string, unknown> =
    typeof project.render_settings === "object" && project.render_settings !== null
      ? (project.render_settings as Record<string, unknown>)
      : {};

  const admin = createAdminClient();
  const { error } = await admin
    .from("projects")
    .update({
      render_settings: { ...currentRaw, compileModel: parsed.data },
      updated_at: new Date().toISOString(),
    })
    .eq("id", project.id);

  if (error) {
    throw new Error(`Failed to save compiler model: ${error.message}`);
  }

  revalidatePath(`/projects/${project.id}/character`);
}
