import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { elementUploadNameError } from "@/lib/element-upload-name";

/** Hex characters of the asset id tried as the tag, shortest first. */
const NAME_LENGTHS = [6, 10, 32] as const;

/**
 * Files a finished generated image in its owner's private Elements library, so
 * it is @-taggable straight away with no "Save as element" step.
 *
 * The element POINTS AT the generated asset rather than copying it (the manual
 * save in actions/save-generated-element.ts copies, so a reference survives
 * the image being deleted). Pointing is deliberate here: every generation
 * would otherwise store its bytes twice. The two ends stay consistent without
 * a rule of their own — a trashed asset is skipped by the element loaders, and
 * purging it deletes the element with it (elements.asset_id on delete cascade).
 *
 * The tag is `img_` plus the start of the asset id: unique without a counter,
 * stable, and renamable like any element. The longer lengths only exist for
 * the (astronomically unlikely) clash with an existing tag.
 */
export async function saveGeneratedImageAsElement(
  admin: SupabaseClient<Database>,
  userId: string,
  assetId: string,
): Promise<string | null> {
  const hex = assetId.replace(/-/g, "");
  for (const length of NAME_LENGTHS) {
    const name = `img_${hex.slice(0, length)}`;
    if ((await elementUploadNameError(admin, userId, name, false)) !== null) continue;
    const { error } = await admin.from("elements").insert({
      user_id: userId,
      asset_id: assetId,
      name,
      category: "image",
      is_shared: false,
    });
    if (!error) return name;
    // 23505: another writer took the tag between the check and the insert.
    if (error.code !== "23505") throw new Error(`Could not file the image: ${error.message}`);
  }
  return null;
}
