"use server";

// The Character Library (0020_characters.sql): admins add, edit and
// remove entries here; every signed-in operator picks from them via
// useCharacter, called from the per-project Character step
// (character/page.tsx). "Add, edit, remove" are all admin-only and
// gated the same way as the /library page itself (requireAdmin,
// actions/guard.ts) — a bypass of the UI (which already hides these
// controls from an editor) is a privilege violation, not an expected
// refusal, so these throw AuthorizationError rather than returning an
// ActionResult. Contrast with useCharacter below, which every operator is
// meant to reach and so returns ordinary ActionResults for its refusals.

import { revalidatePath } from "next/cache";
import { requireAdmin, requireProject } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { generateImage, modelForImageArgs, ImageGenerationError } from "@/lib/kie";
import { classifyRenderError } from "@/lib/render-error";
import { invalidateComposite } from "@/actions/character";
import { estimatedRefFrameCostUsd } from "@/lib/models";
import { assertWithinSpendCaps } from "@/lib/spend";
import { recordRun, failedRunFields } from "@/lib/runs";
import {
  buildStorageKey,
  copyStorageObject,
  extFromFilename,
  removeStorageObjects,
  resolveStagedUploads,
  uploadLibraryFile,
  uploadLibraryFromUrl,
} from "@/lib/storage";
import {
  formatFileSizeMB,
  isAcceptedReferenceImage,
  isAcceptedReferenceImageSize,
  MAX_REFERENCE_IMAGE_BYTES,
} from "@/lib/file-type";
import type { ActionResult } from "@/lib/action-result";

const LIBRARY_PATH = "/library";

function characterPath(projectId: string): string {
  return `/projects/${projectId}/character`;
}

/** Same shape uploadCharacterRef/uploadProductRef validate against (actions/character.ts) — one rule, not two. */
function validateCharacterPhoto(
  file: FormDataEntryValue | null,
): { error: string } | { file: File } {
  if (!(file instanceof File) || file.size === 0) {
    return { error: "A photo file is required." };
  }
  if (!isAcceptedReferenceImage(file)) {
    return { error: "Photo must be a JPG, PNG, or WebP file." };
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

function requireName(value: FormDataEntryValue | null): { error: string } | { name: string } {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0) {
    return { error: "A character name is required." };
  }
  return { name };
}

/**
 * Adds a library character from an uploaded photo.
 *
 * A description is now REQUIRED, even though `characters.description`
 * itself stays nullable (0020_characters.sql — kept nullable for library
 * rows that predate this fix, not because a new photo-only entry is still
 * a valid thing to create). Every project that later picks this character
 * via useCharacter below copies `description` straight into
 * `character_desc`, which is what stops lib/claude.ts's compileBrief from
 * inventing its own — see assertHasCharacter's doc comment
 * (lib/compile-guard.ts) for the two-different-people failure this
 * prevents. A photo-only library entry would silently reproduce that
 * failure on every project that picks it, so this is the cheaper place to
 * close it: one required field here beats an operator discovering the gap
 * on every project that used it.
 */
export async function createCharacterFromUpload(formData: FormData): Promise<ActionResult> {
  const { user } = await requireAdmin();
  await resolveStagedUploads(formData, user.id);

  const nameResult = requireName(formData.get("name"));
  if ("error" in nameResult) {
    return nameResult;
  }

  const descriptionValue = formData.get("description");
  const description = typeof descriptionValue === "string" ? descriptionValue.trim() : "";
  if (description.length === 0) {
    return {
      error:
        "A character description is required — it's what keeps this person described " +
        "consistently across every scene. See the Library page's description field.",
    };
  }

  const validated = validateCharacterPhoto(formData.get("file"));
  if ("error" in validated) {
    return validated;
  }

  const { storageKey } = await uploadLibraryFile({ file: validated.file });

  const admin = createAdminClient();
  const { error } = await admin.from("characters").insert({
    name: nameResult.name,
    description,
    storage_key: storageKey,
    created_by: user.id,
  });

  if (error) {
    throw new Error(`Failed to save library character: ${error.message}`);
  }

  revalidatePath(LIBRARY_PATH);
}

/**
 * Updates a library character's name and description together — the one
 * edit affordance the grid offers (library/page.tsx's CharacterCard).
 *
 * This used to be two separate actions: renameCharacter, and a
 * setCharacterDescription that only existed to backfill rows created before
 * a description became required (see createCharacterFromUpload's doc
 * comment above). Splitting them made sense when description-editing was
 * an escape hatch for old rows only — but the bug this page shipped with
 * (a saved description could never be corrected once a character HAD one)
 * meant every card needed a real edit path, not just the description-less
 * ones. One action, one Save, is also just less to get out of sync: an
 * operator fixing a bad description is usually glancing at the name in the
 * same breath, and two independent "did that save?" states for the same
 * card invites exactly the kind of confusion ActionForm/PendingFieldset
 * already exist to prevent for a single field.
 *
 * Both fields are required on every call, including the backfill case (a
 * library row from before descriptions were mandatory) — name is never in
 * doubt there since the row already has one, so this doesn't add friction
 * over the old setCharacterDescription, it just always asks for both.
 */
export async function updateCharacter(
  characterId: string,
  formData: FormData,
): Promise<ActionResult> {
  await requireAdmin();

  const nameResult = requireName(formData.get("name"));
  if ("error" in nameResult) {
    return nameResult;
  }

  const descriptionValue = formData.get("description");
  const description = typeof descriptionValue === "string" ? descriptionValue.trim() : "";
  if (description.length === 0) {
    return {
      error:
        "A character description is required — it's what keeps this person described " +
        "consistently across every scene.",
    };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("characters")
    .update({ name: nameResult.name, description, updated_at: new Date().toISOString() })
    .eq("id", characterId);

  if (error) {
    throw new Error(`Failed to save library character: ${error.message}`);
  }

  revalidatePath(LIBRARY_PATH);
}

/**
 * Adds a library character generated from a typed description — reuses the
 * same generateImage call every reference image on this product goes
 * through (lib/kie.ts).
 *
 * The one paid call site in this codebase with no project to attribute its
 * cost to: the library is shared across every project (0020_characters.sql),
 * so the `runs` row this writes has `project_id: null` — see
 * 0030_runs_project_id.sql's header and lib/runs.ts's RunRecord.projectId
 * for exactly what that costs (still counted by the GLOBAL daily cap and
 * /spend's totals; invisible to the requesting admin's OWN per-user cap and
 * to the per-project/per-user breakdown views). assertWithinSpendCaps is
 * still called below with this admin's own id/role — it protects against
 * everything it CAN see (their own other spend, and the team total), it
 * just can't count this specific call toward what it's guarding against
 * for next time.
 */
export async function createCharacterFromDescription(formData: FormData): Promise<ActionResult> {
  const { user, profile } = await requireAdmin();

  const nameResult = requireName(formData.get("name"));
  if ("error" in nameResult) {
    return nameResult;
  }

  const descriptionValue = formData.get("description");
  const description = typeof descriptionValue === "string" ? descriptionValue.trim() : "";
  if (description.length === 0) {
    return { error: "A description is required to generate a reference photo." };
  }

  const refFrameUsd = estimatedRefFrameCostUsd();
  const capResult = await assertWithinSpendCaps(user.id, profile, refFrameUsd);
  if (capResult) return capResult;

  const genArgs = { prompt: description };
  const model = modelForImageArgs(genArgs);

  let url: string;
  let costUsd: number | null;
  try {
    ({ url, costUsd } = await generateImage(genArgs));
  } catch (err) {
    // failedRunFields, not a hand-written costUsd/error pair: a poll-budget
    // timeout means kie is STILL DRAWING and will still bill, so it keeps the
    // task id and HOLDS the estimate instead of recording the paid call as
    // free. Every other failure records exactly as it did before — null cost,
    // raw message — for the reason recordRun's own doc comment gives.
    await recordRun({
      projectId: null,
      vendor: "kie",
      model,
      ...failedRunFields(err, refFrameUsd),
    });
    if (err instanceof ImageGenerationError) {
      // Through classifyRenderError, not raw: kie's own message is whatever
      // the vendor echoed back, and in the signing path that can contain the
      // signed reference-image URL we sent — a Supabase signed URL carries an
      // access token (see lib/render-error.ts). It also turns a recognised
      // cause into something the operator can act on: a content-policy
      // refusal is inconsistent about the same input, and saying "try again"
      // is the difference between a dead end and a retry that usually works.
      // Anything unrecognised falls through as the sanitised original.
      return { error: classifyRenderError(err.message).message };
    }
    throw err;
  }

  const { storageKey } = await uploadLibraryFromUrl({ url });

  const admin = createAdminClient();
  const { error } = await admin.from("characters").insert({
    name: nameResult.name,
    description,
    storage_key: storageKey,
    created_by: user.id,
  });

  if (error) {
    throw new Error(`Failed to save library character: ${error.message}`);
  }

  await recordRun({
    projectId: null,
    vendor: "kie",
    model,
    costUsd: costUsd ?? estimatedRefFrameCostUsd(),
  });

  revalidatePath(LIBRARY_PATH);
}

/**
 * Removes a library character — the Storage object AND the row, same
 * ordering removeReferenceAsset (actions/character.ts) already established
 * for the identical problem: delete the Storage object first, the row
 * second, because removeStorageObjects' failure mode is only safe in that
 * order (see its doc comment in lib/storage.ts). Every project that already
 * ran useCharacter has its OWN copy of both the photo and the description
 * (see useCharacter below) — removing the library entry cannot blank a
 * character out of a project that already used it, which is the entire
 * reason Use copies instead of referencing.
 */
export async function removeCharacter(characterId: string): Promise<ActionResult> {
  await requireAdmin();

  const admin = createAdminClient();
  const { data: character, error } = await admin
    .from("characters")
    .select("storage_key")
    .eq("id", characterId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load library character ${characterId}: ${error.message}`);
  }

  if (!character) {
    // Already gone — a stale tab reaching here is a no-op, not a failure.
    return;
  }

  await removeStorageObjects([character.storage_key]);

  const { error: deleteError } = await admin.from("characters").delete().eq("id", characterId);

  if (deleteError) {
    throw new Error(`Failed to delete library character ${characterId}: ${deleteError.message}`);
  }

  revalidatePath(LIBRARY_PATH);
}

/**
 * Picks a library character onto a project — available to every operator
 * (editor or admin) who owns the project, unlike every other action in
 * this file. requireProject is the ownership boundary, exactly as it is
 * for every other per-project write.
 *
 * Copies, does not reference: Storage's own server-side copy
 * (lib/storage.ts's copyStorageObject) duplicates the photo into the
 * project's own `character_ref` key, and the character's `description` is
 * copied verbatim into `projects.character_desc`. Both together, in one
 * call — a library entry that only copied the photo would strand the text
 * half of "the same person, described the same way" that 0020_characters.sql
 * exists to keep together. Copying rather than pointing is deliberate, not
 * a missed optimization: a library entry an admin removes a month from now
 * must not blank the character out of every project that already used it,
 * which a foreign key or a shared storage_key would do the moment the
 * source row or object disappeared. Every project that has ever run this
 * gets its own durable copy, the same guarantee an uploaded photo has
 * always had.
 *
 * Locked exactly like every other character-setting action on this project
 * (actions/character.ts): picking a character is an edit like any other,
 * and freezes once the project has been delivered — see lib/editable-
 * guard.ts's header comment for why that's the commitment point, not "a
 * scene has rendered." Rendering has already started is fine; it just means
 * the newly-picked character won't match already-produced clips until
 * they're re-rendered.
 *
 * Also stamps `projects.source_character_id` — a label recording which
 * library row this copy came FROM, so the grid can show which card is in
 * use (0021_project_character_source.sql). This is the only place that
 * sets it; every other write to character_desc or the character reference
 * asset (actions/character.ts) clears it back to null, because at that
 * point the project's copy no longer matches what was copied here.
 */
export async function useCharacter(projectId: string, characterId: string): Promise<ActionResult> {
  // Needed below for the null-description check — see the comment further
  // down — not just for the ownership check every other action here uses
  // `requireProject` for.
  const { project } = await requireProject(projectId);

  const admin = createAdminClient();

  // Same lock this project's other character-setting actions read
  // (actions/character.ts) — `project.status` here is already
  // deriveProjectStatus's output (see actions/guard.ts's requireProject),
  // so no separate query is needed to check it.
  if (project.status === "delivered") {
    return {
      error:
        "This project has already been delivered — the character is locked. Reopen the project " +
        "(Deliver page) to pick a different one; existing clips won't reflect the change until " +
        "they're re-rendered.",
    };
  }

  const { data: character, error: characterError } = await admin
    .from("characters")
    .select("name, storage_key, description")
    .eq("id", characterId)
    .maybeSingle();

  if (characterError) {
    throw new Error(`Failed to load library character ${characterId}: ${characterError.message}`);
  }

  if (!character) {
    return { error: "That character is no longer in the library." };
  }

  const description = character.description?.trim() || null;

  // Refuse only the combination that would actually break: a library row
  // with no description (an older entry from before createCharacterFromUpload
  // required one — see its doc comment) picked onto a project that has no
  // description of its own either. Completing the copy in that state would
  // leave the project with a character_ref photo and no character_desc —
  // exactly the combination assertHasCharacter (lib/compile-guard.ts) now
  // refuses to compile, because Claude invents a mismatched description
  // when none is supplied. Catching it here, at the moment the mismatch
  // would be created, beats letting the operator discover it several steps
  // later at Compile. A project that already has its own typed description
  // is unaffected: the write below preserves it (see the next comment)
  // instead of blanking it to match this null library entry, so Use still
  // succeeds there.
  if (!description && !project.character_desc?.trim()) {
    return {
      error:
        `"${character.name}" has no description in the Character Library, and this project ` +
        "doesn't have one of its own yet either. Add a description on the Library page before " +
        "using this character — otherwise nothing would tell the compiler who this person is, " +
        "and it would invent a mismatched description at compile time.",
    };
  }

  const ext = extFromFilename(character.storage_key, "jpg");
  const toKey = buildStorageKey({ projectId, kind: "character_ref", ext });

  await copyStorageObject(character.storage_key, toKey);

  // One instant, written to BOTH sides of the comparison
  // isDescriptionStale makes. Using a library character replaces the
  // description and the photo together, from the same source, so they are
  // by definition in sync — but the asset's created_at defaulted to the
  // DATABASE's clock while character_desc_edited_at is stamped from the web
  // server's, and any skew or ordering between the two writes decided the
  // answer. A freshly-picked character came out marked "Stale — made from
  // the older description" the moment it landed.
  const copiedAtIso = new Date().toISOString();

  const { error: assetError } = await admin.from("assets").insert({
    project_id: projectId,
    kind: "character_ref",
    storage_key: toKey,
    created_at: copiedAtIso,
  });

  if (assetError) {
    throw new Error(`Failed to record character reference asset: ${assetError.message}`);
  }

  // The new photo no longer matches whatever composite was built from the
  // OLD character_ref — see invalidateComposite's doc comment
  // (actions/character.ts) for the two-different-people failure a stale
  // composite produces. Same invalidation actions/character.ts's own
  // uploadCharacterRef/regenerateCharacter apply for the identical reason;
  // useCharacter is a third way this project's character photo changes,
  // and has to carry the same fix or it would just be the one path that
  // still leaks a stale composite through.
  await invalidateComposite(admin, projectId);

  const { error: projectError } = await admin
    .from("projects")
    // source_character_id (0021_project_character_source.sql) is a label,
    // not a reference — it's what lets the grid above show which card this
    // project is currently using. Every OTHER write to character_desc or
    // the character reference asset clears it back to null for the same
    // reason (see 0021's comment): the moment the project's own copy no
    // longer matches what was copied here, the label would be lying.
    //
    // character_desc is only written when this library row actually has
    // one (0020_characters.sql's own column comment: copied "when
    // present"). Writing `character.description` unconditionally would
    // blank a project's existing, perfectly good description back to null
    // whenever the picked library entry happens to have none of its own —
    // the guard above already proved that can only happen here when the
    // project has NO description of its own to lose, but the guard is
    // about whether to proceed at all, not license to overwrite a value
    // that turns out to still be there.
    .update({
      ...(description ? { character_desc: description } : {}),
      // Stamped only when the description is actually replaced, and to the
      // same instant as the photo above — equal timestamps are NOT stale
      // (isDescriptionStale uses `>`, not `>=`). Leaving it untouched was
      // its own bug in the other direction: the column would still be
      // pointing at an edit to a description this write had just discarded.
      ...(description ? { character_desc_edited_at: copiedAtIso } : {}),
      source_character_id: characterId,
      updated_at: copiedAtIso,
    })
    .eq("id", projectId);

  if (projectError) {
    throw new Error(`Failed to save character description: ${projectError.message}`);
  }

  revalidatePath(characterPath(projectId));
}
