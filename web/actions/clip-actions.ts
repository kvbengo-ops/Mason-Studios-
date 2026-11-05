"use server";

// /create's Video wall: Share and Add to project for one take. Save to
// elements needs no action of its own — the tile stages the clip's bytes and
// calls registerElement, so every element rule (size, describe, caps) holds.

import { revalidatePath } from "next/cache";
import { requireProject, requireScene } from "@/actions/guard";
import type { ActionResult } from "@/lib/action-result";
import { signedUrl } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/server";

/** How long a shared link works. The page's own links last an hour. */
const SHARE_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

/** A 7-day link to one take. Owner-only through requireScene. */
export async function shareClipLink(
  sceneId: string,
  versionId: string,
): Promise<{ url: string } | { error: string }> {
  const { scene } = await requireScene(sceneId);
  const admin = createAdminClient();
  const { data: version } = await admin
    .from("scene_versions")
    .select("clip_asset_id")
    .eq("id", versionId)
    .eq("scene_id", scene.id)
    .maybeSingle();
  const { data: asset } = version?.clip_asset_id
    ? await admin.from("assets").select("storage_key").eq("id", version.clip_asset_id).maybeSingle()
    : { data: null };
  if (!asset) return { error: "That take is no longer available." };
  return { url: await signedUrl(asset.storage_key, SHARE_LINK_TTL_SECONDS) };
}

/**
 * Moves a clip (every take of its scene) into another of the caller's /ugc
 * projects, or into a new one when projectId is "new".
 *
 * Both ends are owner-guarded: requireScene for the source, requireProject for
 * an existing target. The scene's assets move with it, and the database keeps
 * its run rows attributed to the scene's current project so project totals
 * follow the clip. The owner is the same either way.
 */
export async function moveClipToProject(formData: FormData): Promise<ActionResult> {
  const sceneId = String(formData.get("sceneId") ?? "");
  const target = String(formData.get("projectId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!sceneId || !target) return { error: "Pick a project." };

  const { user, scene } = await requireScene(sceneId);
  if (scene.status === "queued" || scene.status === "rendering") {
    return { error: "This clip is still rendering. Move it once it has finished." };
  }

  const admin = createAdminClient();
  let targetId: string;
  if (target === "new") {
    if (!title) return { error: "Name the new project." };
    if (title.length > 120) return { error: "Keep the project name under 120 characters." };
    const { data: created, error } = await admin
      .from("projects")
      // kind "clip": opens in the clip console, like createClipProject's.
      .insert({ user_id: user.id, title, kind: "clip" })
      .select("id")
      .single();
    if (error || !created) throw new Error(`Failed to create the project: ${error?.message}`);
    targetId = created.id;
  } else {
    const { project } = await requireProject(target);
    if (project.kind !== "clip" || project.is_personal) {
      return { error: "Clips can only move into a clip project." };
    }
    targetId = project.id;
  }
  if (targetId === scene.project_id) return { error: "The clip is already in that project." };

  // scenes has `unique (project_id, idx)`: max+1, the rule generateClip uses.
  const { data: last, error: idxError } = await admin
    .from("scenes")
    .select("idx")
    .eq("project_id", targetId)
    .order("idx", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (idxError) throw new Error(`Failed to read the last scene index: ${idxError.message}`);

  const [{ data: versions }, { data: references }] = await Promise.all([
    admin.from("scene_versions").select("clip_asset_id").eq("scene_id", scene.id),
    admin.from("scene_references").select("asset_id").eq("scene_id", scene.id),
  ]);
  const assetIds = [
    ...(versions ?? []).map((v) => v.clip_asset_id),
    ...(references ?? []).map((r) => r.asset_id),
    scene.ref_frame_asset_id,
  ].filter((id): id is string => typeof id === "string");

  const { error: moveError } = await admin
    .from("scenes")
    .update({ project_id: targetId, idx: (last?.idx ?? 0) + 1 })
    .eq("id", scene.id);
  if (moveError) throw new Error(`Failed to move the clip: ${moveError.message}`);

  if (assetIds.length > 0) {
    // Only rows the old project owned: an element's asset is user-scoped and
    // must not be pulled into a project.
    const { error: assetError } = await admin
      .from("assets")
      .update({ project_id: targetId })
      .in("id", assetIds)
      .eq("project_id", scene.project_id);
    if (assetError) throw new Error(`Failed to move the clip's files: ${assetError.message}`);
  }

  revalidatePath(`/ugc/${scene.project_id}`);
  revalidatePath(`/ugc/${targetId}`);
  revalidatePath("/create");
  revalidatePath("/projects");
  return undefined;
}
