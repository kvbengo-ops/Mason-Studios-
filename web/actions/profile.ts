"use server";

// The /profile page's writes: username, avatar upload/replace/remove. Every
// export here is reachable by ANY signed-in user acting on their OWN
// profile row — requireUser() (actions/guard.ts) is the guard, not
// requireAdmin(), and every write below is additionally scoped with an
// explicit `.eq("id", user.id)` / `.eq("user_id", user.id)` even though it
// runs through the admin client (profiles has no `profiles_update` RLS
// policy at all — see 0002_rls.sql — so a session client couldn't perform
// these writes regardless; the admin client is what makes them possible,
// and the explicit id scoping is this file's own line of defense against a
// copy-paste mistake ever writing a WHERE-less update). role is never read
// from `formData` anywhere in this file — see updateUsername below, the
// only mutation that touches `profiles` directly, and its own comment on
// why.

import { revalidatePath } from "next/cache";
import { requireUser } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { usernameFieldSchema } from "@/lib/signup-username";
import { uploadAvatarFile, removeStorageObjects, resolveStagedUploads } from "@/lib/storage";
import {
  formatFileSizeMB,
  isAcceptedReferenceImage,
  isAcceptedReferenceImageSize,
  MAX_REFERENCE_IMAGE_BYTES,
} from "@/lib/file-type";
import type { ActionResult } from "@/lib/action-result";

const PROFILE_PATH = "/profile";
// Same reasoning as actions/allowance.ts's SIDEBAR_LAYOUT_PATH: the sidebar
// footer (app/(app)/layout.tsx) reads profiles.username nowhere today, but
// avatar_storage_key changes here should still invalidate every route's
// cached RSC payload the moment this app grows a sidebar avatar — cheaper
// to revalidate the shared layout now than to chase a stale-avatar bug
// later.
const SIDEBAR_LAYOUT_PATH = "/";

/**
 * Renames the caller's own account. `profiles_username_lower_idx`
 * (0015_profile_username.sql) is a unique index on `lower(username)`, so a
 * collision surfaces here as a Postgres unique-violation (code 23505) —
 * turned into a RETURNED ActionResult, not a throw: lib/action-result.ts's
 * whole rule is that an operator-actionable message ("that name is taken,
 * pick another") has to come back as data, because a thrown Server Action
 * error is redacted to error #441 in production and the operator would
 * never see it. This is exactly the trap the character library's edit
 * (actions/character-library.ts's updateCharacter) doesn't have to think
 * about — names there aren't unique — and exactly the one requestAllowance
 * (actions/allowance.ts) already got right for its own unique index.
 */
export async function updateUsername(formData: FormData): Promise<ActionResult> {
  const { user } = await requireUser();

  const raw = formData.get("username");
  const value = typeof raw === "string" ? raw.trim() : "";
  const parsed = usernameFieldSchema.safeParse(value);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "That username isn't valid." };
  }

  const admin = createAdminClient();
  // No `role` field anywhere in this statement — this is the ONLY write in
  // this file that touches `profiles`, and it updates exactly one column.
  // Role is rendered read-only on /profile (profile/page.tsx) and there is
  // no code path here that could set it even if a form were tampered with
  // client-side: `formData.get("role")`, if a caller forged one, is never
  // read.
  const { error } = await admin
    .from("profiles")
    .update({ username: parsed.data })
    .eq("id", user.id);

  if (error) {
    if (error.code === "23505") {
      return { error: `"${parsed.data}" is already taken — pick another username.` };
    }
    throw new Error(`Failed to update username for ${user.id}: ${error.message}`);
  }

  revalidatePath(PROFILE_PATH);
}

/** Same shape validateCharacterPhoto (actions/character-library.ts) checks — one rule, not two. */
function validateAvatarPhoto(file: FormDataEntryValue | null): { error: string } | { file: File } {
  if (!(file instanceof File) || file.size === 0) {
    return { error: "A photo file is required." };
  }
  if (!isAcceptedReferenceImage(file)) {
    return { error: "Avatar must be a JPG, PNG, or WebP file." };
  }
  if (!isAcceptedReferenceImageSize(file)) {
    return {
      error:
        `Photo is ${formatFileSizeMB(file.size)} — the limit is ` +
        `${formatFileSizeMB(MAX_REFERENCE_IMAGE_BYTES)}.`,
    };
  }
  return { file };
}

/**
 * Uploads (or replaces) the caller's own avatar.
 *
 * Order matters here, and it is the OPPOSITE of removeCharacter's
 * (actions/character-library.ts) delete-then-update-row order, deliberately:
 * that function is deleting the row too, so "storage object gone, row
 * gone" is the only state that can result from a failure partway through.
 * This function is REPLACING a live row's pointer, so the failure to avoid
 * is different — if the old object were deleted first and the
 * `profiles.avatar_storage_key` update then failed (a dropped connection, a
 * Postgres hiccup), the row would still point at a key that no longer
 * exists, and every future signedUrl() call for this account's avatar would
 * throw. Uploading the new object and committing the new key FIRST, and
 * only deleting the old object after that succeeds, means a mid-operation
 * failure can only ever leave a harmless orphaned object behind (the same
 * accepted failure mode lib/storage.ts's own header already documents for
 * character_ref/composite_ref) — never a broken pointer.
 */
export async function uploadAvatar(formData: FormData): Promise<ActionResult> {
  const { user } = await requireUser();
  await resolveStagedUploads(formData, user.id);

  const validated = validateAvatarPhoto(formData.get("file"));
  if ("error" in validated) {
    return validated;
  }

  const admin = createAdminClient();
  const { data: existing, error: fetchError } = await admin
    .from("profiles")
    .select("avatar_storage_key")
    .eq("id", user.id)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`Failed to load profile for ${user.id}: ${fetchError.message}`);
  }

  const { storageKey } = await uploadAvatarFile({ userId: user.id, file: validated.file });

  const { error: updateError } = await admin
    .from("profiles")
    .update({ avatar_storage_key: storageKey })
    .eq("id", user.id);

  if (updateError) {
    // The new object is already uploaded but not yet referenced by any row
    // — an orphan, not a broken pointer. Clean it up on a best-effort basis
    // (this catch itself must not throw and mask the real failure below)
    // rather than leaving two objects behind for every failed retry.
    await removeStorageObjects([storageKey]).catch(() => undefined);
    throw new Error(`Failed to save avatar for ${user.id}: ${updateError.message}`);
  }

  if (existing?.avatar_storage_key) {
    await removeStorageObjects([existing.avatar_storage_key]);
  }

  revalidatePath(PROFILE_PATH);
  revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
}

/** Removes the caller's own avatar — storage object first, then the column, same ordering as removeCharacter. */
export async function removeAvatar(): Promise<ActionResult> {
  const { user } = await requireUser();

  const admin = createAdminClient();
  const { data: existing, error: fetchError } = await admin
    .from("profiles")
    .select("avatar_storage_key")
    .eq("id", user.id)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`Failed to load profile for ${user.id}: ${fetchError.message}`);
  }

  if (!existing?.avatar_storage_key) {
    // Already gone — a stale tab reaching here is a no-op, not a failure.
    return;
  }

  await removeStorageObjects([existing.avatar_storage_key]);

  const { error: updateError } = await admin
    .from("profiles")
    .update({ avatar_storage_key: null })
    .eq("id", user.id);

  if (updateError) {
    throw new Error(`Failed to clear avatar for ${user.id}: ${updateError.message}`);
  }

  revalidatePath(PROFILE_PATH);
  revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
}
