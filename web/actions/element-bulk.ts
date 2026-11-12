"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isAdmin, requireUser } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";

// One request, one batch: the Elements Library's multi-select. Both actions
// re-check ownership per row against elements.user_id on the admin client (which
// has no RLS), exactly as actions/elements.ts does for a single card.
const idsSchema = z.array(z.string().uuid()).min(1).max(100);

export type BulkElementResult = { done: number; skipped: number } | { error: string };

/**
 * Shares the caller's OWN private elements with everyone. A row that is already
 * shared, not theirs, or whose tag a shared element already uses is skipped
 * (guard_shared_element_name raises 23505) rather than failing the batch.
 * Admins share only their own: sharing is the owner's call.
 */
export async function shareElements(ids: string[]): Promise<BulkElementResult> {
  const { user } = await requireUser();
  const parsed = idsSchema.safeParse(ids);
  if (!parsed.success) return { error: "Select 1 to 100 elements." };

  const admin = createAdminClient();
  const { data: rows, error: readError } = await admin
    .from("elements")
    .select("id, user_id, is_shared")
    .in("id", parsed.data)
    .is("deleted_at", null);
  if (readError) throw new Error(`Failed to read elements: ${readError.message}`);

  const shareable = (rows ?? []).filter((row) => row.user_id === user.id && !row.is_shared);
  const results = await Promise.all(
    shareable.map(async (row) => {
      const { error } = await admin
        .from("elements")
        .update({ is_shared: true })
        .eq("id", row.id)
        .eq("user_id", user.id)
        .is("deleted_at", null);
      if (error && error.code !== "23505") {
        throw new Error(`Failed to share an element: ${error.message}`);
      }
      return !error;
    }),
  );
  const done = results.filter(Boolean).length;
  revalidatePath("/elements");
  return { done, skipped: parsed.data.length - done };
}

/** Soft-deletes elements the caller owns (or any, for an admin), as deleteElement does for one. */
export async function deleteElements(ids: string[]): Promise<BulkElementResult> {
  const { user, profile } = await requireUser();
  const parsed = idsSchema.safeParse(ids);
  if (!parsed.success) return { error: "Select 1 to 100 elements." };

  const admin = createAdminClient();
  const { data: rows, error: readError } = await admin
    .from("elements")
    .select("id, user_id")
    .in("id", parsed.data)
    .is("deleted_at", null);
  if (readError) throw new Error(`Failed to read elements: ${readError.message}`);

  const removable = (rows ?? [])
    .filter((row) => row.user_id === user.id || isAdmin(profile))
    .map((row) => row.id);
  if (removable.length > 0) {
    const { error } = await admin
      .from("elements")
      .update({ deleted_at: new Date().toISOString(), deleted_by: user.id })
      .in("id", removable)
      .is("deleted_at", null);
    if (error) throw new Error(`Failed to remove elements: ${error.message}`);
  }
  revalidatePath("/elements");
  return { done: removable.length, skipped: parsed.data.length - removable.length };
}
