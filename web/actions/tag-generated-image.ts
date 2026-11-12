"use server";

import { z } from "zod";
import { requireUser } from "@/actions/guard";
import { updateElement } from "@/actions/elements";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { elementUploadNameError } from "@/lib/element-upload-name";
import { extFromFilename, getImageUrl } from "@/lib/storage";
import type { ElementTag } from "@/lib/elements";

const inputSchema = z.object({
  assetId: z.string().uuid(),
  name: z.string().trim(),
  description: z.string().trim().max(2000),
});

/**
 * The reference picker's Images tab: a picture from the Create history, named
 * and described by the operator, used as an @tag. A tag is how a reference
 * reaches a prompt, so the image becomes a private element the FIRST time it is
 * used, not when it is generated. That keeps the Elements Library to pictures
 * someone chose. An image that already has an element (filed automatically
 * before that stopped, or tagged earlier) takes the tag and description typed
 * here through updateElement, which also rewrites prompts using the old tag.
 */
export async function tagGeneratedImage(input: {
  assetId: string;
  name: string;
  description: string;
}): Promise<{ element: ElementTag; existing: boolean } | { error: string }> {
  const { user } = await requireUser();
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { error: "That image or description is not valid." };
  const { assetId, name, description } = parsed.data;

  // The session client, so assets_select is a second gate under the owner check.
  const session = await createClient();
  const { data: asset } = await session
    .from("assets")
    .select("id, user_id, project_id, storage_key")
    .eq("id", assetId)
    .eq("kind", "generated_image")
    .is("deleted_at", null)
    .maybeSingle();
  if (!asset || asset.user_id !== user.id || asset.project_id !== null) {
    return { error: "That image is no longer available." };
  }

  const admin = createAdminClient();
  const columns = "id, name, category, description, ai_description";
  const { data: found } = await admin
    .from("elements")
    .select(columns)
    .eq("asset_id", asset.id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();

  let row = found;
  let unchanged = found !== null;
  if (found) {
    const nextDescription = description || found.description || "";
    if (name !== found.name || nextDescription !== (found.description ?? "")) {
      const form = new FormData();
      form.set("elementId", found.id);
      form.set("name", name);
      form.set("category", found.category);
      form.set("description", nextDescription);
      const result = await updateElement(form);
      if (result?.error) return { error: result.error };
      unchanged = false;
      const { data: fresh } = await admin
        .from("elements")
        .select(columns)
        .eq("id", found.id)
        .single();
      row = fresh ?? found;
    }
  }
  if (!row) {
    const nameError = await elementUploadNameError(admin, user.id, name, false);
    if (nameError) return { error: nameError };
    const { data: created, error } = await admin
      .from("elements")
      .insert({
        user_id: user.id,
        asset_id: asset.id,
        name,
        description: description || null,
        category: "image",
        is_shared: false,
      })
      .select(columns)
      .single();
    if (error || !created) {
      return {
        error:
          error?.code === "23505"
            ? `@${name} is already used. Choose another tag.`
            : "Could not tag that image. Try again.",
      };
    }
    row = created;
  }

  return {
    existing: unchanged,
    element: {
      id: row.id,
      name: row.name,
      category: row.category,
      description: row.description,
      aiDescription: row.ai_description,
      userId: user.id,
      isShared: false,
      assetKind: "generated_image",
      imageExt: extFromFilename(asset.storage_key, "png"),
      previewUrl: await getImageUrl(asset.storage_key, "thumb"),
    },
  };
}
