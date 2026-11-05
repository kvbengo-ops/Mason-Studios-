"use server";

// An operator's own reusable @tag library (0065_elements.sql), reached from
// two places and owned by neither: the /ugc reference picker
// (components/ugc-reference-picker.tsx), which has a project, and the
// Elements Library at /elements, which does not.
//
// Spends nothing directly — no vendor is called, nothing is queued — except
// the one describe registerElement makes on a just-saved reference: Claude for
// a picture, kie's Gemini pass for a voice clip (lib/kie-audio-describe.ts) and
// now for a video clip too (lib/kie-video-describe.ts). All three go through
// assertWithinSpendCaps like every other paid call.
//
// The video describer is not a copy of the audio one in the way its filename
// suggests. kie's Gemini endpoint, handed a clip it cannot decode, does not
// fail — it returns 200 with a confident and entirely invented description and
// bills for it. That module refuses anything whose usageMetadata reports too
// few prompt tokens to have read a video at all; read its header before
// touching either path.
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
import type { ActionNotice, ActionResult } from "@/lib/action-result";
import type { ElementCategory } from "@/types/db";
import { assertWithinSpendCaps } from "@/lib/spend";
import { CLAUDE_SONNET_5, describeReferenceCostUsd, getCompilerModel } from "@/lib/models";
import { CLAUDE_VENDOR, describeReferenceImage } from "@/lib/claude";
import {
  AUDIO_DESCRIBE_ESTIMATE_USD,
  AUDIO_DESCRIBE_MODEL,
  AudioDescribeUnusableError,
  describeReferenceAudio,
} from "@/lib/kie-audio-describe";
import {
  VIDEO_DESCRIBE_ESTIMATE_USD,
  VIDEO_DESCRIBE_MODEL,
  VideoDescribeUnusableError,
  describeReferenceVideo,
} from "@/lib/kie-video-describe";
import { elementUploadNameError } from "@/lib/element-upload-name";
import { recordRun } from "@/lib/runs";
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
 * Voice elements accept the same image types as character/product today —
 * there is no audio upload path here. This used to say the reason was that
 * "kie has no known audio input at all"; that is false. kie's schema for
 * bytedance/seedance-2-5 carries reference_audio_urls. The reason is ours:
 * assets.kind has no audio member, so an mp3 has nowhere to be stored, and
 * that is a migration rather than a form change.
 *
 * A "voice" element today is therefore a placeholder an operator can name
 * and describe (e.g. a headshot standing in for a narrator), not a
 * functioning audio clip — the same behaviour, an honest reason.
 *
 * The operator is told this in components/ugc-reference-picker.tsx, beside
 * the category selector, and that note is load-bearing rather than polite:
 * without it the word "Voice" on a save control is a promise nothing keeps.
 * This comment used to cite "ugc-column.tsx's InfoHint" as where the telling
 * happened. There is no such hint — that file has never contained the word
 * audio — so for as long as this said so, the justification was resting on a
 * control nobody had built.
 */
/**
 * Describes a just-uploaded reference, or gives up quietly.
 *
 * The same call the "Generate AI description" button made, moved to where the
 * upload happens — because the button is gone. An operator no longer chooses
 * to describe; every saved reference is described, since a tag with no
 * description substitutes to nothing and steers no render.
 *
 * RETURNS null RATHER THAN THROWING. This runs inside a save that has already
 * put bytes in storage, and the description is the one part of an element that
 * can be redone later at any time from the card. Losing the upload because
 * Claude was over its cap or having a bad minute would be trading the
 * expensive, irreplaceable half for the cheap, repeatable one.
 */
async function describeOnSave(
  image: File,
  category: ElementCategory,
  name: string,
  /**
   * null when the upload came from the Elements Library. The run is then
   * attributed by `runs.user_id` instead (0085), which every per-user spend
   * read resolves as coalesce(runs.user_id, projects.user_id) — so a describe
   * paid for from /elements counts against the same weekly allowance one paid
   * for from the picker does. Without that column this call would be a real
   * charge invisible to the caps.
   */
  projectId: string | null,
  userId: string,
  profile: Parameters<typeof assertWithinSpendCaps>[1],
): Promise<string | null> {
  // THE CAP, BEFORE THE SPEND — the same sequence describeUploadedReference
  // follows. Over cap is a reason not to describe, never a reason to refuse
  // the upload.
  const compilerModel = getCompilerModel(CLAUDE_SONNET_5.id);
  const costUsd = describeReferenceCostUsd(compilerModel);
  if (await assertWithinSpendCaps(userId, profile, costUsd)) return null;

  try {
    const described = await describeReferenceImage({
      imageBase64: Buffer.from(await image.arrayBuffer()).toString("base64"),
      mediaType: image.type,
      name,
      category,
    });
    await recordRun({
      projectId,
      userId,
      vendor: CLAUDE_VENDOR,
      model: CLAUDE_SONNET_5.id,
      costUsd,
    });
    return described.description;
  } catch (err) {
    await recordRun({
      projectId,
      userId,
      vendor: CLAUDE_VENDOR,
      model: CLAUDE_SONNET_5.id,
      // Null, not zero: a failed call may still have been billed, and zero
      // would assert it was not.
      costUsd: null,
      error: err instanceof Error ? err.message : "describe failed",
    });
    return null;
  }
}

/**
 * Audio's sibling to describeOnSave above. Same discipline end to end — cap
 * checked before the spend, recordRun on every call that could have cost
 * money, a failed or over-cap describe saves the element with description
 * null rather than losing the upload — but a different vendor: kie's Gemini
 * pass (lib/kie-audio-describe.ts's describeReferenceAudio), which LISTENS
 * to the clip, not Claude looking at a picture. See registerElement's own
 * comment above the call site for why an audio upload went undescribed
 * until now and why that no longer holds.
 *
 * THE ESTIMATE IS KIE'S, NOT THE COMPILER'S. describeReferenceCostUsd prices
 * a Claude compile; kie's own measured receipt for one clip is roughly 100x
 * cheaper (AUDIO_DESCRIBE_ESTIMATE_USD's own comment has the math), and
 * checking the cap against the wrong vendor's number would either block an
 * upload that costs almost nothing or, the other direction, let a genuinely
 * expensive call through uncapped. actions/ugc.ts's redescribeElement draws
 * the identical line for the same reason.
 *
 * ONE RETRY, AND ONLY FOR A FAILURE THAT LEARNED NOTHING ABOUT THE CLIP. An
 * operator who uploads a voice clip and walks away — the whole premise of
 * moving describe to upload — will never see a transient network blip or a
 * kie 5xx and press Describe again themselves, so this function makes the one
 * retry a person would have. AudioDescribeUnusableError is excluded on
 * purpose: that is not a failure to reach kie, it is kie's own verdict,
 * reached AND BILLED, that the clip itself is unusable (silence, music with
 * no speech, buried in noise). A second call would not ask a different
 * question — it would pay a second time to hear the same answer.
 *
 * `attempted` tells registerElement whether a description was tried and came
 * back nothing (worth telling the operator about right away) versus never
 * tried at all because the cap refused it (the same "saved, undescribed,
 * Describe still works" state an element has always been able to land in,
 * and not news).
 */
async function describeAudioOnSave(
  audio: File,
  category: ElementCategory,
  name: string,
  projectId: string | null,
  userId: string,
  profile: Parameters<typeof assertWithinSpendCaps>[1],
): Promise<{ description: string | null; attempted: boolean }> {
  if (await assertWithinSpendCaps(userId, profile, AUDIO_DESCRIBE_ESTIMATE_USD)) {
    return { description: null, attempted: false };
  }

  const audioBase64 = Buffer.from(await audio.arrayBuffer()).toString("base64");
  const mediaType = audio.type;

  // ONE ROW PER CALL THAT COULD HAVE SPENT MONEY, never folded together —
  // two attempts that each reached kie are two charges (or two possible
  // charges), and a ledger that only remembers the last one understates
  // what this upload actually cost.
  async function recordAttempt(costUsd: number | null, error?: string): Promise<void> {
    await recordRun({
      projectId,
      userId,
      vendor: "kie",
      model: AUDIO_DESCRIBE_MODEL,
      costUsd,
      error,
    });
  }

  async function attempt(): Promise<{ description: string } | { failed: true; err: unknown }> {
    try {
      const described = await describeReferenceAudio({ audioBase64, mediaType, name, category });
      // The REAL metered credits_consumed kie returned, never the estimate
      // the cap was checked against — mirrors describeReferenceAudio's own
      // contract (see its DescribeReferenceAudioResult.costUsd comment).
      await recordAttempt(described.costUsd);
      return { description: described.description };
    } catch (err) {
      // Null is the honest "billed an unknown amount" for almost every
      // failure here. AudioDescribeUnusableError is the one exception: kie
      // listened to the clip, reported what that cost in the same response,
      // and only then said the clip was no good — recording null there would
      // throw away a real receipt. Same rule redescribeElement's catch
      // follows for this identical error.
      await recordAttempt(
        err instanceof AudioDescribeUnusableError ? err.costUsd : null,
        err instanceof Error ? err.message : "describe failed",
      );
      return { failed: true, err };
    }
  }

  const first = await attempt();
  if ("description" in first) return { description: first.description, attempted: true };
  if (first.err instanceof AudioDescribeUnusableError)
    return { description: null, attempted: true };

  // TRANSIENT ONLY REACHES HERE — a network error, a non-2xx, a body that
  // would not parse. Exactly one more try, not a loop: a second failure is
  // treated the same as any other failed describe, not escalated further.
  const second = await attempt();
  if ("description" in second) return { description: second.description, attempted: true };
  return { description: null, attempted: true };
}

/**
 * Video's sibling to describeAudioOnSave just above — same discipline,
 * same shape, copied on purpose rather than generalised into one function
 * with a vendor parameter: the two callers each pass a different describer
 * (lib/kie-video-describe.ts's describeReferenceVideo instead of
 * describeReferenceAudio) and a different error class to exclude from the
 * retry, and a shared function threading both through generics would cost
 * more to read than the duplication does.
 *
 * THE ESTIMATE, THE CAP, AND WHY BOTH ARE SAFE HERE. Same reasoning as
 * describeAudioOnSave's own comment: VIDEO_DESCRIBE_ESTIMATE_USD is kie's
 * own measured receipt (its comment has the math — roughly $0.0002), not a
 * guess, and checking the cap against it rather than against
 * describeReferenceCostUsd (a Claude compile price) is what keeps a
 * genuinely cheap call from being blocked by a cap sized for a different
 * vendor's number.
 *
 * WHY THIS CAN NOW EXIST WHEN IT COULDN'T BEFORE. registerElement's own
 * comment above the kind === "video" branch has the full story — kie's
 * Gemini pass was verified against real video/mp4 clips on 2026-09-09 and
 * turned out to accept them exactly the way it accepts audio. What this
 * function additionally has to respect, that describeAudioOnSave does not,
 * is the invention band lib/kie-video-describe.ts's header documents: kie
 * can return a fully-formed, confidently wrong description at HTTP 200 for
 * a clip its media part silently dropped. describeReferenceVideo carries
 * both guards against that (a size check before the call, a
 * promptTokenCount check after) and this function does nothing to weaken
 * either — it only has to treat VideoDescribeUnusableError, the guards'
 * shared failure mode, the same way describeAudioOnSave treats
 * AudioDescribeUnusableError below.
 *
 * ONE RETRY, and the SAME exclusion describeAudioOnSave makes, for the
 * same reason: VideoDescribeUnusableError is not a failure to reach kie, it
 * is kie's own verdict — reached, and (when the size guard didn't fire
 * first) billed — that the clip could not be read. A retry would not ask a
 * different question, it would pay a second time to hear the same answer.
 * A too-large clip never reaches kie at all (costUsd null, nothing spent),
 * so excluding it from the retry costs nothing extra either.
 *
 * `attempted` carries the same meaning it does for audio: false means the
 * cap refused the call before anything was spent (the ordinary, unremarkable
 * "saved undescribed" state an element could already land in); true with a
 * null description means a call was made and lost, which is the one case
 * `videoNeedsDescription` below tells the operator about at save time.
 */
async function describeVideoOnSave(
  video: File,
  category: ElementCategory,
  name: string,
  projectId: string | null,
  userId: string,
  profile: Parameters<typeof assertWithinSpendCaps>[1],
): Promise<{ description: string | null; attempted: boolean }> {
  if (await assertWithinSpendCaps(userId, profile, VIDEO_DESCRIBE_ESTIMATE_USD)) {
    return { description: null, attempted: false };
  }

  const videoBase64 = Buffer.from(await video.arrayBuffer()).toString("base64");
  const mediaType = video.type;

  // ONE ROW PER CALL THAT COULD HAVE SPENT MONEY — same ledger discipline
  // describeAudioOnSave's identical helper explains: two attempts that each
  // reached kie are two charges (or two possible charges), and folding them
  // into one recorded row would understate what this upload actually cost.
  async function recordAttempt(costUsd: number | null, error?: string): Promise<void> {
    await recordRun({
      projectId,
      userId,
      vendor: "kie",
      model: VIDEO_DESCRIBE_MODEL,
      costUsd,
      error,
    });
  }

  async function attempt(): Promise<{ description: string } | { failed: true; err: unknown }> {
    try {
      const described = await describeReferenceVideo({ videoBase64, mediaType, name, category });
      // The REAL metered credits_consumed kie returned, never the estimate
      // the cap was checked against — mirrors describeReferenceVideo's own
      // DescribeReferenceVideoResult.costUsd contract.
      await recordAttempt(described.costUsd);
      return { description: described.description };
    } catch (err) {
      // Null is the honest "billed an unknown amount" for almost every
      // failure here. VideoDescribeUnusableError is the one exception: it
      // carries its own costUsd — null when the size guard rejected the
      // clip before any network call, the real credits_consumed when kie
      // read the clip and only then said it was unusable — and recording
      // null there instead would throw away a real receipt on the branch
      // where one exists.
      await recordAttempt(
        err instanceof VideoDescribeUnusableError ? err.costUsd : null,
        err instanceof Error ? err.message : "describe failed",
      );
      return { failed: true, err };
    }
  }

  const first = await attempt();
  if ("description" in first) return { description: first.description, attempted: true };
  if (first.err instanceof VideoDescribeUnusableError)
    return { description: null, attempted: true };

  // TRANSIENT ONLY REACHES HERE — a network error, a non-2xx, a body that
  // would not parse. Exactly one more try, not a loop: a second failure is
  // treated the same as any other failed describe, not escalated further.
  const second = await attempt();
  if ("description" in second) return { description: second.description, attempted: true };
  return { description: null, attempted: true };
}

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

export async function registerElement(formData: FormData): Promise<ActionResult | ActionNotice> {
  const { project, user, profile } = await resolveElementScope(formData);
  await resolveStagedUploads(formData, user.id);

  const name = String(formData.get("name") ?? "").trim();
  const categoryRaw = String(formData.get("category") ?? "");
  const givenDescription = String(formData.get("description") ?? "").trim() || null;

  const image = formData.get("image");
  if (!(image instanceof File) || image.size === 0) {
    return { error: "Attach a picture, a voice clip or a video to save as a reference." };
  }

  // A REFERENCE IS NOW ONE OF THREE THINGS, and which one decides nearly
  // everything that follows: the accept/reject guard, the category default,
  // which describer (if any) runs, the size ceiling and its error copy, the
  // assets.kind value, the auto-name prefix, and the failure/success notice
  // returned at the bottom. This used to be a boolean (`isAudio`) — sound
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
  const nameError = await elementUploadNameError(admin, user.id, name);
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

  // THE DESCRIPTION IS THE POINT OF THE ELEMENT, so it is generated here
  // rather than left for the operator to remember: a tag whose description is
  // null substitutes to nothing and steers no render (see actions/ugc.ts's
  // resolveElementTags). Only when none was typed.
  //
  // A FAILED DESCRIBE MUST NOT LOSE THE UPLOAD. It is one Claude call on a
  // capped budget, and it can fail for reasons that have nothing to do with
  // the picture — over cap, vendor down, a bad response. The element is saved
  // either way with description null, and the card offers "Describe" to try
  // again, which is exactly the state an element saved before this change was
  // already in.
  // AUDIO USED TO SKIP THIS ENTIRELY, on reasoning that held for a while and
  // no longer does. The trap this comment used to warn about was real:
  // describeOnSave hands its bytes to Claude as an IMAGE, and an MP3 sent
  // that way comes back either a vendor error or, worse, a confident
  // paragraph about a picture that does not exist. THAT HALF IS STILL TRUE —
  // an mp3 must never reach describeReferenceImage, audio or not, and
  // describeAudioOnSave (defined just above describeOnSave's own comment)
  // is a separate function for exactly that reason, not a branch inside it.
  //
  // What changed is the other half. "A voice reference does not need prose
  // anyway" stopped being true the moment worker/internal/loop/dispatch.go's
  // bindUITags shipped: it DELETES an audio tag outright rather than
  // degrading it to a bare name the way an image tag degrades, so an
  // @voice1 with no description leaves a hole in the prompt — "Dialogue
  // audio sourced entirely from ." The description is not decoration for an
  // audio element, it is the ONLY thing that fills that hole, which is what
  // lib/kie-audio-describe.ts's describeReferenceAudio (kie's Gemini pass,
  // listening rather than looking) now exists to write.
  // AUDIO DESCRIBE FAILED is tracked separately from a plain null description
  // — an operator who typed nothing ever, or landed over cap, is not news;
  // one who just watched an upload try and fail is, and the return value
  // below is how that reaches the picker without another database column.
  //
  // VIDEO NOW GETS A REAL DESCRIBE CALL TOO — this paragraph used to say
  // the opposite, and explained why: no vendor here could read a video. That
  // stopped being true on 2026-09-09, when kie's live Gemini API was probed
  // directly with real video/mp4 clips and turned out to accept them the
  // exact same way it accepts audio — same endpoint, same model, same key
  // (lib/kie-video-describe.ts's header carries the receipts). The Anthropic
  // SDK vendored here (lib/claude.ts) still has no video content block, so
  // describeReferenceImage still cannot be handed a video's bytes — that
  // half never changed and describeVideoOnSave, video's own sibling to
  // describeAudioOnSave defined just above it, is a separate function for
  // exactly that reason, same as audio's.
  //
  // THE CATCH THAT SIZED MAX_REFERENCE_VIDEO_BYTES. Above ~18.75MB raw, kie
  // stops reading the clip and silently answers from the instruction text
  // alone — a confident, entirely invented description, still HTTP 200,
  // still billed. lib/kie-video-describe.ts's describeReferenceVideo carries
  // its own two guards against that (a size check before the call, a
  // usageMetadata.promptTokenCount check after), but this function never
  // gets to see either one fire on a file too big to have been uploaded in
  // the first place: lib/file-type.ts's MAX_REFERENCE_VIDEO_BYTES was
  // lowered from 25MB to 15MB in the same change specifically so that every
  // video an operator CAN upload here sits inside the band the describer can
  // trust. The two constants are meant to move together — see
  // MAX_REFERENCE_VIDEO_BYTES's own comment.
  //
  // A DESCRIBE THAT FAILS STILL MUST NOT LOSE THE UPLOAD, same rule the
  // paragraph above states for audio and image — over cap, vendor down, a
  // bad response, or VideoDescribeUnusableError (kie's own verdict that the
  // clip could not be read, reached and possibly billed rather than a
  // failure to reach kie at all) all leave the element saved with
  // description null rather than losing the file. See `videoNeedsDescription`
  // below for how the operator hears about the one case worth telling them
  // about — a describe that was actually tried and lost — versus the
  // ordinary "saved undescribed, over cap" state that was never news for
  // audio either.
  let audioDescribeFailed = false;
  let videoNeedsDescription = false;
  let description: string | null;
  if (givenDescription) {
    description = givenDescription;
  } else if (kind === "audio") {
    const described = await describeAudioOnSave(
      image,
      category,
      resolvedName,
      project?.id ?? null,
      user.id,
      profile,
    );
    description = described.description;
    audioDescribeFailed = described.attempted && described.description === null;
  } else if (kind === "video") {
    const described = await describeVideoOnSave(
      image,
      category,
      resolvedName,
      project?.id ?? null,
      user.id,
      profile,
    );
    description = described.description;
    videoNeedsDescription = described.attempted && described.description === null;
  } else {
    description = await describeOnSave(
      image,
      category,
      resolvedName,
      project?.id ?? null,
      user.id,
      profile,
    );
  }

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

  // WHAT THE PRICING FORMULA NEEDS AND NOBODY WAS SENDING. kie bills a
  // render carrying a video reference at Price x (Input + Output), not
  // Price x Output alone (lib/kie/rates.ts's VIDEO_INPUT_PRICING), and
  // "Input" is THIS FILE's own duration — a number this action never asked
  // for until now. Read off the form rather than probed here: this action
  // has no ffprobe or equivalent, and downloading the file back out of
  // `image` to decode it server-side would cost a second read of bytes
  // already in hand for nothing an operator's own browser can't already
  // tell us — components/ugc-reference-picker.tsx's videoDurationSeconds
  // (the video twin of audioDurationSeconds, added alongside this) decodes
  // the file with a <video> element before it ever leaves the browser and
  // sends the result as this field.
  //
  // A CLIENT-SUPPLIED NUMBER IS NOT A RECEIPT, and that gap is left open
  // rather than papered over: nothing stops a forged small value from
  // reaching here, which would under-quote exactly the render this task
  // exists to protect. Closing that for real needs a server-side probe this
  // action does not have. What is NOT open is the failure-shut direction —
  // a missing, non-numeric or non-positive value becomes null, never 0 or a
  // guess, and lib/estimate.ts's estimateCost reads a null assets.duration_s
  // as license to over-quote the scene without limit rather than under-price
  // it.
  const durationSRaw = Number(formData.get("durationS"));
  const measuredVideoDurationS =
    Number.isFinite(durationSRaw) && durationSRaw > 0 ? durationSRaw : null;
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
      duration_s: kind === "video" ? measuredVideoDurationS : null,
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

  // THE UPLOAD SUCCEEDED — this is an ActionNotice, never an error. The
  // element exists, is usable by name, and Describe still works from its
  // card; what would be dishonest is staying silent about the one thing that
  // did not happen, on a feature built specifically because operators do not
  // go looking for a Describe button on their own.
  if (audioDescribeFailed) {
    return {
      notice: `@${resolvedName} saved, but its voice could not be described — press Describe on its card to try again.`,
    };
  }
  // SAME SHAPE AS audioDescribeFailed ABOVE, now for the same reason too —
  // videoNeedsDescription is only true when describeVideoOnSave actually
  // tried and lost (attempted && description === null), never for the
  // ordinary over-cap "saved undescribed" state, which was never news for
  // audio either and isn't for video now.
  //
  // This sentence said "write its description from the card" until the retry
  // it was hedging about actually landed: redescribeElement (actions/ugc.ts)
  // now routes a 'video_ref' asset to describeReferenceVideo exactly as it
  // routes audio, in the same commit. The two halves were written by
  // different hands and the copy was the half that went stale — which is the
  // worse direction for it to go, because an operator who is told to write a
  // description by hand does not go looking for the button that would have
  // done it, and never finds out the product can.
  if (videoNeedsDescription) {
    return {
      notice: `@${resolvedName} saved, but its video could not be described — press Describe on its card to try again.`,
    };
  }
  return undefined;
}

/**
 * Corrects a saved reference: its name, its category, its description.
 *
 * THIS IS WHERE ALL THREE UPLOAD DEFAULTS GET UNDONE. registerElement no
 * longer asks for any of them — it writes newN, "character", and whatever
 * Claude saw — so without this the operator would have no way to reach any of
 * it, and @new7 would be a name they had to type into prompts for good.
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
