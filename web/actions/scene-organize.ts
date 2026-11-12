"use server";

// Organising the project studio (/ugc/[id]): naming a scene, dragging it into
// place, and the comment thread on it (0142).
//
// None of these touch scenes.status — that contract belongs to generate and
// the worker. Naming and ordering are the OWNER's writes (requireScene /
// requireProject). Commenting is the one write a non-owning admin may make
// on a project, so it takes requireProjectReadable and nothing else here does.

import { revalidatePath } from "next/cache";
import { requireProject, requireProjectReadable, requireScene } from "@/actions/guard";
import type { ActionResult } from "@/lib/action-result";
import {
  MAX_SCENE_COMMENT_CHARS,
  MAX_SCENE_TITLE_CHARS,
  reassignPositions,
} from "@/lib/scene-position";
import { createAdminClient } from "@/lib/supabase/server";

/** Names a scene, or clears the name when `title` is blank. */
export async function renameScene(formData: FormData): Promise<ActionResult> {
  const sceneId = String(formData.get("sceneId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!sceneId) return { error: "Missing scene." };
  if (title.length > MAX_SCENE_TITLE_CHARS) {
    return { error: `A scene name holds at most ${MAX_SCENE_TITLE_CHARS} characters.` };
  }

  const { scene } = await requireScene(sceneId);

  const { error } = await createAdminClient()
    .from("scenes")
    .update({ title: title || null })
    .eq("id", scene.id);
  if (error) throw new Error(`Failed to rename the scene: ${error.message}`);

  revalidatePath(`/ugc/${scene.project_id}`);
  return undefined;
}

/**
 * Saves the strip's order after a drag. `sceneIds` is every scene the strip
 * lists, in its new order. Only `position` is written — idx never changes.
 */
export async function reorderStudioScenes(
  projectId: string,
  sceneIds: readonly string[],
): Promise<ActionResult> {
  const { project } = await requireProject(projectId);
  if (sceneIds.length === 0 || sceneIds.length > 200) return { error: "Nothing to reorder." };

  const admin = createAdminClient();
  // Scoped to the project: an id from another project matches no row, and
  // reassignPositions then refuses the whole order.
  const { data: rows, error: readError } = await admin
    .from("scenes")
    .select("id, idx, position")
    .eq("project_id", project.id)
    .in("id", [...sceneIds]);
  if (readError) throw new Error(`Failed to read the scenes: ${readError.message}`);

  const next = reassignPositions(rows ?? [], sceneIds);
  if (!next) return { error: "The scenes changed. Reload and try again." };

  const results = await Promise.all(
    next.map(({ id, position }) =>
      admin.from("scenes").update({ position }).eq("id", id).eq("project_id", project.id),
    ),
  );
  const failed = results.find((result) => result.error);
  if (failed?.error) throw new Error(`Failed to save the scene order: ${failed.error.message}`);

  revalidatePath(`/ugc/${project.id}`);
  return undefined;
}

/** Posts a comment on a scene. The project's owner and admins may. */
export async function addSceneComment(formData: FormData): Promise<ActionResult> {
  const projectId = String(formData.get("projectId") ?? "");
  const sceneId = String(formData.get("sceneId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!projectId || !sceneId) return { error: "Missing scene." };

  // Readable, not requireProject: a comment is how an admin, read-only on the
  // project otherwise, leaves feedback on it.
  const { user, project } = await requireProjectReadable(projectId);

  if (!body) return { error: "Write a comment first." };
  if (body.length > MAX_SCENE_COMMENT_CHARS) {
    return { error: `A comment holds at most ${MAX_SCENE_COMMENT_CHARS} characters.` };
  }

  const admin = createAdminClient();
  // The guard proved the PROJECT; this proves the scene is one of its own.
  const { data: scene, error: readError } = await admin
    .from("scenes")
    .select("id")
    .eq("id", sceneId)
    .eq("project_id", project.id)
    .maybeSingle();
  if (readError) throw new Error(`Failed to read the scene: ${readError.message}`);
  if (!scene) return { error: "That scene is not in this project." };

  const { error } = await admin
    .from("scene_comments")
    .insert({ scene_id: scene.id, user_id: user.id, body });
  if (error) throw new Error(`Failed to post the comment: ${error.message}`);

  revalidatePath(`/ugc/${project.id}`);
  return undefined;
}

/** Deletes one of the caller's OWN comments. */
export async function deleteSceneComment(formData: FormData): Promise<ActionResult> {
  const projectId = String(formData.get("projectId") ?? "");
  const commentId = String(formData.get("commentId") ?? "");
  if (!projectId || !commentId) return { error: "Missing comment." };

  const { user, project } = await requireProjectReadable(projectId);

  // The author filter is the authorization: nobody removes another's comment.
  const { data: deleted, error } = await createAdminClient()
    .from("scene_comments")
    .delete()
    .eq("id", commentId)
    .eq("user_id", user.id)
    .select("id");
  if (error) throw new Error(`Failed to delete the comment: ${error.message}`);
  if (!deleted?.length) return { error: "That comment is not yours to delete." };

  revalidatePath(`/ugc/${project.id}`);
  return undefined;
}
