"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/actions/guard";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { elementUploadNameError } from "@/lib/element-upload-name";
import {
  buildUserStorageKey,
  copyStorageObject,
  extFromFilename,
  removeStorageObjects,
} from "@/lib/storage";
import { formatFileSizeMB, MAX_REFERENCE_VIDEO_BYTES } from "@/lib/file-type";
import type { ActionResult, ActionNotice } from "@/lib/action-result";

export async function saveGeneratedElement(
  formData: FormData,
): Promise<ActionResult | ActionNotice> {
  const { user } = await requireUser();
  const assetId = String(formData.get("assetId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const destination = formData.get("destination");
  if (destination !== "shared" && destination !== "mine")
    return { error: "Choose Shared or Mine." };
  const shared = destination === "shared";
  const session = await createClient();
  const { data: source, error: sourceError } = await session
    .from("assets")
    .select("id, user_id, project_id, storage_key, bytes, kind, duration_s")
    .eq("id", assetId)
    // A finished /ugc clip dragged onto the video bar becomes a video element,
    // the same as an uploaded MP4 (registerElement's video_ref path).
    .in("kind", ["generated_image", "clip"])
    .is("deleted_at", null)
    .maybeSingle();
  if (sourceError || !source)
    return { error: "That generated image or clip is no longer available." };
  const isClip = source.kind === "clip";
  if (isClip) {
    // Priced by its length, like an uploaded video; ingest records both.
    if (source.duration_s === null) return { error: "That clip's length was never measured." };
    if (typeof source.bytes !== "number" || source.bytes > MAX_REFERENCE_VIDEO_BYTES)
      return {
        error: `That clip is over the ${formatFileSizeMB(MAX_REFERENCE_VIDEO_BYTES)} video reference limit.`,
      };
  }
  if (source.project_id) {
    const { data: project } = await session
      .from("projects")
      .select("id")
      .eq("id", source.project_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!project) return { error: "You can only save your own generated images and clips." };
  } else if (source.user_id !== user.id) {
    return { error: "You can only save your own generated images and clips." };
  }
  const admin = createAdminClient();
  const nameError = await elementUploadNameError(admin, user.id, name, shared);
  if (nameError) return { error: nameError };
  // A separate reference survives deletion of the generated image from history
  // (and a clip's 14-day expiry).
  const assetKind = isClip ? "video_ref" : "ref_frame";
  const storageKey = buildUserStorageKey({
    userId: user.id,
    kind: assetKind,
    ext: extFromFilename(source.storage_key, isClip ? "mp4" : "png"),
  });
  await copyStorageObject(source.storage_key, storageKey);
  let copiedAssetId: string | undefined;
  try {
    const { data: asset, error: assetError } = await admin
      .from("assets")
      .insert({
        user_id: user.id,
        project_id: null,
        kind: assetKind,
        storage_key: storageKey,
        bytes: source.bytes,
        duration_s: isClip ? source.duration_s : null,
      })
      .select("id")
      .single();
    if (assetError || !asset) throw new Error("Could not save the reference image.");
    copiedAssetId = asset.id;
    const { error } = await admin.from("elements").insert({
      user_id: user.id,
      asset_id: asset.id,
      name,
      category: isClip ? "video" : "image",
      is_shared: shared,
    });
    if (error)
      throw new Error(
        error.code === "23505"
          ? `@${name} is already used. Choose another tag.`
          : "Could not save the element.",
      );
  } catch (error) {
    try {
      await removeStorageObjects([storageKey]);
      if (copiedAssetId) {
        const { error: cleanupError } = await admin.from("assets").delete().eq("id", copiedAssetId);
        if (cleanupError) throw cleanupError;
      }
    } catch (cleanupError) {
      console.warn("saveGeneratedElement: cleanup failed", cleanupError);
    }
    return { error: error instanceof Error ? error.message : "Could not save the element." };
  }
  revalidatePath("/elements");
  revalidatePath("/image-generator");
  revalidatePath("/ugc/[id]", "page");
  revalidatePath("/images/[id]", "page");
  return { notice: `Saved @${name} to ${shared ? "Shared" : "Mine"}.` };
}
