"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { removeStorageObjects } from "@/lib/storage";

async function changeImage(formData: FormData, operation: "restore" | "purge"): Promise<void> {
  const assetId = z.uuid().safeParse(formData.get("assetId"));
  if (!assetId.success) throw new Error("Invalid generated image.");
  const supabase = await createClient();
  const { data: storageKey, error } = await supabase.rpc("manage_personal_image", {
    p_asset_id: assetId.data,
    p_operation: operation,
  });
  if (error) throw new Error("This image is unavailable or could not be updated.");
  if (operation === "purge" && storageKey) {
    // The RPC removes the row under a lock before deleting bytes, so a
    // concurrent restore cannot resurrect a record whose file is removed.
    await removeStorageObjects([storageKey]).catch((cleanupError) => {
      console.error("Could not clean up purged image storage", cleanupError);
    });
  }
  revalidatePath("/bin");
  revalidatePath("/image-generator");
}

export async function restorePersonalImage(formData: FormData): Promise<void> {
  await requireUser();
  await changeImage(formData, "restore");
}

export async function purgePersonalImage(formData: FormData): Promise<void> {
  await requireUser();
  await changeImage(formData, "purge");
}
