"use server";

import { requireUser } from "@/actions/guard";
import { createStagedUploadUrl } from "@/lib/storage";

/** Mints a one-object signed upload URL under the caller's own staging prefix — see lib/staged-upload.ts. */
export async function createStagedUpload(): Promise<{ key: string; token: string }> {
  const { user } = await requireUser();
  const { key, token } = await createStagedUploadUrl(user.id);
  return { key, token };
}
