"use server";

import { requireUser } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { elementUploadNameError } from "@/lib/element-upload-name";

export async function checkElementUploadName(name: string, shared = true): Promise<string | null> {
  const { user } = await requireUser();
  return elementUploadNameError(createAdminClient(), user.id, name.trim(), shared);
}
