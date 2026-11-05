import { createStagedUpload } from "@/actions/staged-upload";
import { STAGED_UPLOAD_PREFIX } from "@/lib/staged-upload";
import type { StagedUpload } from "@/lib/staged-upload";
import { createClient } from "@/lib/supabase/client";

/** Uploads every non-empty File in `formData` to Storage and swaps it for a staged-upload marker, in place. */
export async function stageFiles(formData: FormData): Promise<void> {
  for (const [name, value] of [...formData.entries()]) {
    if (!(value instanceof File) || value.size === 0) continue;
    const { key, token } = await createStagedUpload();
    const { error } = await createClient()
      // lib/storage.ts's MEDIA_BUCKET; that module is server-only.
      .storage.from("media")
      .uploadToSignedUrl(key, token, value, { contentType: value.type || "application/octet-stream" });
    if (error) throw new Error(`Could not upload ${value.name}: ${error.message}`);
    const staged: StagedUpload = { key, filename: value.name, type: value.type };
    formData.set(name, STAGED_UPLOAD_PREFIX + JSON.stringify(staged));
  }
}
