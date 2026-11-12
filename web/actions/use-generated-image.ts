"use server";

import { z } from "zod";
import { requireUser } from "@/actions/guard";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { saveGeneratedImageAsElement } from "@/lib/generated-image-element";
import { extFromFilename, getImageUrl } from "@/lib/storage";
import type { ElementTag } from "@/lib/elements";

/**
 * The reference picker's Images tab: a picture from the Create history, used as
 * an @tag. The tag is how a reference reaches a prompt, so the image is filed as
 * a private element the FIRST time it is used, not when it is generated. That
 * keeps the Elements Library to pictures someone chose. A second use finds the
 * element made by the first.
 */
export async function useGeneratedImage(
  assetId: string,
): Promise<{ element: ElementTag } | { error: string }> {
  const { user } = await requireUser();
  const parsed = z.string().uuid().safeParse(assetId);
  if (!parsed.success) return { error: "That image is no longer available." };

  // The session client, so assets_select is a second gate under the owner check.
  const session = await createClient();
  const { data: asset } = await session
    .from("assets")
    .select("id, user_id, project_id, storage_key")
    .eq("id", parsed.data)
    .eq("kind", "generated_image")
    .is("deleted_at", null)
    .maybeSingle();
  if (!asset || asset.user_id !== user.id || asset.project_id !== null) {
    return { error: "That image is no longer available." };
  }

  const admin = createAdminClient();
  const readElement = () =>
    admin
      .from("elements")
      .select("id, name, category, description, ai_description")
      .eq("asset_id", asset.id)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();

  let { data: element } = await readElement();
  if (!element) {
    if (!(await saveGeneratedImageAsElement(admin, user.id, asset.id))) {
      return { error: "Could not tag that image. Try again." };
    }
    element = (await readElement()).data;
  }
  if (!element) return { error: "Could not tag that image. Try again." };

  return {
    element: {
      id: element.id,
      name: element.name,
      category: element.category,
      description: element.description,
      aiDescription: element.ai_description,
      userId: user.id,
      isShared: false,
      assetKind: "generated_image",
      imageExt: extFromFilename(asset.storage_key, "png"),
      previewUrl: await getImageUrl(asset.storage_key, "thumb"),
    },
  };
}
