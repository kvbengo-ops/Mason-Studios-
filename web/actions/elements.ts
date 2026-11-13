"use server";

// An operator's own reusable @tag library (0065_elements.sql), reached from
// two places and owned by neither: the /ugc reference picker
// (components/ugc-reference-picker.tsx), which has a project, and the
// Elements Library at /elements, which does not.
//
// Uploading spends nothing. Descriptions are added explicitly from Edit.
//
// -----------------------------------------------------------------------------
// TWO CALLERS, TWO GUARDS, ONE OWNER
// -----------------------------------------------------------------------------
// `elements` has ALWAYS been user-scoped — 0065's header says so, the table
// has `user_id` and a `unique (user_id, name)`, and every read resolves a tag
// within its owner's own set. The project was never the element's owner. It
// was here because `assets.project_id` was NOT NULL, so the picture behind an
// element needed one, and "the project the operator was looking at" was as
// good a holding pen as any.
//
// 0085_personal_image_generator.sql removed that constraint (nullable
// project_id, plus assets.user_id and an `assets_owner_present_check` that
// refuses an asset owned by nothing), so the holding pen is no longer needed
// and a `projectId` on these three actions is now OPTIONAL:
//
//   projectId present -> requireProject, exactly as before. Unchanged in every
//                        respect, so the picker's behaviour does not move.
//   projectId absent  -> requireUser. The account-approval gate lives inside
//                        it (canUseApp -> /pending), and there is no row whose
//                        ownership could be in question.
//
// EITHER WAY, OWNERSHIP OF THE ELEMENT IS RE-CHECKED EXPLICITLY against
// `elements.user_id` before any write. That was already true — these actions
// run on the admin client, which has no RLS — and it is what makes the guard
// split safe rather than merely convenient: requireProject never proved
// anything about the ELEMENT, only about the project the request claimed to
// come from.
//
// -----------------------------------------------------------------------------
// SHARED TO READ, OWNED (OR ADMINISTERED) TO WRITE (0091_shared_elements_library.sql)
// -----------------------------------------------------------------------------
// Every signed-in account now reads and downloads the whole library — both
// pictures and voice clips. Who may WRITE did not widen to match:
//
//   registerElement  unchanged. You publish as YOURSELF: `user_id` comes off
//                    requireUser()'s session and never off the FormData, and
//                    elements_insert's `user_id = auth.uid()` says the same
//                    thing again to a request that never went through here.
//                    There is no client-supplied owner id anywhere in it.
//   updateElement    owner OR admin. Renames follow the tag through the
//                    OWNER's prompts, never the caller's — see the compare in
//                    the function itself.
//   deleteElement    owner OR admin. Removes the NAME, never the picture.
//
// BROWSING AUTHORISES NOTHING. A reader who is neither the owner nor an admin
// reaches every row and no write on any of them; the two explicit compares
// below are what enforce that on the admin client, which has no RLS.
//
// Admins edit here, not only delete. That is a product decision rather than a
// drafting slip, and 0091's header carries the argument.
//
// FORGED REFERENCES ARE A DATABASE CONCERN, not this file's. `elements.asset_id`
// points at an `assets` row, so a row naming somebody else's asset would have
// turned the shared grid into an arbitrary-file read. 0091's
// elements_guard_asset_ownership() trigger refuses that at write time from every
// client, and its assets_select branch re-proves ownership at read time; neither
// depends on this module being the only way in.

import { revalidatePath } from "next/cache";
import { isAdmin, requireProject, requireUser } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { removeStorageObjects, resolveStagedUploads, uploadFile } from "@/lib/storage";
import {
  formatFileSizeMB,
  isAcceptedReferenceAudio,
  isAcceptedReferenceAudioSize,
  isAcceptedReferenceImage,
  isAcceptedReferenceImageSize,
  isAcceptedReferenceVideo,
  isAcceptedReferenceVideoSize,
  MAX_REFERENCE_AUDIO_BYTES,
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_VIDEO_BYTES,
} from "@/lib/file-type";
import type { ActionResult } from "@/lib/action-result";
import type { ElementCategory } from "@/types/db";
import { elementUploadNameError } from "@/lib/element-upload-name";
import { parseMp4DurationSeconds } from "@/lib/mp4-duration";
import { parseAudioDurationSeconds } from "@/lib/audio-duration";
import { promptMentionsTag, renameTagInPrompt } from "@/lib/rename-tag";

// Mirrors 0073's CHECK. A category the database refuses is a 500 the operator
// cannot act on, so the two lists have to move together.
// Every value the CHECK admits (0081), because this list is what decides
// whether a category arriving on a form is accepted or replaced by the
// default. The four older ones stay: an operator editing a reference saved
// before 0081 submits the category the panel showed them, and refusing it
// would silently rewrite their row on an unrelated edit.
const ELEMENT_CATEGORIES: readonly ElementCategory[] = [
  "image",
  "audio",
  "video",
  "character",
  "product",
  "location",
  "voice",
];

function isElementCategory(value: string): value is ElementCategory {
  return (ELEMENT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Saves an upload as a named, categorized reference an operator can later
 * summon by typing "@name" into any /ugc prompt (lib/elements.ts resolves
 * the tag; components/ugc-prompt-editor.tsx shows the hover preview).
 *
 * The upload saves the media and leaves description null. An editor can add
 * text or explicitly ask Gemini to describe the saved element later.
 */
/** The library path, revalidated by every write here regardless of caller. */
const ELEMENTS_PATH = "/elements";

/**
 * Who is acting, and which project (if any) they are acting from.
 *
 * `projectId` is read from the FORM, which is why it decides only the GUARD
 * and never the owner: the owner is `user.id` off the session, so a forged or
 * omitted project id can widen nothing. What a present project id does buy is
 * the STRICTER of the two doors — it must be a project this account owns, or
 * requireProject refuses — which keeps the picker's behaviour byte-for-byte
 * what it was.
 *
 * Absent means the Elements Library, which has no project and needs none.
 */
async function resolveElementScope(formData: FormData): Promise<{
  user: { id: string; email?: string };
  profile: Awaited<ReturnType<typeof requireUser>>["profile"];
  project: Awaited<ReturnType<typeof requireProject>>["project"] | null;
}> {
  const projectId = String(formData.get("projectId") ?? "").trim();
  if (projectId) {
    const { user, profile, project } = await requireProject(projectId);
    return { user, profile, project };
  }
  const { user, profile } = await requireUser();
  return { user, profile, project: null };
}

/**
 * Where a change to this operator's library shows up.
 *
 * The library ALWAYS, the originating project's console as well when there was
 * one. An element saved from the picker appears on /elements immediately, and
 * one renamed on /elements is reflected in the console the operator may have
 * open in another tab — the two are the same rows and must not look like two
 * libraries.
 */
function revalidateElementSurfaces(projectId: string | null): void {
  revalidatePath(ELEMENTS_PATH);
  if (projectId) revalidatePath(`/ugc/${projectId}`);
}

export async function registerElement(formData: FormData): Promise<ActionResult> {
  const { project, user } = await resolveElementScope(formData);
  const destination = formData.get("destination") ?? "shared";
  if (destination !== "shared" && destination !== "mine")
    return { error: "Choose Shared or Mine." };
  const shared = destination === "shared";
  await resolveStagedUploads(formData, user.id);

  const name = String(formData.get("name") ?? "").trim();
  const categoryRaw = String(formData.get("category") ?? "");

  const image = formData.get("image");
  if (!(image instanceof File) || image.size === 0) {
    return { error: "Attach a picture, a voice clip or a video to save as a reference." };
  }

  // A REFERENCE IS NOW ONE OF THREE THINGS, and which one decides nearly
  // everything that follows: the accept/reject guard, the category default,
  // size ceiling and its error copy, and assets.kind. This used to be a boolean (`isAudio`) — sound
  // reasoning while there were only two kinds to tell apart, since a boolean
  // has an honest "no" for exactly one alternative. Video
  // (0093_video_reference_elements.sql) is a THIRD alternative, and a
  // boolean has no honest way to say "neither of the other two" — it was
  // retired rather than grown a second flag, so every decision below reads
  // this one discriminated `kind` instead of re-deriving its own two-way
  // split.
  //
  // Order matters here: audio and video are each checked by their own
  // narrow predicate, and anything neither claims falls through to "image",
  // which is then validated for real by isAcceptedReferenceImage below —
  // the same "guess image, then check for real" shape the old boolean used.
  const kind: "image" | "audio" | "video" = isAcceptedReferenceAudio(image)
    ? "audio"
    : isAcceptedReferenceVideo(image)
      ? "video"
      : "image";
  if (kind === "image" && !isAcceptedReferenceImage(image)) {
    return {
      error:
        "That file must be a JPG, PNG or WebP picture, an MP3 or WAV voice clip, or an MP4 video.",
    };
  }
  if (kind === "audio") {
    if (!isAcceptedReferenceAudioSize(image)) {
      return {
        error: `That clip is ${formatFileSizeMB(image.size)} — kie's limit is ${formatFileSizeMB(MAX_REFERENCE_AUDIO_BYTES)}.`,
      };
    }
  } else if (kind === "video") {
    if (!isAcceptedReferenceVideoSize(image)) {
      return {
        error: `That video is ${formatFileSizeMB(image.size)} — the limit is ${formatFileSizeMB(MAX_REFERENCE_VIDEO_BYTES)}.`,
      };
    }
  } else if (!isAcceptedReferenceImageSize(image)) {
    return {
      error: `That image is ${formatFileSizeMB(image.size)} — the limit is ${formatFileSizeMB(MAX_REFERENCE_IMAGE_BYTES)}.`,
    };
  }

  const admin = createAdminClient();
  const nameError = await elementUploadNameError(admin, user.id, name, shared);
  if (nameError) return { error: nameError };

  // RESOLVED AFTER THE FILE, because it depends on it. An audio upload is a
  // voice by construction and a video upload is a video by construction —
  // there is no other category either could be, and letting the form's
  // default ("character") stand would file a recording, or a clip, under a
  // heading that promises a face.
  //
  // For an image the default is still a guess and still not a refusal: a
  // picture with nothing said about it is a character far more often than
  // anything else, and the badge on the card is one click to change.
  // THE KIND, NOT THE SUBJECT (0081). This said "voice" and "character",
  // which described what a reference depicted rather than what it is — and
  // nothing has ever branched on the difference. An explicit category from
  // the form still wins; only the default changed.
  const category =
    kind === "audio"
      ? "audio"
      : kind === "video"
        ? "video"
        : isElementCategory(categoryRaw)
          ? categoryRaw
          : "image";

  const resolvedName = name;

  const description = null;

  // ref_frame, the same AssetKind /ugc's own generateClip uses for an
  // operator's upload — this IS a conditioning frame, just one saved under
  // a name for reuse rather than spent on a single render and forgotten.
  // 'audio' became a legal assets.kind in 0079; before that this line was the
  // reason a voice element stored a picture. 'video_ref' (0093) is NOT a
  // conditioning reference the way the other two are — it can never appear
  // on a scene_references row (that table's own kind CHECK stays image/audio
  // only, unwidened on purpose; see 0093's header) — but it still needs an
  // assets.kind of its own rather than borrowing 'ref_frame', because the
  // asset row is how storage-cleanup and the library grid tell what kind of
  // bytes are behind a given element without opening the file.
  //
  // Named `assetKind`, not `kind` — `kind` above is the three-way
  // image/audio/video discriminator this whole function now branches on,
  // and reusing the name here for a different, narrower value (the literal
  // assets.kind column) would make every read of "kind" below ambiguous
  // about which one it meant.
  const assetKind =
    kind === "audio" ? "audio" : kind === "video" ? "video_ref" : ("ref_frame" as const);

  // Only a duration parsed from the MP4 bytes is trusted for pricing.
  const measuredVideoDurationS =
    kind === "video" ? parseMp4DurationSeconds(new Uint8Array(await image.arrayBuffer())) : null;
  if (kind === "video" && measuredVideoDurationS === null) {
    return { error: "That MP4 has no supported movie duration." };
  }
  // WAV/MP3 only; null when unreadable, which generate lets through (kie decides) rather than
  // refusing a voice on a guess. Stored so /ugc can refuse a clip outside 2-30 s before kie does.
  const audioExt = image.name.split(".").pop()?.toLowerCase();
  const measuredAudioDurationS =
    kind === "audio" && (audioExt === "wav" || audioExt === "mp3")
      ? parseAudioDurationSeconds(new Uint8Array(await image.arrayBuffer()), audioExt)
      : null;
  // WHERE THE BYTES GO follows the same owner split as the guard above:
  // `projects/<id>/...` when the picker supplied a project, `users/<id>/...`
  // when the Elements Library did (0085 added the second shape). The element
  // row is identical either way — `elements.user_id` has always been the
  // owner, and nothing downstream reads the asset's own owner to resolve a tag.
  const { storageKey, bytes: storedBytes } = await uploadFile(
    project
      ? { file: image, projectId: project.id, kind: assetKind }
      : { file: image, userId: user.id, kind: assetKind },
  );

  // Exactly one owner column, never both — the rule
  // assets_owner_present_check enforces and generateImageFor already follows.
  const { data: asset, error: assetError } = await admin
    .from("assets")
    .insert({
      project_id: project?.id ?? null,
      user_id: project ? null : user.id,
      kind: assetKind,
      storage_key: storageKey,
      // WRITTEN SO THE SIZE GUARD DOWNSTREAM IS REAL. assets.bytes has existed
      // for a long time and, before this line, was null on every row an
      // element ever created — 0 populated out of 48 audio and 187 ref_frame
      // rows in the dev database, checked. redescribeElement (actions/ugc.ts)
      // refuses to send an over-sized clip to kie by reading exactly this
      // column, and against a null it silently does nothing: `typeof
      // asset.bytes === "number"` is false, the check falls through, and the
      // protection is a comment.
      //
      // The describer's own guard still catches it either way, but only after
      // downloading the whole file to find out. Recording the size we already
      // have in hand turns a dead branch into a live one and saves that
      // download. It costs one integer.
      bytes: storedBytes ?? image.size,
      // NULL FOR IMAGE AND AUDIO, same as it has always been — this column
      // has existed since 0001_init.sql and the WORKER already writes it for
      // every 'clip'/'final' asset it produces (worker/internal/media/
      // media.go:367, kie's own self-reported duration), but nothing has
      // ever written it for a reference an OPERATOR uploads through THIS
      // action: every video_ref, ref_frame and audio row registerElement has
      // ever inserted left it null, the same 0-populated state assets.bytes
      // was in before the line above this one existed (check the database,
      // don't assume — that is exactly what this task's own brief asked
      // for). Video is the one kind that populates it now, because pricing
      // a scene that tags this element needs exactly this number — see
      // measuredVideoDurationS's own comment above for where it came from
      // and what a null here tells the pricing code to do.
      duration_s: kind === "video" ? measuredVideoDurationS : measuredAudioDurationS,
    })
    .select("id")
    .single();
  if (assetError || !asset) {
    // THE FILE IS ALREADY IN STORAGE by the time we get here, and without this
    // it stays there forever: nothing else knows its key, so it is garbage
    // that cannot be found, let alone reclaimed. Best-effort and never
    // rethrown — the insert failure is the real news, and a cleanup that
    // masks it with its own error would be worse than the orphan.
    try {
      await removeStorageObjects([storageKey]);
    } catch (cleanupError) {
      console.warn(`registerElement: orphaned ${storageKey} after a failed insert`, cleanupError);
    }

    // 23514 is check_violation. For an audio or video upload it means
    // exactly one thing: the migration that widened assets_kind_check for
    // that kind has not been applied to this database yet, so 'audio' or
    // 'video_ref' is not yet a legal assets.kind. That is a deploy-order
    // problem with a precise answer, and it deserves a sentence rather than
    // the generic "Something went wrong" a thrown error renders as.
    //
    // Narrow on purpose. Any other failure still throws, because a soft error
    // for a lost connection would tell an operator their file was rejected
    // when it was not.
    if (kind === "audio" && assetError?.code === "23514") {
      return {
        error:
          "Voice references are not enabled on this database yet — migration 0079 has not been applied. " +
          "A picture will still upload.",
      };
    }
    if (kind === "video" && assetError?.code === "23514") {
      return {
        error:
          "Video references are not enabled on this database yet — migration 0093 has not been applied. " +
          "A picture will still upload.",
      };
    }

    throw new Error(`Failed to record the reference image: ${assetError?.message ?? "no row"}`);
  }

  const { error: elementError } = await admin.from("elements").insert({
    user_id: user.id,
    name: resolvedName,
    description,
    category,
    asset_id: asset.id,
    is_shared: shared,
  });

  if (elementError) {
    // elements has `unique (user_id, name)` — a second element named "jen"
    // would make "@jen" ambiguous, so this is a real refusal, not a bug.
    if (elementError.code === "23505") {
      return { error: `@${name} is already used. Choose another tag.` };
    }
    throw new Error(`Failed to save "${resolvedName}" as a reference: ${elementError.message}`);
  }

  revalidateElementSurfaces(project?.id ?? null);

  return undefined;
}

/**
 * Corrects a saved reference: its name, its category, its description.
 *
 * This is where the optional description is written after upload.
 *
 * A RENAME REWRITES THE PROMPTS THAT USED THE OLD NAME, and that is the whole
 * reason this action is more than an UPDATE. Substitution is by name at render
 * time (actions/ugc.ts's resolveElementTags), so a prompt still saying @new1
 * after the rename matches nothing, loses its '@' in the worker, and renders
 * without the reference — no error, no warning, just a clip that quietly
 * stopped looking like the person. The rewrite is scoped to scenes in THIS
 * USER's own projects, since a tag only ever resolves against its owner's
 * elements.
 */
export async function updateElement(formData: FormData): Promise<ActionResult> {
  const { user, profile, project } = await resolveElementScope(formData);

  const elementId = String(formData.get("elementId") ?? "").trim();
  if (!elementId) return { error: "No reference to update." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "A reference needs a name — it's what you type as @name." };
  if (name.length > 64) return { error: "That name is too long — keep it under 64 characters." };
  // The same shape TAG_PATTERN will accept when the operator types it back.
  // Without this an element could be named "my ref" and be permanently
  // unreachable from a prompt, which reads as the rename having silently
  // failed.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    return { error: "Use letters, numbers, - and _ only, starting with a letter or number." };
  }

  const categoryRaw = String(formData.get("category") ?? "");
  if (!isElementCategory(categoryRaw)) {
    return { error: "Pick a category: character, product, location, or voice." };
  }

  const description = String(formData.get("description") ?? "").trim() || null;

  const admin = createAdminClient();

  const { data: element, error: readError } = await admin
    .from("elements")
    .select("id, name, user_id")
    .eq("id", elementId)
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) throw new Error(`Failed to read reference: ${readError.message}`);
  // Checked explicitly rather than leaned on RLS: this runs on the admin
  // client, which has none.
  //
  // THE OWNER, OR AN ADMIN (0091_shared_elements_library.sql). Admins edit here,
  // not only delete, because correcting a bad description or a misleading @name
  // in a shared library is expected of them.
  //
  // BROWSING IS NOT EDITING. Every other account reads this row since 0091 and
  // none of them reach this line: a shared library does not authorise changing
  // somebody else's tags, and this compare is what says so on the one client
  // that could ignore the policy.
  //
  // What an admin edit costs is paid below rather than dodged: a rename follows
  // the tag through the OWNER's prompts, so it repairs that person's scenes
  // instead of leaving them pointing at a name that no longer resolves.
  if (!element || (element.user_id !== user.id && !isAdmin(profile))) {
    return { error: "That saved reference is no longer available." };
  }

  const { error: updateError } = await admin
    .from("elements")
    .update({ name, description, category: categoryRaw })
    .eq("id", elementId)
    .is("deleted_at", null);

  if (updateError) {
    if (updateError.code === "23505") {
      // "You" is wrong when an admin is editing somebody else's row: the
      // collision is against the OWNER's names, since `unique (user_id, name)`
      // is per-owner and the admin's own library is not involved.
      return {
        error:
          element.user_id === user.id
            ? `You already have a reference named "${name}" — pick a different name.`
            : `That account already has a reference named "${name}" — pick a different name.`,
      };
    }
    throw new Error(`Failed to update "${name}": ${updateError.message}`);
  }

  // ALWAYS scoped to this user's OWN projects, and unchanged by the guard
  // split: the rewrite follows the rename through every prompt the owner has
  // written, not through the one project the request happened to arrive from.
  // A rename made on /elements has to reach the same scenes a rename made in
  // the picker does, or the library becomes a way to silently break prompts.
  if (element.name !== name) {
    // THE OWNER'S PROMPTS, NOT THE CALLER'S. These are the same id whenever
    // the owner is editing their own row; they differ only when an admin edits
    // somebody else's, and that is exactly the case where passing user.id would
    // be wrong twice over — it would rewrite the ADMIN's scenes, which never
    // mentioned this tag, and leave the owner's scenes pointing at a name that
    // no longer resolves.
    await rewriteTagInOwnPrompts(admin, element.user_id, element.name, name);
  }

  revalidateElementSurfaces(project?.id ?? null);
  return undefined;
}

/**
 * Follows a rename through every prompt this user has already written.
 *
 * Reads and rewrites in JS rather than a SQL replace() for the reason
 * lib/rename-tag.ts exists: "@lena" must not eat the front of "@lena_ref", and
 * a bare `replace(video_prompt, '@lena', '@jen')` does exactly that. The rows
 * are few — one per scene the operator made — and this runs once per rename.
 *
 * Failures here are logged, not thrown. The rename itself has already
 * succeeded and is the thing the operator asked for; leaving them with an
 * error after a completed rename would say it did not happen.
 */
async function rewriteTagInOwnPrompts(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  from: string,
  to: string,
): Promise<void> {
  const { data: projects, error: projectsError } = await admin
    .from("projects")
    .select("id")
    .eq("user_id", userId);
  if (projectsError || !projects?.length) return;

  const { data: scenes, error: scenesError } = await admin
    .from("scenes")
    .select("id, video_prompt")
    .in(
      "project_id",
      projects.map((p) => p.id),
    );
  if (scenesError || !scenes?.length) return;

  for (const scene of scenes) {
    const prompt = scene.video_prompt ?? "";
    if (!promptMentionsTag(prompt, from)) continue;
    const { error } = await admin
      .from("scenes")
      .update({ video_prompt: renameTagInPrompt(prompt, from, to) })
      .eq("id", scene.id);
    if (error) {
      console.warn(`updateElement: could not follow the rename into scene ${scene.id}`, error);
    }
  }
}

/**
 * Forgets a saved reference.
 *
 * DELETES THE ELEMENT, NOT THE PICTURE IT CAME FROM. `elements.asset_id`
 * points at an asset that generateClip COPIES rather than references — every
 * scene that used this reference holds its own copy under its own project —
 * so removing the row cannot reach back into a clip that already rendered, or
 * into the reference frame stored beside it. A deleted element is a name that
 * stops resolving, and nothing more.
 *
 * The asset row is left alone on purpose. It may be the same asset another
 * element points at (two names for one upload is a thing operators do), and
 * this action has no way to know that without a scan it should not be doing
 * on a delete. An orphaned asset costs storage; a wrongly deleted one costs
 * somebody's reference frame.
 *
 * WHAT AN OPERATOR SHOULD EXPECT AFTERWARDS: a prompt still saying "@jen"
 * renders. The tag resolves to nothing, no description is substituted, and
 * the worker's bindUITags strips the "@" so the word passes through as
 * ordinary text. That is the same behaviour a typo has always had here, and
 * it is deliberately not an error — a clip half-written against a reference
 * the operator just removed should not become unrenderable.
 *
 * Guard: resolveElementScope — requireProject when the picker supplies a
 * project, requireUser when the Elements Library does not — plus, in both
 * cases, the explicit ownership compare below. That compare is the one doing
 * the work: neither guard ever proved anything about this ELEMENT, only about
 * the caller, so a forged element id is refused by the same line whichever door
 * the request came through.
 *
 * OWNER, OR AN ADMIN (0091_shared_elements_library.sql). The library is readable
 * by every account now, so it can hold something that has to come out whose
 * owner is unavailable — or is the reason it has to come out. `elements_delete`
 * admits `is_admin()` for that, and this is the matching half on the client that
 * actually performs the write (the admin client has no RLS, so the policy alone
 * would gate nothing here).
 *
 * updateElement carries the SAME pair since 0091, so there is no
 * edit-versus-remove asymmetry left in this file. What lets edit be handed to an
 * admin at all is the rewrite below the compare in updateElement: a rename
 * follows the OWNER's prompts, so an admin correcting a name repairs that
 * account's scenes rather than breaking them.
 *
 * A reader who is neither owner nor admin reaches this function with a real
 * element id and is still refused, which is the whole point of a library that is
 * shared to READ.
 */
export async function deleteElement(formData: FormData): Promise<ActionResult> {
  const { user, profile, project } = await resolveElementScope(formData);

  const elementId = String(formData.get("elementId") ?? "").trim();
  if (!elementId) return { error: "No reference to remove." };

  const admin = createAdminClient();
  const { data: element, error: readError } = await admin
    .from("elements")
    .select("id, name, user_id")
    .eq("id", elementId)
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) throw new Error(`Failed to read that reference: ${readError.message}`);
  if (!element || (element.user_id !== user.id && !isAdmin(profile))) {
    return { error: "That saved reference is no longer available." };
  }

  const { error: deleteError } = await admin
    .from("elements")
    .update({ deleted_at: new Date().toISOString(), deleted_by: user.id })
    .eq("id", element.id)
    .is("deleted_at", null);
  if (deleteError) {
    throw new Error(`Failed to remove "${element.name}": ${deleteError.message}`);
  }

  revalidateElementSurfaces(project?.id ?? null);
  return undefined;
}
