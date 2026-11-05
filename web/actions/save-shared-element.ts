"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/actions/guard";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import {
  buildUserStorageKey,
  copyStorageObject,
  extFromFilename,
  removeStorageObjects,
} from "@/lib/storage";
import type { ActionNotice, ActionResult } from "@/lib/action-result";

/** Copy a shared reference into the caller's own @tag vocabulary, without a vendor call. */
export async function saveSharedElement(elementId: string): Promise<ActionResult | ActionNotice> {
  const { user } = await requireUser();
  // Session reads retain the shared-library RLS and asset-provenance checks.
  // The caller supplies only an element id, never a storage key or destination owner.
  const session = await createClient();
  const { data: element, error: readError } = await session
    .from("elements")
    .select("id, user_id, name, category, description, ai_description, asset_id")
    .eq("id", elementId)
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) throw new Error(`Failed to read shared reference: ${readError.message}`);
  if (!element) return { error: "That shared reference is no longer available." };
  if (element.user_id === user.id)
    return { notice: `This reference is already yours: @${element.name}.` };

  const { data: ownElements, error: namesError } = await session
    .from("elements")
    .select("name")
    .eq("user_id", user.id)
    .is("deleted_at", null);
  if (namesError) throw new Error(`Failed to check your references: ${namesError.message}`);
  if (ownElements?.some((own) => own.name.toLowerCase() === element.name.toLowerCase())) {
    return {
      error: `You already have @${element.name}. Rename your existing reference first, or use the one you have.`,
    };
  }

  const { data: source, error: assetReadError } = await session
    .from("assets")
    .select("storage_key, kind, bytes, duration_s")
    .eq("id", element.asset_id)
    .maybeSingle();
  if (assetReadError) throw new Error(`Failed to read shared asset: ${assetReadError.message}`);
  if (!source) return { error: "That shared reference's file is no longer available." };

  const storageKey = buildUserStorageKey({
    userId: user.id,
    kind: source.kind,
    ext: extFromFilename(
      source.storage_key,
      source.kind === "audio" ? "mp3" : source.kind === "video_ref" ? "mp4" : "jpg",
    ),
  });
  await copyStorageObject(source.storage_key, storageKey);
  const admin = createAdminClient();
  let copiedAssetId: string | undefined;
  try {
    const { data: asset, error: assetError } = await admin
      .from("assets")
      .insert({
        user_id: user.id,
        project_id: null,
        kind: source.kind,
        storage_key: storageKey,
        bytes: source.bytes,
        duration_s: source.duration_s,
      })
      .select("id")
      .single();
    if (assetError || !asset)
      throw new Error(`Failed to save copied asset: ${assetError?.message ?? "no row"}`);
    copiedAssetId = asset.id;
    const { error } = await admin.from("elements").insert({
      user_id: user.id,
      name: element.name,
      category: element.category,
      description: element.description,
      ai_description: element.ai_description,
      asset_id: asset.id,
      is_shared: false,
    });
    if (error)
      throw new Error(
        error.code === "23505"
          ? `You already have @${element.name}. Rename your existing reference first, or use the one you have.`
          : `Failed to save shared reference: ${error.message}`,
      );
  } catch (error) {
    try {
      await removeStorageObjects([storageKey]);
      if (copiedAssetId) {
        const { error: cleanupError } = await admin.from("assets").delete().eq("id", copiedAssetId);
        if (cleanupError) throw cleanupError;
      }
    } catch (cleanupError) {
      console.warn("saveSharedElement: copied asset cleanup failed", cleanupError);
    }
    return { error: error instanceof Error ? error.message : "Failed to save shared reference." };
  }

  revalidatePath("/elements");
  revalidatePath("/ugc/[id]", "page");
  revalidatePath("/image-generator");
  revalidatePath("/images/[id]", "page");
  return {
    notice: `Saved to your elements as @${element.name}. Type @${element.name} in your prompt to use it.`,
  };
}
