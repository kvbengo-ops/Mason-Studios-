"use server";

// /ugc's one write — a single clip, from a prompt and an image, with no
// compiler and no brief.
//
// WHY THIS EXISTS. The wizard builds a prompt out of an operator's answers,
// which is the right shape for someone who does not know what to write and
// lossy compression for someone who does. It is also the wrong shape for how
// clips are actually made here: paste a prompt, attach an image, generate a
// four-second take, download it, repeat, then assemble in CapCut — which is
// also where the subtitles come from. Compile, reference-frame generation,
// ffmpeg assembly, captions and delivery are machinery that workflow never
// touches.
//
// So this is not a shortcut through the pipeline. It is a shorter pipeline
// that skips most of it and reaches the queue at exactly the same place.
//
// WHAT IT DELIBERATELY DOES NOT SKIP. Writing scenes.status = 'queued' is the
// entire render trigger: the worker's ClaimQueuedScenes selects on that value
// and nothing else, with no ownership check, no cap check and no route check
// of its own. Every guard in this product lives in TypeScript, in
// actions/enqueue.ts, and NOTHING mechanically enforces that a new writer
// copies them — there is no sweep test asserting that a file writing 'queued'
// calls assertWithinSpendCaps. A /ugc that skipped the sequence would be a
// spend button with no cap behind it, and it would ship green.
//
// The sequence below is copied from enqueueScene (enqueue.ts:454), which runs
// all four shape guards. It is deliberately NOT copied from retryScene or
// retryAllFailed, which run none of them.
//
// The queued write also sets `dev: isDev()`, same as every status='queued'
// write in enqueue.ts (see that file's own header for the full MODE/scenes.dev
// incident) — this file is a second, independent writer of that same status
// value and was not covered by "every write in enqueue.ts" the first time
// this contract landed. A worker claims only rows whose `dev` matches its
// own MODE (worker/internal/store/store.go's ClaimQueuedScenes); leaving it
// off here would default a locally-mocked clip to dev=false and hand it to
// the deployed production worker to render and bill for real, the exact
// incident lib/mode.ts's header describes.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import {
  isAcceptedReferenceAudio,
  isAcceptedReferenceAudioSize,
  isAcceptedReferenceVideo,
  isAcceptedReferenceVideoSize,
} from "@/lib/file-type";
import {
  buildStorageKey,
  copyStorageObject,
  extFromFilename,
  removeStorageObjects,
  resolveStagedUploads,
  signedUrl,
  uploadFile,
} from "@/lib/storage";
import {
  binRetentionCutoffIso,
  extractArchivedStorageKeys,
  isBinEntryExpired,
} from "@/lib/bin-thumbnails";
import { estimateCost } from "@/lib/estimate";
import { KLING_FRAME_EXTS } from "@/lib/elements";
// The one place "picture, not video or audio" is already enumerated off
// AssetKind — reused by both firstTaggedImageElementId and
// attachSceneReferences below so a conditioning-frame allowlist and a
// scene_references allowlist can't quietly drift apart the way a hand-picked
// second copy eventually would.
import { IMAGE_ASSET_KINDS } from "@/lib/asset-kinds";
import { MAX_REFERENCES } from "@/lib/ugc-references";
import { supportsPromptOnlyVideo } from "@/lib/prompt-only-video";
import { getModel, isAudioEnabled, mergeRenderSettings } from "@/lib/models";
import { assertWithinSpendCaps, type queueScenesIfWithinCaps } from "@/lib/spend";
import { recordRun } from "@/lib/runs";
import {
  assertAllFramed,
  assertNotAlreadySpent,
  assertRenderableDurations,
  assertSettingsAllowedForDurations,
} from "@/lib/enqueue-guard";
import { guardResult, type ActionResult } from "@/lib/action-result";
import type { AssetKind } from "@/types/db";
import {
  declareAudioTags,
  descriptionFor,
  substituteElementTags,
  tagsInOrder,
} from "@/lib/element-tags";
import { isDev } from "@/lib/mode";
import { openSceneVersion, rerenderScene, retryScene } from "@/actions/enqueue";
import { requireAdmin, requireProject, requireScene, requireUser } from "@/actions/guard";
import type { Database, SceneStatus } from "@/types/db";
import { offerable } from "@/lib/kie/offerable";
import { videoAspectRatioFor } from "@/lib/kie/models";
import { videoQualityFor } from "@/lib/video-quality";
import { canUseVideoModel } from "@/lib/model-access";
import { MAX_PROMPT_CHARS } from "@/lib/prompt-limits";
import {
  BYTEPLUS_SEEDANCE_ID,
  BYTEPLUS_SEEDANCE_QUALITY,
  byteplusResolutionRefusal,
} from "@/lib/ugc-model-rules";
import { geminiOmniVideoInputPaid } from "@/lib/kie/rates";
import { ugcTierLabel } from "@/lib/ugc-tier-label";
import {
  IMAGE_DESCRIBE_ESTIMATE_USD,
  IMAGE_DESCRIBE_MODEL,
  KieImageDescribeError,
  describeReferenceImage,
} from "@/lib/kie-image-describe";
import { geminiVoiceFor } from "@/lib/gemini-voices";
import {
  AUDIO_DESCRIBE_ESTIMATE_USD,
  AUDIO_DESCRIBE_MODEL,
  AudioDescribeUnusableError,
  describeReferenceAudio,
} from "@/lib/kie-audio-describe";
import {
  MAX_DESCRIBABLE_VIDEO_BYTES,
  VIDEO_DESCRIBE_ESTIMATE_USD,
  VIDEO_DESCRIBE_MODEL,
  VideoDescribeUnusableError,
  describeReferenceVideo,
} from "@/lib/kie-video-describe";

/** Mirrors uploadCharacterRef's accepted set. */
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** 10 MB, the same ceiling the character and product reference uploads use. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Renders one clip. The money step.
 *
 * Ordering is load-bearing and is NOT enqueueScene's, because enqueueScene
 * validates a scene that already exists. Here the scene is created by this
 * same call, so the cap check runs BEFORE anything is written: a refusal must
 * not leave an orphan scene and an uploaded asset behind. The two guards that
 * need a real row run after the insert, against the row that was actually
 * written, which is where they mean anything.
 */

/**
 * What "Generate AI description" hands back: the text, or a message.
 *
 * Not ActionResult: this action's whole point is returning DATA on the happy
 * path. A message thrown from a Server Action is redacted in production, so a
 * refusal has to come back as a value or the operator reads nothing.
 */
export type DescribeResult = { description: string } | { error: string };

/**
 * Describes a picture the operator has chosen but not yet saved.
 *
 * THE ONE AI STEP IN THE WHOLE REFERENCE MECHANISM. It runs once, here, when
 * an element is created — and every prompt that later types "@name" is a
 * string substitution against what this wrote. That is why it is worth a
 * round trip at save time: the cost is paid once per element rather than once
 * per clip, and seven clips of the same character get one description of her
 * instead of seven slightly different ones.
 *
 * The result is NOT written to the database here. It goes back to the
 * textarea the operator is looking at, so they can read it, edit it, or throw
 * it away before pressing Save — a description they never saw would be a
 * strange thing to have quietly steering every future render.
 *
 * The file is carried as base64 rather than uploaded first: there is no
 * element and no asset yet, and uploading one for a description the operator
 * might discard would leave orphans in storage.
 *
 * Guard: requireProject, the strict owner-only check, because it spends.
 */
export async function describeUploadedReference(formData: FormData): Promise<DescribeResult> {
  const projectId = String(formData.get("projectId") ?? "");
  const { user, profile } = await requireProject(projectId);
  await resolveStagedUploads(formData, user.id);

  const image = formData.get("image");
  if (!(image instanceof File) || image.size === 0) {
    return { error: "Choose a file first — there is nothing to describe yet." };
  }
  if (!ACCEPTED_IMAGE_TYPES.includes(image.type)) {
    return { error: `${image.type || "That file"} is not a JPG, PNG or WebP.` };
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return { error: "That image is over 10 MB." };
  }

  const category = String(formData.get("category") ?? "").trim() || null;
  const name = String(formData.get("name") ?? "").trim() || undefined;

  // THE CAP, BEFORE THE SPEND. One describe is cheap, but a cap that only
  // some spending paths respect is not a cap — refineClipPrompt shipped
  // without this once and the money was invisible to every page that counts.
  const capResult = await assertWithinSpendCaps(user.id, profile, IMAGE_DESCRIBE_ESTIMATE_USD);
  if (capResult) {
    return { error: "error" in capResult ? capResult.error : "That would go over your spend cap." };
  }

  try {
    const described = await describeReferenceImage({
      imageBase64: Buffer.from(await image.arrayBuffer()).toString("base64"),
      mediaType: image.type,
      name,
      category,
    });
    await recordRun({
      projectId,
      vendor: "kie",
      model: IMAGE_DESCRIBE_MODEL,
      costUsd: described.costUsd,
    });
    return { description: described.description };
  } catch (err) {
    await recordRun({
      projectId,
      vendor: "kie",
      model: IMAGE_DESCRIBE_MODEL,
      // Null, not zero: a failed call may still have been billed, and zero
      // would assert it was not.
      costUsd: err instanceof KieImageDescribeError ? err.costUsd : null,
      error: err instanceof Error ? err.message : "describe failed",
    });
    return {
      error:
        err instanceof Error
          ? err.message
          : "Could not describe that picture. Write the description yourself, or try again.",
    };
  }
}

/**
 * Describes a SAVED element again, and stores the result.
 *
 * The one-shot describe at save time is not always the last word. The first
 * real element here was a three-panel turnaround, and the description written
 * for it opened "shown in three views... against a neutral grey background" —
 * an account of the PHOTOGRAPH, not of the woman in it. That text then went
 * into every prompt naming her, six times in one of them, telling the video
 * model she was standing in a grey studio while the rest of the prompt put
 * her in a kitchen.
 *
 * The system prompt has since been taught to refuse that shape, but a
 * description already written does not improve on its own, and there was no
 * way to ask for a new one: the describe button lives on an upload, and this
 * element was saved months of clips ago.
 *
 * WRITES, unlike describeUploadedReference, which hands its text back to a
 * textarea. There is no textarea here — the element already exists — so the
 * new description is saved and returned, and the operator judges it in place.
 * `description` is what the substitution reads, so that is what is set;
 * ai_description and its asset id are set alongside so the provenance stays
 * honest about which picture the words came from.
 *
 * assets.kind decides which Gemini describer to call: 'ref_frame' goes to
 * describeReferenceImage, 'audio' goes to describeReferenceAudio, and video
 * goes to describeReferenceVideo. All write the same two columns, so resolveElementTags below
 * does not need to know which model wrote a description —
 * it substitutes `description` regardless of kind, which is what makes an
 * @voice1 tag reach a prompt at all now that this exists to fill it in.
 *
 * Guard: requireProject, the strict owner check, because it spends.
 */
export async function redescribeElement(formData: FormData): Promise<DescribeResult> {
  const projectId = String(formData.get("projectId") ?? "").trim() || null;
  const { user, profile } = projectId ? await requireProject(projectId) : await requireUser();

  const elementId = String(formData.get("elementId") ?? "").trim();
  if (!elementId) return { error: "No reference to describe." };

  const admin = createAdminClient();
  // Ownership checked explicitly, the same way generateClip checks it: a
  // forged id is a clear refusal rather than a generic missing row.
  const { data: element, error: elementError } = await admin
    .from("elements")
    .select("id, name, category, asset_id, user_id")
    .eq("id", elementId)
    .is("deleted_at", null)
    .maybeSingle();
  if (elementError) throw new Error(`Failed to read reference: ${elementError.message}`);
  if (!element || element.user_id !== user.id) {
    return { error: "That saved reference is no longer available." };
  }

  const { data: asset } = await admin
    .from("assets")
    .select("storage_key, kind, bytes")
    .eq("id", element.asset_id)
    .maybeSingle();
  if (!asset) return { error: "That reference's file is missing." };

  // THREE VENDORS NOW (0093_video_reference_elements.sql +
  // lib/kie-video-describe.ts, 2026-09-09). This used to be a hard refusal
  // for 'video_ref' — no vendor reachable from this codebase could read a
  // video, so the feature that added video elements decided a human writes
  // the description by hand and a video element saves with description =
  // null until they do. kie's Gemini pass can now read one (verified against
  // its live API; see lib/kie-video-describe.ts's header), so the refusal is
  // gone and 'video_ref' routes to describeReferenceVideo below, the same
  // way 'audio' already routes to describeReferenceAudio. NOTHING about the
  // render path changes: a video element still never produces a
  // scene_references row and never reaches kie's render endpoint (kind's
  // CHECK constraint enforces that, untouched) — this only fills in the text
  // an @tag substitutes, same as it already does for audio and pictures.
  const isAudio = asset.kind === "audio";
  const isVideo = asset.kind === "video_ref";

  // THE SIZE GUARD, BEFORE THE SPEND-CAP CHECK AND BEFORE ANY NETWORK CALL.
  // describeReferenceVideo carries its own guard on the RAW bytes it
  // downloads (MAX_DESCRIBABLE_VIDEO_BYTES, lib/kie-video-describe.ts) —
  // that is the guard that actually protects every caller, because it runs
  // against bytes this process has actually read. This one is a cheaper,
  // earlier refusal for the case where the size is already sitting in the
  // assets row: no signed URL, no download, no kie call.
  //
  // In practice assets.bytes reads null for every video_ref uploaded so far
  // — registerElement (actions/elements.ts) inserts a new assets row without
  // ever setting `bytes`, so there is nothing here to compare yet, and this
  // check quietly no-ops (isVideo && typeof asset.bytes === "number" is
  // false) rather than pretending a size it doesn't have. That is fine, not
  // a hole: describeReferenceVideo's own guard still runs unconditionally
  // below and is what actually stands between an oversized clip and kie's
  // invention band (see that module's header, "THE DANGEROUS FINDING"). If
  // a future writer starts populating assets.bytes, this comparison starts
  // catching the obviously-too-large case here, for free, before a wasted
  // signed URL and an 11-23s round trip.
  if (isVideo && typeof asset.bytes === "number" && asset.bytes > MAX_DESCRIBABLE_VIDEO_BYTES) {
    return {
      error:
        "That video is too large to describe reliably " +
        `(over ${Math.round(MAX_DESCRIBABLE_VIDEO_BYTES / (1024 * 1024))}MB) — write the description yourself.`,
    };
  }

  // THE CAP, BEFORE THE SPEND, using the estimate for the selected media kind.
  const estimatedCostUsd = isAudio
    ? AUDIO_DESCRIBE_ESTIMATE_USD
    : isVideo
      ? VIDEO_DESCRIBE_ESTIMATE_USD
      : IMAGE_DESCRIBE_ESTIMATE_USD;
  const capResult = await assertWithinSpendCaps(user.id, profile, estimatedCostUsd);
  if (capResult) {
    return { error: "error" in capResult ? capResult.error : "That would go over your spend cap." };
  }

  const vendor = "kie";
  const model = isAudio
    ? AUDIO_DESCRIBE_MODEL
    : isVideo
      ? VIDEO_DESCRIBE_MODEL
      : IMAGE_DESCRIBE_MODEL;

  try {
    // Every describer's response carries a credits_consumed figure, so cost is the metered charge,
    // which may differ from the estimate in either direction and can itself
    // be null (kie reported nothing usable) — never coerced back to the
    // estimate, which would assert a number kie never actually billed.
    //
    // videoUrl, not videoBase64: the asset is already sitting in storage by
    // the time redescribeElement runs (unlike the describe-on-save path,
    // which still holds the upload as in-memory bytes before uploadFile
    // ever runs) — same reasoning as the audio branch immediately below,
    // signedUrl over base64. describeReferenceVideo downloads the bytes
    // itself from that URL (see lib/kie-video-describe.ts's header, "UNLIKE
    // describeReferenceImage") — there is no second download path to build
    // here.
    const described = isAudio
      ? await describeReferenceAudio({
          audioUrl: await signedUrl(asset.storage_key),
          name: element.name,
          category: element.category,
        })
      : isVideo
        ? await describeReferenceVideo({
            videoUrl: await signedUrl(asset.storage_key),
            name: element.name,
            category: element.category,
          })
        : await describeReferenceImage({
            imageUrl: await signedUrl(asset.storage_key),
            name: element.name,
            category: element.category,
          });

    const { error: writeError } = await admin
      .from("elements")
      .update({
        description: described.description,
        ai_description: described.description,
        ai_description_asset_id: element.asset_id,
      })
      .eq("id", element.id)
      .is("deleted_at", null);
    if (writeError) throw new Error(writeError.message);

    await recordRun({
      projectId,
      userId: projectId ? null : user.id,
      vendor,
      model,
      costUsd: described.costUsd,
    });
    revalidatePath(projectId ? `/ugc/${projectId}` : "/image-generator");
    return { description: described.description };
  } catch (err) {
    await recordRun({
      projectId,
      userId: projectId ? null : user.id,
      vendor,
      model,
      // NULL means "billed an unknown amount", and it is the right answer for
      // almost every failure here — a request that never landed, a body that
      // would not parse. AudioDescribeUnusableError and VideoDescribeUnusableError
      // are the exception: kie listened to the clip, reported what it cost in
      // the same response, and only then said the clip was no good. Recording
      // null there would throw away a figure we were handed. (A video that
      // failed the size guard above is a plain error, not either class — it
      // never reached kie, so null is the honest answer there too.)
      costUsd:
        err instanceof AudioDescribeUnusableError ||
        err instanceof VideoDescribeUnusableError ||
        err instanceof KieImageDescribeError
          ? err.costUsd
          : null,
      error: err instanceof Error ? err.message : "redescribe failed",
    });
    return {
      error:
        err instanceof Error
          ? err.message
          : "Could not describe that reference again. Try once more.",
    };
  }
}

/**
 * "@lena_ref" in, the saved description out. A template literal, not a model.
 *
 * This is the whole reference mechanism. The operator writes `@lena_ref` the
 * way JavaScript writes `${lena_ref}`, and this substitutes the text the
 * element already carries — no Claude call, no rewrite, nothing to fail at
 * render time. The one AI step happens ONCE, when the element is saved and
 * its picture is described; every prompt after that is string replacement.
 *
 * WHY NOT A MODEL. There was a Refine button that sent the WHOLE prompt to
 * Sonnet and asked for a rewritten copy — a far larger and less predictable
 * act than pasting in a paragraph: it cost more, it could quietly reword the
 * operator's own scene direction, and its output had to fit under a token
 * ceiling the prompt itself could exceed. It did, on the first real prompt,
 * coming back "max_tokens" with nothing parsed. It has since been deleted.
 * Substitution has no such failure mode: the output is exactly the input
 * with some spans swapped.
 *
 * A tag with no element, or an element with no description, is LEFT AS
 * WRITTEN. The worker's bindUITags strips the surviving '@' before submitting
 * (worker/internal/loop/dispatch.go), so an unresolved tag degrades to a bare
 * word rather than a token the video model would try to read as a name.
 *
 * IMAGE TAGS ONLY, inline-substituted at every occurrence, as above — an
 * `@image1`-shaped positional tag is how attachSceneReferences later links
 * `reference_image_urls` to the prompt, and that ordinal is computed there,
 * after this function returns. AUDIO TAGS route through declareAudioTags
 * (lib/element-tags.ts) instead: a voice name gets pasted in once, in a
 * declaration line, and every mention in the prose becomes the bare name.
 * See that function's comment for the real render (2026-08-30) that forced
 * the split — a voice tag used four times pasted the same ~200-character
 * description four times, growing a 2310-character prompt to 5463.
 * `assets.kind` is what tells the two apart, read off the ASSET the same
 * way image-generator.ts's resolvePromptReferences reads it, and NOT off
 * the element's `category` — that field is operator-editable text, and an
 * mp3 mislabelled "character" is still an mp3.
 */
async function resolveElementTags(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  prompt: string,
): Promise<string> {
  // Cheap exit for the common case: most prompts name no element at all.
  if (!prompt.includes("@")) return prompt;

  const { data, error } = await admin
    .from("elements")
    .select("name, description, ai_description, asset_id")
    .eq("user_id", userId)
    .is("deleted_at", null);
  // A failed lookup must not block a render. The prompt still says what the
  // operator wrote, and an unsubstituted tag is a worse clip, not a lost one.
  if (error || !data) return prompt;

  const assetIds = data.map((e) => e.asset_id).filter((id): id is string => Boolean(id));
  const { data: assets } =
    assetIds.length > 0
      ? await admin.from("assets").select("id, kind").in("id", assetIds)
      : { data: [] as { id: string; kind: string }[] };
  const kindById = new Map((assets ?? []).map((a) => [a.id, a.kind]));

  const imageByName = new Map<string, string>();
  const audioByName = new Map<string, { name: string; description: string }>();
  for (const element of data) {
    const text = descriptionFor(element);
    if (!text) continue;
    const isAudio = element.asset_id ? kindById.get(element.asset_id) === "audio" : false;
    if (isAudio) {
      audioByName.set(element.name.toLowerCase(), { name: element.name, description: text });
    } else {
      // NOT the same "audio, else image" shape attachSceneReferences and
      // firstTaggedImageElementId had to be corrected out of — here it is
      // deliberate, not a leftover denylist. A tagged video belongs in this
      // bucket alongside a tagged picture: its description goes INLINE where
      // the picture's would, rather than being declared once up front the
      // way a voice's is, because it describes what is on screen and not who
      // is speaking.
      //
      // The reason written here originally was "its bytes never reach kie
      // either way", which was true under 0093 and false from 0094, when
      // scene_references.kind was widened and reference_video_urls started
      // carrying the file. The BRANCH survives that correction unchanged —
      // where the prose sits was never what the bytes did — but the
      // justification had to, because a comment that argues from a fact
      // that has stopped being true is how the next reader talks themselves
      // into moving the line.
      imageByName.set(element.name.toLowerCase(), text);
    }
  }

  const withImages = imageByName.size > 0 ? substituteElementTags(prompt, imageByName) : prompt;
  return audioByName.size > 0 ? declareAudioTags(withImages, audioByName) : withImages;
}

/**
 * The tags in this prompt that name no saved reference at all.
 *
 * NOT the same question as "which tags failed to substitute". A tag can
 * resolve to a real element that simply has no description yet: nothing is
 * pasted into the prompt, but the element IS attached as a reference and the
 * render carries it. That is a thinner clip, not a wrong one, and warning
 * about it would train an operator to ignore this notice.
 *
 * What this catches is the tag with nothing behind it — most often a rename.
 * updateElement follows a rename through every SAVED scene prompt, but a
 * draft sitting unsaved in another tab keeps the old text and its element
 * list is stale, so the browser still paints "@new" as a resolved tag while
 * the database no longer has one. The server is the only party that can see
 * the disagreement.
 *
 * What it costs when nobody says anything: the worker's bindUITags strips the
 * '@' from an unbound tag, so "@new" arrives as the ordinary word "new". The
 * render succeeds, bills in full, and is simply missing the face or the voice
 * that was asked for — with nothing anywhere reporting a problem.
 */
async function unknownElementTags(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  prompt: string,
): Promise<string[]> {
  const tags = tagsInOrder(prompt);
  if (tags.length === 0) return [];

  const { data, error } = await admin
    .from("elements")
    .select("name")
    .eq("user_id", userId)
    .is("deleted_at", null);
  // A failed lookup must not invent a warning. Saying "@jen does not exist"
  // because the elements table could not be read would be worse than saying
  // nothing: it names a specific, checkable, false thing.
  if (error || !data) return [];

  const known = new Set(data.map((e) => e.name.toLowerCase()));
  return tags.filter((tag) => !known.has(tag));
}

/**
 * Tags in this prompt that resolve to a real, saved element but are NOT
 * named in the operator's References box — the enforcement half of the box
 * ugc-column.tsx renders above the prompt.
 *
 * ONLY MEANINGFUL WHEN THE COLUMN SENT A BOX. generateClip and regenerateClip
 * call this only behind the `referencesBox` marker (see each function's own
 * comment) — a caller that never rendered a box (retryClip used to be one;
 * see regenerateClip's own doc comment for why it is gone) submits no
 * `referenceTag` fields at all, and running this check against an empty box
 * would refuse every tagged prompt that caller has ever sent.
 *
 * A TAG WITH NO ELEMENT BEHIND IT IS NOT REPORTED HERE. That is
 * unknownElementTags' job, above, and its own comment explains why an
 * unresolved tag has always been a notice, never a refusal, and stays one:
 * the render is a worse clip, not a lost one. This function only ever
 * returns names of elements that DO exist and were simply left out of the
 * box — the one case the box's whole promise ("what you see here is what
 * this clip can use") would otherwise be silently untrue for.
 *
 * Returns the elements' OWN stored names (not the lowercased tag text) so
 * the refusal message reads with the same casing the operator saved.
 */
async function elementTagsOutsideBox(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  prompt: string,
  boxTags: readonly string[],
): Promise<string[]> {
  const tags = tagsInOrder(prompt);
  if (tags.length === 0) return [];

  const { data, error } = await admin
    .from("elements")
    .select("name")
    .eq("user_id", userId)
    .is("deleted_at", null);
  // Same "a failed lookup must not invent a refusal" reasoning as
  // unknownElementTags above — a read that could not run is not evidence the
  // box is wrong, and refusing the render over it would be the read failure
  // masquerading as an operator mistake.
  if (error || !data) return [];

  const byLower = new Map(data.map((e) => [e.name.toLowerCase(), e.name]));
  const boxSet = new Set(boxTags.map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const tag of tags) {
    const realName = byLower.get(tag);
    if (realName !== undefined && !boxSet.has(tag)) out.push(realName);
  }
  return out;
}

/**
 * The refusal message for a Kling submission whose prompt still carries an
 * @tag, or null when it has none.
 *
 * KLING TAKES ONLY A START/END FRAME PAIR. It has no References box and
 * never resolves a tag into a description the way resolveElementTags does
 * for every other model (generateClip's own "KLING NEVER SUBSTITUTES"
 * comment) — 42d29e3 (worker) made bindUITags strip the bare '@' rather than
 * treat it as a role reference, so an '@tag' left in a Kling prompt reaches
 * the model as a plain word the operator never typed ("@greta_ref" becomes
 * "greta_ref"). That used to be only a notice. It stopped being one when a
 * tag naming a video element also broke Kling's own PRICING outright: Kling
 * has no video-input rate, so taggedVideoInputDurationsS priced the clip at
 * +Infinity and the render was refused downstream as "cannot be priced" —
 * a confusing failure for a cause the operator could not see from that
 * message.
 *
 * NAMES THE TAGS, first three plus a count, in the same wording
 * ugc-column.tsx's own red line uses — a hand-posted form or a stale client
 * hits this same sentence, not a different one.
 */
function klingTagRefusal(prompt: string): string | null {
  const tags = tagsInOrder(prompt);
  if (tags.length === 0) return null;
  const named = tags
    .slice(0, 3)
    .map((t) => `@${t}`)
    .join(", ");
  const more = tags.length > 3 ? ` +${tags.length - 3} more` : "";
  return `Kling can't use @tags — remove ${named}${more} to generate.`;
}

/**
 * The first @tag in a prompt that names a saved PICTURE, or null.
 *
 * WHY THIS EXISTS. generateClip needs a conditioning frame and used to
 * demand it be attached or picked, even when the prompt already named one:
 * an operator pasting a finished prompt whose every tag resolved was told
 * "attach an image or pick a saved reference", with the picture sitting in
 * the library the tag had just matched. The way through was to upload a
 * dummy — which is not a workaround but a worse render, because the
 * conditioning frame is the one picture the model actually looks at.
 *
 * THE ASSET DECIDES, not the category: a voice tag names a real element and
 * an MP3 cannot be a conditioning frame, and neither can an @tagged video's
 * MP4 (0093_video_reference_elements.sql) — only a genuine picture can stand
 * in.
 *
 * The FIRST one, to match what the picker already promises about a batch —
 * the first is used for this clip and the rest are saved for later — and
 * because the tag loop in attachSceneReferences gives ordinal 1 to the
 * primary anyway, so the frame and reference_image_urls[0] agree.
 */
async function firstTaggedImageElementId(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  prompt: string,
): Promise<string | null> {
  const tags = tagsInOrder(prompt);
  if (tags.length === 0) return null;

  const { data: elements } = await admin
    .from("elements")
    .select("id, name, asset_id")
    .eq("user_id", userId)
    .is("deleted_at", null);
  if (!elements) return null;

  const byName = new Map(elements.map((e) => [e.name.toLowerCase(), e]));
  const tagged = tags.map((t) => byName.get(t)).filter((e) => e !== undefined);
  if (tagged.length === 0) return null;

  const { data: assets } = await admin
    .from("assets")
    .select("id, kind")
    .in(
      "id",
      tagged.map((e) => e.asset_id),
    );
  const kindById = new Map((assets ?? []).map((a) => [a.id, a.kind]));

  for (const element of tagged) {
    const kind = kindById.get(element.asset_id);
    // A KNOWN PICTURE kind — an ALLOWLIST (IMAGE_ASSET_KINDS), not "known and
    // not audio". The denylist shape read as an allowlist for exactly as
    // long as audio was the only other kind that existed: an unreadable
    // assets row failed it the same way an MP3 did, for the same reason, by
    // accident. 0093_video_reference_elements.sql broke that accident — an
    // @tagged .mp4 also merely fails "!== audio", and adopting it here would
    // hand Seedance a video where it demands a still first frame. The one
    // thing that must never become a conditioning frame is a file nobody
    // confirmed was a picture — a silent wrong render, where refusing is a
    // visible one — so this is checked against the same picture-kind set
    // attachSceneReferences below allows into scene_references, not
    // re-derived here a second way.
    if (kind !== undefined && IMAGE_ASSET_KINDS.has(kind)) return element.id;
  }
  return null;
}

/**
 * Every @tagged video reference's own duration, in seconds, in tag order.
 *
 * THE NUMBER THE CAP CHECK WAS MISSING. A video-conditioned render is billed
 * for the video's seconds on top of the clip's (lib/kie/rates.ts's
 * VIDEO_INPUT_PRICING, measured 2026-09-10), and estimateCost has taken a
 * `videoReferenceDurationsS` since the day video shipped — with no caller
 * anywhere in the product passing it. The parameter existed, the tests
 * exercised it, and every real quote went out without it. This is the
 * caller.
 *
 * A NULL ENTRY IS NOT A ZERO. assets.duration_s is null when the browser
 * could not measure the file at upload time, and estimateCost turns a null
 * into +Infinity on purpose: a spend cap must refuse what it cannot price
 * rather than wave through a guess. Dropping the nulls here to keep the
 * quote finite would defeat that from the outside, so they are passed
 * through exactly as stored.
 *
 * Reads elements and assets the same way firstTaggedImageElementId does,
 * rather than sharing a resolver with it: that one wants the FIRST picture
 * and stops, this one wants EVERY video and cannot.
 */
async function taggedVideoInputDurationsS(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  prompt: string,
): Promise<(number | null)[]> {
  const tags = tagsInOrder(prompt);
  if (tags.length === 0) return [];

  const { data: elements } = await admin
    .from("elements")
    .select("id, name, asset_id")
    .eq("user_id", userId)
    .is("deleted_at", null);
  if (!elements) return [];

  const byName = new Map(elements.map((e) => [e.name.toLowerCase(), e]));
  const tagged = tags.map((t) => byName.get(t)).filter((e) => e !== undefined);
  if (tagged.length === 0) return [];

  const { data: assets } = await admin
    .from("assets")
    .select("id, kind, duration_s")
    .in(
      "id",
      tagged.map((e) => e.asset_id),
    );
  const byId = new Map((assets ?? []).map((a) => [a.id, a]));

  const durations: (number | null)[] = [];
  for (const element of tagged) {
    const asset = byId.get(element.asset_id);
    if (asset?.kind !== "video_ref") continue;
    durations.push(asset.duration_s);
  }
  return durations;
}

type GeminiReferenceInput = {
  kind: AssetKind;
  durationS: number | null | undefined;
};

/** Shared Gemini reference contract used by Generate and Regenerate. */
function geminiReferenceContractRefusal(
  references: readonly GeminiReferenceInput[],
  resolution: string,
): string | null {
  let images = 0;
  let videos = 0;
  let audios = 0;
  for (const reference of references) {
    if (reference.kind === "audio") {
      audios++;
    } else if (reference.kind === "video_ref") {
      videos++;
      if (
        typeof reference.durationS !== "number" ||
        !Number.isFinite(reference.durationS) ||
        reference.durationS <= 0
      ) {
        return "Gemini Omni Video needs a measured source-video duration.";
      }
    } else if (IMAGE_ASSET_KINDS.has(reference.kind)) {
      images++;
    }
  }
  if (audios > 0)
    return "Gemini Omni Video cannot use audio URL references yet; it requires Kie audio IDs.";
  if (images === 0) return "Gemini Omni Video still needs at least one image reference.";
  if (videos > 1) return "Gemini Omni Video accepts only one source video.";
  if (videos > 0 && !geminiOmniVideoInputPaid(resolution)) {
    return "Gemini source-video input is unavailable until a paid video-input receipt exists.";
  }
  if (images + videos * 2 > 7) {
    return "Gemini Omni Video supports at most 7 reference units (each image is 1; a video is 2).";
  }
  return null;
}

/** Gemini Omni Video's documented reference contract, enforced before caps/writes. */
async function geminiReferenceRefusal(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  prompt: string,
  primaryKind: "image" | "audio" | "video",
  primaryElementId: string,
  resolution: string,
  primaryDurationS?: number | null,
): Promise<string | null> {
  const tags = [...new Set(tagsInOrder(prompt))];
  const { data: elements } = await admin
    .from("elements")
    .select("id, name, asset_id")
    .eq("user_id", userId)
    .is("deleted_at", null);
  const byName = new Map((elements ?? []).map((element) => [element.name.toLowerCase(), element]));
  const tagged = tags.flatMap((tag) => {
    const element = byName.get(tag);
    return element && element.id !== primaryElementId ? [element] : [];
  });
  const primary = primaryElementId
    ? (elements ?? []).find((element) => element.id === primaryElementId)
    : undefined;
  const assetIds = [
    ...new Set([
      ...tagged.map((element) => element.asset_id),
      ...(primary ? [primary.asset_id] : []),
    ]),
  ];
  const { data: assets } = assetIds.length
    ? await admin.from("assets").select("id, kind, duration_s").in("id", assetIds)
    : { data: [] as { id: string; kind: AssetKind; duration_s: number | null }[] };
  const assetById = new Map((assets ?? []).map((asset) => [asset.id, asset]));

  const primaryAsset = primary ? assetById.get(primary.asset_id) : undefined;
  const references: GeminiReferenceInput[] = [
    {
      kind: primaryAsset?.kind ?? primaryAssetKind(primaryKind),
      durationS:
        primaryAsset?.duration_s ?? (primaryKind === "video" ? primaryDurationS : undefined),
    },
    ...tagged.flatMap((element) => {
      const asset = assetById.get(element.asset_id);
      return asset ? [{ kind: asset.kind, durationS: asset.duration_s }] : [];
    }),
  ];
  return geminiReferenceContractRefusal(references, resolution);
}

/** Validate the references already retained by a scene before Regenerate. */
async function geminiSceneReferenceRefusal(
  admin: ReturnType<typeof createAdminClient>,
  sceneId: string,
  legacyRefFrameAssetId: string | null,
  resolution: string,
): Promise<string | null> {
  const { data: references, error: referencesError } = await admin
    .from("scene_references")
    .select("asset_id, kind")
    .eq("scene_id", sceneId);
  if (referencesError) {
    return `Could not verify Gemini references: ${referencesError.message}`;
  }

  let rows = references ?? [];
  if (rows.length === 0 && legacyRefFrameAssetId) {
    rows = [{ asset_id: legacyRefFrameAssetId, kind: "image" }];
  }
  if (rows.length === 0) return "Gemini Omni Video still needs at least one image reference.";
  const assetIds = [...new Set(rows.map((reference) => reference.asset_id))];
  const { data: assets, error: assetsError } = await admin
    .from("assets")
    .select("id, kind, duration_s")
    .in("id", assetIds);
  if (assetsError) {
    return `Could not verify Gemini references: ${assetsError.message}`;
  }
  const assetById = new Map((assets ?? []).map((asset) => [asset.id, asset]));
  const inputs: GeminiReferenceInput[] = rows.flatMap(({ asset_id: assetId }) => {
    const asset = assetById.get(assetId);
    // The worker's JOIN omits a reference whose asset disappeared. Validate
    // the same effective set rather than inventing a video with no duration
    // (or an image) for a row the worker cannot submit.
    if (!asset) return [];
    return [
      {
        kind: asset.kind,
        durationS: asset.duration_s,
      },
    ];
  });
  return geminiReferenceContractRefusal(inputs, resolution);
}

/**
 * Writes one scene_references row per picture this clip should carry.
 *
 * WHY THIS EXISTS AT ALL. 0071 created scene_references, the worker reads it
 * in ordinal order, and seedanceInput puts the result in reference_image_urls
 * — an array kie documents as taking up to ten. Nothing ever wrote a row, so
 * the table sat empty and the worker fell back to the single
 * ref_frame_asset_id. A character and the product she is holding could be
 * tagged in one prompt and only one of them was ever sent.
 *
 * ORDER IS THE CONTRACT. reference_image_urls is positional, so ordinal 1 is
 * what a prompt would call "@image1". The picked or uploaded image is always
 * ordinal 1 — it is the one the operator chose deliberately, in the picker —
 * and the remaining tags follow in the order they were written.
 *
 * COPIED, NOT REFERENCED, for the same reason the primary image is: a scene
 * pointing at another project's asset row makes this clip depend on that
 * project continuing to exist.
 *
 * NOT FATAL. A clip renders from its primary image and its prose whatever
 * happens here; a missing second reference is a worse clip, not a lost one,
 * and refusing a render the operator has already been charged the cap for
 * would be the worse trade. Failures are logged and skipped.
 */
/**
 * Refuses a prompt longer than the chosen model will accept, or null.
 *
 * THE VENDOR IS NOT THE RIGHT PLACE TO LEARN THIS. kie answered a real /ugc
 * render with code=422 "The length of 'prompt' must not exceed 2500
 * characters" on 2026-09-11, after the operator had approved the spend: the
 * scene was written, queued, claimed and only then refused, leaving a row
 * marked failed and a vendor string nobody could act on.
 *
 * MEASURES THE SUBSTITUTED TEXT, which is the only length that matters and
 * not the one anybody can see. That render's box held 2,310 characters and
 * the tags expanded it to 4,740.
 *
 * Undefined maxPromptChars means no vendor limit is known (every Seedance
 * model), so only our own MAX_PROMPT_CHARS applies. The lower of the two wins.
 */
function promptTooLongForModel(modelId: string, submittedPrompt: string): { error: string } | null {
  const model = getModel(modelId);
  const max = Math.min(model.maxPromptChars ?? Infinity, MAX_PROMPT_CHARS);
  if (submittedPrompt.length <= max) return null;
  const over = submittedPrompt.length - max;
  // KLING NEVER SUBSTITUTES (see generateClip's own submittedPrompt), so
  // "every @tag is replaced by its full description" is false for it — the
  // number this function was just handed IS the typed prompt, and the only
  // fix is to shorten what was actually written.
  const tail = model.nativeAudio
    ? "Shorten it to generate."
    : "Every @tag is replaced by its full description before it is sent, so shortening the " +
      "prompt or removing a tag both help.";
  return {
    error:
      `This prompt reaches ${model.label} ${over.toLocaleString()} characters over its ` +
      `${max.toLocaleString()} limit. ${tail}`,
  };
}

/**
 * The assets.kind a primary reference is stored under.
 *
 * ONE MAPPING, THREE CALL SITES. The copy branch, the fresh-upload branch and
 * the assets insert each spelled this ternary out for themselves, which is how
 * the insert came to disagree with the key it was describing: the first two
 * were taught about video_ref and the third was not. A function cannot drift
 * from itself.
 */
function primaryAssetKind(kind: "image" | "audio" | "video"): "audio" | "video_ref" | "ref_frame" {
  return kind === "audio" ? "audio" : kind === "video" ? "video_ref" : "ref_frame";
}

/**
 * Refuses an elementId that isn't the caller's own, or isn't a picture — the
 * check Kling's Start/End frames both need BEFORE any write or spend (spec:
 * "either element is not an image" is refused up front, not discovered mid-
 * write). Returns the error string to hand back verbatim, or null when the
 * element is fine to use.
 *
 * A SECOND READ, not a reuse of the one the elementId branch below already
 * does for every other model's picked reference: that branch runs AFTER the
 * cap check, in the write phase, and Kling's own validation has to run
 * before it — see generateClip's own ordering comment. Two round trips
 * rather than threading the result through is the cost of that ordering;
 * `elementId`/`assets` are cheap, indexed reads and this runs at most twice
 * per submission (start, and optionally end).
 */
async function refuseIfNotOwnedImageElement(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  elementId: string,
  slotLabel: "start" | "end",
): Promise<string | null> {
  const { data: element, error } = await admin
    .from("elements")
    .select("asset_id, user_id, name")
    .eq("id", elementId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read the ${slotLabel} frame's reference: ${error.message}`);
  }
  if (!element || element.user_id !== userId) {
    return `That ${slotLabel} frame is no longer available.`;
  }
  const { data: asset, error: assetError } = await admin
    .from("assets")
    .select("kind, storage_key")
    .eq("id", element.asset_id)
    .maybeSingle();
  if (assetError) {
    throw new Error(`Failed to read the ${slotLabel} frame's image: ${assetError.message}`);
  }
  if (!asset || !IMAGE_ASSET_KINDS.has(asset.kind)) {
    return `The ${slotLabel} frame has to be a picture — Kling's Start and End frames can't be a voice or a video.`;
  }
  // KIE'S OWN 422, CAUGHT BEFORE SUBMIT: Kling 3.0 refuses anything but
  // jpeg/jpg/png at the vendor itself ("Only jpeg/jpg/png image formats are
  // supported" — prod scene d532c7a0, a .webp end frame). Seedance takes
  // webp fine, so this check lives only on THIS Kling-only path — see
  // KLING_FRAME_EXTS' own comment (lib/elements.ts) for the rest of the
  // reasoning, and ugc-column.tsx's isBadKlingFrameExt for the client-side
  // courtesy this backs up.
  const ext = extFromFilename(asset.storage_key, "").toLowerCase();
  if (ext && !KLING_FRAME_EXTS.has(ext)) {
    return `@${element.name} is a ${ext.toUpperCase()} — Kling only takes PNG or JPG frames. Pick another image.`;
  }
  return null;
}

async function attachSceneReferences(args: {
  admin: ReturnType<typeof createAdminClient>;
  projectId: string;
  userId: string;
  sceneId: string;
  prompt: string;
  primaryAssetId: string | null;
  /**
   * What the PRIMARY reference actually is.
   *
   * Passed in rather than re-read, because generateClip has just written the
   * asset and already knows. This existed as a hardcoded "image" until
   * 2026-09-04, in the same function whose tag loop carries a comment
   * explaining why the asset kind and not the category is what decides —
   * the loop learned the lesson and the row above it did not.
   */
  primaryKind: "image" | "audio" | "video";
  primaryElementId: string | null;
  /**
   * KLING'S OWN SHAPE, not the box's. undefined (every non-Kling caller)
   * runs the tag loop below exactly as it always has. Present — even as
   * null, when the operator picked no end frame — means "this is a Kling
   * scene": skip the tag loop entirely (Kling's prompt is never resolved
   * into references — see generateClip's own comment on why) and, when
   * this holds an id, attach exactly that one element at ordinal 2 and
   * nothing else. A Kling scene therefore ends this function with at most
   * two rows, both kind='image', regardless of what its prompt names.
   */
  klingEndElementId?: string | null;
  /**
   * Optional explicit reference tag ordering (used by `/api/v1/generate` when
   * `image_refs`/`video_refs`/`audio_refs` arrays are provided). When supplied,
   * ordinals are assigned in this exact array order rather than scanning
   * `tagsInOrder(prompt)`, so `@Image 2` mentioned before `@Image 1` or an
   * unmentioned array entry still binds to its array ordinal.
   */
  explicitOrderedTags?: readonly string[];
}): Promise<void> {
  const {
    admin,
    projectId,
    userId,
    sceneId,
    prompt,
    primaryAssetId,
    primaryKind,
    primaryElementId,
    klingEndElementId,
    explicitOrderedTags,
  } = args;

  const rows: Array<{
    scene_id: string;
    asset_id: string;
    kind: string;
    ordinal: number;
    category: string | null;
    description: string | null;
    tag: string | null;
  }> = [];

  // DELETE and SELECT run together — different tables, and neither reads
  // the other's result, so there is no reason the elements lookup should
  // wait for the old rows to finish clearing first.
  //
  // REPLACE, NOT APPEND. regenerateClip reuses this function to change a
  // Kling scene's frames in place, and the scene already has whatever
  // references its LAST render wrote — a fresh insert on top of those would
  // leave stale rows the worker still reads in ordinal order. Harmless
  // no-op for a brand-new scene (generateClip's own call), which has no
  // existing rows to delete.
  //
  // Everything the operator owns, read once. The tag list is short and this
  // avoids a query per tag.
  const [{ error: clearError }, { data: elements }] = await Promise.all([
    admin.from("scene_references").delete().eq("scene_id", sceneId),
    admin
      .from("elements")
      .select("id, name, category, description, ai_description, asset_id")
      .eq("user_id", userId)
      .is("deleted_at", null),
  ]);
  if (clearError) {
    console.warn(`generateClip: could not clear old scene_references for ${sceneId}`, clearError);
  }
  type ElementRow = NonNullable<typeof elements>[number];
  const byName = new Map((elements ?? []).map((e) => [e.name.toLowerCase(), e]));
  const byId = new Map((elements ?? []).map((e) => [e.id, e]));

  const primary = primaryElementId
    ? (elements ?? []).find((e) => e.id === primaryElementId)
    : undefined;

  if (primaryAssetId) {
    rows.push({
      scene_id: sceneId,
      asset_id: primaryAssetId,
      kind: primaryKind,
      ordinal: 1,
      category: primary?.category ?? null,
      description: primary ? descriptionFor(primary) || null : null,
      // The tag the worker's bindUITags would match, when the primary came
      // from a saved element. A fresh upload has no name and carries null.
      tag: primary?.name ?? null,
    });
  }

  // MAX_REFERENCES (lib/ugc-references.ts) — kie documents
  // reference_image_urls as taking at most ten, and ordinal 1 is already
  // spent on the primary.

  /**
   * ORDINAL IS PER KIND, not per row — `1-based position within its kind`
   * (0071's own column comment), backed by `unique (scene_id, kind, ordinal)`.
   *
   * A single shared counter would be correct for exactly as long as every
   * row was an image. The first voice reference would have been written as
   * ordinal 3 or 5, so `@voice1` in a prompt would name an ordinal that does
   * not exist while the audio itself sat under a number nothing refers to —
   * and a second voice on the same scene could collide with an image's
   * ordinal outright.
   *
   * SEEDED FROM `rows`, not recomputed from it on every call — `rows` holds
   * only the primary at this point, so this starts exactly where the old
   * `rows.filter((r) => r.kind === kind).length + 1` did, but as a running
   * count `takeOrdinal` can advance synchronously, in prompt order, BEFORE
   * any of the concurrent copies below have even started. That is the whole
   * reason this moved off `rows.length`: once the copies run concurrently,
   * which one finishes first says nothing about which tag came first in the
   * prompt, and an ordinal that depended on completion order would hand out
   * "@image2" to whichever request happened to win a race.
   */
  const kindCounts = new Map<string, number>();
  for (const row of rows) kindCounts.set(row.kind, (kindCounts.get(row.kind) ?? 0) + 1);
  function takeOrdinal(kind: "image" | "audio" | "video"): number {
    const ordinal = (kindCounts.get(kind) ?? 0) + 1;
    kindCounts.set(kind, ordinal);
    return ordinal;
  }

  // KLING NEVER REACHES ANY OF THIS. klingEndElementId is undefined for
  // every non-Kling caller (this runs exactly as it always has), and present
  // — even null — for a Kling one, which resolves NOTHING off the prompt:
  // see this argument's own doc comment on the args type above for why.
  if (klingEndElementId === undefined) {
    // PHASE 0 — PURE, no I/O. Walk the tags in the order they were written
    // and drop the ones no read could ever save: an unknown name, one with
    // no asset at all, or a duplicate of the primary. Capped at
    // MAX_REFERENCES - 1 (ordinal 1 is already the primary's) so phase 1
    // below never reads more `assets` rows than a full box could ever use.
    //
    // ONE DELIBERATE DIFFERENCE FROM BEFORE: the old loop's cap was against
    // rows.length, which only grew on an ACTUAL success — so a copy that
    // failed left the cap one slot looser and let a later tag through that
    // would otherwise have been cut off. This cap is against ELIGIBLE
    // CANDIDATES instead, decided up front, because the whole point of
    // running the copies concurrently is not knowing which ones will
    // succeed until they all do. The two agree in the common case (nothing
    // fails); they can differ only when a copy actually throws AND the
    // prompt tags more than MAX_REFERENCES worth of references, in which
    // case this version does not backfill the freed slot from later in the
    // prompt. Backfilling would mean re-introducing the sequential retry
    // that concurrency was the point of removing.
    const orderedTagNames =
      explicitOrderedTags !== undefined
        ? explicitOrderedTags.map((t) => t.toLowerCase())
        : tagsInOrder(prompt);
    const seenEligible = new Set<string>();
    const pureEligible: { name: string; element: ElementRow }[] = [];
    for (const name of orderedTagNames) {
      if (!name || seenEligible.has(name)) continue;
      seenEligible.add(name);
      if (pureEligible.length >= MAX_REFERENCES - 1) break;
      const element = byName.get(name);
      if (!element || !element.asset_id) continue;
      // Already ordinal 1. A prompt that tags the picked element by name is
      // the normal case, not a mistake, and it must not send the same
      // picture twice.
      if (primary && element.id === primary.id) continue;
      pureEligible.push({ name, element });
    }

    // PHASE 1 — CONCURRENT I/O, but the RESULT ARRAY keeps prompt order
    // regardless of which request actually answers first: Promise.all
    // resolves to an array indexed like its input, not like completion
    // order. This is what lets phase 2 assign ordinals correctly without
    // waiting for anything.
    const resolved = await Promise.all(
      pureEligible.map(async ({ name, element }) => {
        const { data: sourceAsset } = await admin
          .from("assets")
          // duration_s rides along because the copy below carries it; a
          // video's own seconds are billed, and this read is the only place
          // they exist.
          .select("storage_key, kind, duration_s")
          .eq("id", element.asset_id)
          .maybeSingle();
        if (!sourceAsset) return null;

        // WHICH OF KIE'S TWO ARRAYS THIS TAG FEEDS. Read from the ASSET, not
        // from the element's category: the category is an operator-editable
        // label on a card, and 0079 made the asset kind the thing that says
        // what the file actually is. A voice element mislabelled "character"
        // still holds an MP3, and an MP3 in reference_image_urls is a
        // refusal from the vendor at best.
        //
        // AN ALLOWLIST (IMAGE_ASSET_KINDS ∪ "audio" ∪ "video_ref"), not
        // "audio, else image". That denylist shape was correct for exactly
        // as long as those were the only two kinds in existence, and
        // 0093_video_reference_elements.sql ended that: a tagged .mp4 merely
        // failed "=== audio" too, so a denylist would have written it into
        // scene_references as kind='image'. The worker signs THAT row's
        // storage_key and posts the result in reference_image_urls — and
        // worker/internal/kie/client.go's own comment is that kie accepts a
        // wrong key, answers 200, and BILLS THE RENDER, so this would fail
        // silently and cost money, not loudly and cost nothing. video_ref is
        // now a member of the allowlist rather than the reason a third
        // branch had to be skipped: 0094_video_scene_reference.sql widened
        // scene_references.kind to admit 'video', kie's Seedance 2.5 docs
        // confirm reference_video_urls as the array it lands in, and the
        // worker is wired to send it — so a video tag writes its own row
        // here instead of being turned away at the database.
        //
        // THE PRICE THIS BUYS, and it is real: kie charges a
        // video-conditioned render as Price x (input + output), not Price x
        // output, so a scene carrying a 'video' row here costs more than an
        // otherwise-identical scene without one. That arithmetic lives in
        // web/lib/kie/rates.ts and worker/internal/kie/models.go, not in
        // this function — see 0094_video_scene_reference.sql's header for
        // the full warning.
        const refKind: "image" | "audio" | "video" | null =
          sourceAsset.kind === "audio"
            ? "audio"
            : sourceAsset.kind === "video_ref"
              ? "video"
              : IMAGE_ASSET_KINDS.has(sourceAsset.kind)
                ? "image"
                : null;
        if (refKind === null) return null;

        return { name, element, sourceAsset, refKind };
      }),
    );

    // PHASE 2 — PURE again. `resolved` is already in prompt order (see
    // phase 1's own comment), so ordinals are assigned deterministically
    // here, synchronously, before phase 3 ever starts a single copy —
    // completion order in phase 3 can no longer affect which tag gets
    // which ordinal.
    const toAttach = resolved
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .map((entry) => ({ ...entry, ordinal: takeOrdinal(entry.refKind) }));

    // PHASE 3 — CONCURRENT I/O. Each reference's copy-and-insert is
    // independent of every other's, so they run together instead of one at
    // a time; on prod a 4-reference scene measured 2.5s end to end this way,
    // one after another. A per-reference failure is still isolated exactly
    // as before — one bad copy does not lose the others, it only logs and
    // contributes no row.
    const attached = await Promise.all(
      toAttach.map(async ({ name, element, sourceAsset, refKind, ordinal }) => {
        const assetKind =
          refKind === "audio" ? "audio" : refKind === "video" ? "video_ref" : "ref_frame";
        const defaultExt = refKind === "audio" ? "mp3" : refKind === "video" ? "mp4" : "jpg";
        try {
          const toKey = buildStorageKey({
            projectId,
            kind: assetKind,
            ext: extFromFilename(sourceAsset.storage_key, defaultExt),
          });
          await copyStorageObject(sourceAsset.storage_key, toKey);

          const { data: copied, error: copiedError } = await admin
            .from("assets")
            .insert({
              project_id: projectId,
              scene_id: sceneId,
              kind: assetKind,
              storage_key: toKey,
              // CARRIED, NOT RE-DERIVED — and it used to be dropped. The
              // source element's duration was measured in the browser at
              // upload and written by registerElement precisely because a
              // video's own seconds are billed (lib/kie/rates.ts's
              // VIDEO_INPUT_PRICING). This insert listed four columns and
              // the number was lost at the exact moment it became money:
              // the library row read 4.064 and the scene's copy of the
              // same bytes read null. Nothing has re-measured it since, and
              // nothing can — the file is in storage, not in front of a
              // browser.
              duration_s: sourceAsset.duration_s,
            })
            .select("id")
            .single();
          if (copiedError || !copied) throw new Error(copiedError?.message ?? "no asset row");

          return {
            scene_id: sceneId,
            asset_id: copied.id,
            kind: refKind,
            ordinal,
            category: element.category,
            // A VOICE CARRIES NO DESCRIPTION, and this is not an oversight.
            // An image tag substitutes its description into the prompt
            // because a picture cannot reach the model any other way; an
            // audio tag sends the FILE, so prose about it would be
            // decoration that can only be wrong. registerElement does not
            // generate one either.
            description: refKind === "audio" ? null : descriptionFor(element) || null,
            tag: element.name,
          };
        } catch (err) {
          console.warn(`generateClip: could not attach reference @${name}`, err);
          return null;
        }
      }),
    );

    for (const row of attached) if (row) rows.push(row);
  }

  // KLING'S END FRAME, ordinal 2, kind='image' — the ONLY other row a Kling
  // scene ever gets. No category label and no description-substitution
  // reasoning applies here the way it does to the tag loop above: Kling's
  // prompt is never resolved against this or any other element (see
  // generateClip's own comment), so this element contributes nothing but
  // its picture.
  if (klingEndElementId) {
    const endElement = byId.get(klingEndElementId);
    const sourceAssetId = endElement?.asset_id;
    if (endElement && sourceAssetId) {
      const { data: sourceAsset } = await admin
        .from("assets")
        .select("storage_key")
        .eq("id", sourceAssetId)
        .maybeSingle();
      if (sourceAsset) {
        try {
          const toKey = buildStorageKey({
            projectId,
            kind: "ref_frame",
            ext: extFromFilename(sourceAsset.storage_key, "jpg"),
          });
          await copyStorageObject(sourceAsset.storage_key, toKey);

          const { data: copied, error: copiedError } = await admin
            .from("assets")
            .insert({
              project_id: projectId,
              scene_id: sceneId,
              kind: "ref_frame",
              storage_key: toKey,
            })
            .select("id")
            .single();
          if (copiedError || !copied) throw new Error(copiedError?.message ?? "no asset row");

          rows.push({
            scene_id: sceneId,
            asset_id: copied.id,
            kind: "image",
            ordinal: takeOrdinal("image"),
            category: endElement.category,
            description: null,
            tag: endElement.name,
          });
        } catch (err) {
          console.warn(`generateClip: could not attach Kling end frame for ${sceneId}`, err);
        }
      }
    }
  }

  if (rows.length === 0) return;
  const { error } = await admin.from("scene_references").insert(rows);
  if (error) {
    console.warn(`generateClip: could not write scene_references for ${sceneId}`, error);
  }
}

/**
 * generateClip's own return shape — ActionResult/ActionNotice plus the new
 * scene's id on success, so the caller can select it without generateClip's
 * two shared types (read by ~40 other actions) having to grow a field that
 * means nothing to any of them.
 *
 * The extra `notice?`/`error?: undefined` mirror ActionResult/ActionNotice's
 * own optional-never trick (see lib/action-result.ts): they let a caller read
 * `.error` or `.notice` on this union without narrowing first, the same way
 * every other call site in this file already does.
 */
export type GenerateClipResult =
  ActionResult | { sceneId: string; notice?: string; error?: undefined };

export async function generateClip(formData: FormData): Promise<GenerateClipResult> {
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return { error: "No project." };

  // requireProject, not requireUser plus a lookup by title. An earlier draft
  // wrote every clip into one per-user project matched by the exact string
  // "UGC clips" — a weak key that also made the scene strip an operator's
  // entire history forever, and forced ownership to be re-derived by hand.
  // A project in the path is the shape the rest of this app already uses,
  // and it brings the strict owner-only guard with it: admins refused,
  // missing row and wrong owner both notFound().
  const { project, user, profile } = await requireProject(projectId);
  await resolveStagedUploads(formData, user.id);
  // HOISTED, not re-created at every call site below. createAdminClient()
  // memoizes its own client (lib/supabase/server.ts), so this changes
  // nothing about which client any read runs against — it only gives the
  // concurrent read batches further down one name to share instead of each
  // asking the factory again.
  const admin = createAdminClient();

  const prompt = String(formData.get("prompt") ?? "").trim();
  if (!prompt) {
    return { error: "Write a prompt first — it is the whole instruction the model gets." };
  }

  // THE MARKER, NOT JUST THE FIELDS. `referenceTag` (repeated) carries the
  // References box's contents, but its ABSENCE and its EMPTINESS mean
  // different things — an empty box is a real box with nothing in it, sent
  // by ugc-column.tsx every time, while no `referencesBox` field at all means
  // this submission never went through the box at all — a caller that skips
  // the column entirely sends neither field, and must not be judged against
  // an empty box, which would refuse every tagged submission that caller has
  // ever sent. See elementTagsOutsideBox's own comment for the rest of this
  // reasoning.
  //
  // LEFT SEQUENTIAL, DELIBERATELY. This is the earliest possible refusal a
  // Seedance submission can hit, and it has to keep winning over every
  // sync check that comes after it (file type/size, duration, offerable) —
  // moving it into a later concurrent batch would make whichever of those
  // sync checks runs first in the new order win instead, on a submission
  // that fails both. One cheap read, not worth that risk.
  const referencesBoxSubmitted = formData.get("referencesBox") === "1";
  const boxTags = formData.getAll("referenceTag").map((t) => String(t));
  if (referencesBoxSubmitted && boxTags.length > MAX_REFERENCES) {
    return { error: `A scene holds at most ${MAX_REFERENCES} references.` };
  }
  if (referencesBoxSubmitted) {
    const outsideBox = await elementTagsOutsideBox(admin, user.id, prompt, boxTags);
    if (outsideBox.length > 0) {
      return {
        error:
          `${outsideBox.map((t) => `@${t}`).join(", ")} ` +
          `${outsideBox.length === 1 ? "is" : "are"} tagged in the prompt but not in this scene's ` +
          `References box. Add ${outsideBox.length === 1 ? "it" : "them"} to the box, or remove ` +
          `the tag from the prompt.`,
      };
    }
  }

  // What the operator typed BEFORE Refine rewrote it, sent only when Refine
  // ran. Empty is the common case: most scenes are generated straight from
  // the box. See the scene insert below for how the pair is stored.
  const operatorPrompt = String(formData.get("operatorPrompt") ?? "").trim();

  // READ EARLY, not at its old spot further down (regenerateClip still
  // reads it where it always has) — everything below this line has to
  // branch on whether the chosen model is Kling BEFORE it decides how the
  // conditioning frame is supplied at all, so the question has to be
  // answerable first. getModel() falls back to Seedance for an id it does
  // not know, same as everywhere else in this file, so an invalid modelId
  // here simply takes the non-Kling branch and is refused properly below
  // once `chosen` is resolved against offerable().
  const modelId = String(formData.get("modelId") ?? "");
  const resolution = String(formData.get("resolution") ?? "");
  // nativeAudio, not a string compare — same model-table flag the column
  // itself asks (ugc-column.tsx's `isKling`).
  const isKlingSubmission = getModel(modelId).nativeAudio;

  // NO SPEND, NO CAP CHECK, NOT EVEN A FRAME LOOKUP until this clears — see
  // klingTagRefusal's own comment for why an '@tag' in a Kling prompt is a
  // refusal now, not the "sent as plain words" notice it used to be.
  if (isKlingSubmission) {
    const tagRefusal = klingTagRefusal(prompt);
    if (tagRefusal) return { error: tagRefusal };
  }

  // Kling accepts optional start/end frames; an end frame requires a start.
  // both saved Elements — never an upload, and never resolved from the
  // prompt's own tags the way firstTaggedImageElementId does for every
  // other model. Refused BEFORE any write or spend, per the three cases
  // below.
  const startElementId = String(formData.get("startElementId") ?? "").trim();
  const endElementIdRaw = String(formData.get("endElementId") ?? "").trim();
  const endElementId = endElementIdRaw || null;

  if (isKlingSubmission) {
    if (!startElementId && (!supportsPromptOnlyVideo(modelId) || endElementId)) {
      return { error: "Pick a start frame — Kling needs one to generate." };
    }
    // BOTH FRAMES CHECKED TOGETHER, not one after the other — they read
    // different rows and neither result feeds the other's query, so the end
    // frame's round trip has no reason to wait for the start frame's to
    // finish first. Precedence is unchanged: `startError` is still read (and
    // returned) before `endError`, so a submission with two bad frames still
    // gets the START error, exactly as it did when that was also the order
    // the requests went out in.
    const [startError, endError] = await Promise.all([
      startElementId
        ? refuseIfNotOwnedImageElement(admin, user.id, startElementId, "start")
        : Promise.resolve(null),
      endElementId
        ? refuseIfNotOwnedImageElement(admin, user.id, endElementId, "end")
        : Promise.resolve(null),
    ]);
    if (startError) return { error: startError };
    if (endError) return { error: endError };
  } else if (endElementId) {
    // A hand-posted form, or a stale one: the column never submits
    // endElementId for a non-Kling model. An end frame only means anything
    // to the ONE model that reads a second image_urls entry as one.
    return { error: "An end frame only applies to Kling." };
  }

  // Two ways to supply the conditioning frame: a fresh upload (the `image`
  // file field, exactly as before), or a previously-saved Element picked
  // from the reference picker's Elements tab (components/ugc-reference-
  // picker.tsx) — `elementId`, an id into `elements` (0065_elements.sql).
  // Never both, and the elementId path is resolved for real (ownership
  // checked, storage copied) down in the write phase below, once the cap
  // check has cleared — same "gate first" ordering the fresh-upload path
  // already follows, so neither path can spend before it's allowed to.
  //
  // KLING TAKES NEITHER OF THOSE — its own Start frame IS the conditioning
  // frame, already validated above, so elementId is simply set to it and
  // every check below (which only ever applies to a NON-Kling submission)
  // is skipped outright.
  let elementId = isKlingSubmission
    ? startElementId
    : String(formData.get("elementId") ?? "").trim();
  const image = isKlingSubmission ? null : formData.get("image");
  const hasUpload = !isKlingSubmission && image instanceof File && image.size > 0;

  if (!isKlingSubmission) {
    // A TAGGED PICTURE IS A PICKED PICTURE. Nothing was attached and nothing
    // was picked in the dialog, but the prompt may already name a saved
    // reference — the case an operator hits every time they paste a prompt
    // that worked before. Refusing that sent them to upload a dummy image,
    // which is not a workaround: the dummy becomes the conditioning frame, so
    // the render is quietly worse than the one they asked for.
    if (!hasUpload && !elementId) {
      elementId = (await firstTaggedImageElementId(admin, user.id, prompt)) ?? "";
    }

    if (
      !hasUpload &&
      !elementId &&
      (!supportsPromptOnlyVideo(modelId) || tagsInOrder(prompt).length > 0) &&
      // A TAGGED VIDEO WITH NO PICTURE IS ALLOWED. kie's bytedance/seedance-2-5
      // schema (read 2026-11-06) has no required input: a video alone is its
      // "Multimodal Reference-to-Video" scenario, which only refuses a
      // first/last frame alongside it — and no frame is sent here. The worker
      // already submits with an empty reference_image_urls (see its
      // TestDispatchAcceptsAVoiceWithNoPicture). A model with no video rate is
      // still refused below, by estimateCost pricing it as unpriceable.
      !(
        supportsPromptOnlyVideo(modelId) &&
        (await taggedVideoInputDurationsS(admin, user.id, prompt)).length > 0
      )
    ) {
      return {
        error:
          "Attach a picture, pick a saved reference, or @tag one in the prompt. It becomes the " +
          "conditioning frame, and a clip queued without one is claimed by the worker and then " +
          "failed.",
      };
    }
    if (hasUpload) {
      // `hasUpload` (not `image instanceof File` again) is the guard above,
      // so TS can't narrow `image` from it alone — the cast is safe because
      // that's exactly what `hasUpload` already established.
      const file = image as File;
      const isGeminiMediaUpload =
        modelId === "gemini-omni-video" &&
        (isAcceptedReferenceAudio(file) || isAcceptedReferenceVideo(file));
      if (!ACCEPTED_IMAGE_TYPES.includes(file.type) && !isGeminiMediaUpload) {
        return { error: `${file.type || "That file"} is not a JPG, PNG or WebP.` };
      }
      if (isAcceptedReferenceAudio(file) && !isAcceptedReferenceAudioSize(file)) {
        return { error: "That audio reference is too large." };
      }
      if (isAcceptedReferenceVideo(file) && !isAcceptedReferenceVideoSize(file)) {
        return { error: "That video reference is too large." };
      }
      if (!isGeminiMediaUpload && file.size > MAX_IMAGE_BYTES) {
        return {
          error: `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 10 MB.`,
        };
      }
    }
  }

  // A direct source-video upload is measured by the picker before it reaches
  // this action. Keep the value separate from the output clip duration: the
  // worker bills Gemini's video-input path from the source's own seconds.
  const primaryVideoDurationRaw = formData.get("primaryVideoDurationS");
  const primaryVideoDurationS =
    primaryVideoDurationRaw === null || String(primaryVideoDurationRaw).trim() === ""
      ? null
      : Number(primaryVideoDurationRaw);

  const durationS = Number(formData.get("durationS"));
  if (!Number.isInteger(durationS) || durationS <= 0) {
    return { error: "Pick a clip length." };
  }

  // The pair must be one this route may SELL, not merely one it can quote.
  // offerable() refuses anything lib/models.ts cannot price from a rate of
  // its own, because that is the table the spend cap enforces against — see
  // lib/kie/offerable.ts's header for the mismatch this closes.
  //
  // THE ARGUMENT IS isAudioEnabled(), NOT false, and getting that wrong is
  // what made the picker offer a model this line then refused by name.
  //
  // offerable() takes `withSound` and reads the sound or the silent rate
  // table accordingly. Every render this route makes sets generate_audio
  // true, and estimateCost below is already passed isAudioEnabled() — so a
  // hardcoded `false` here asked the silent table whether a pair was
  // sellable while the cap was enforced against the sound one. Seedance 2.0
  // and 2.0 Fast have NO silent rate at all (nothing has ever been rendered
  // on them that way, and copying the sound number across would assert that
  // audio is free), so they came back unsellable however they were priced,
  // and the operator got "seedance-2 at 480p is not offered" under a picker
  // that had just offered it.
  //
  // The picker resolves its own list with ugcOptions(isAudioEnabled()) —
  // ugc/[id]/page.tsx fixed this side and not this one. Reading the same env
  // on both sides is what actually keeps them in step; matching literals
  // would drift again.
  const byteplusRefusal = byteplusResolutionRefusal(modelId, resolution);
  if (byteplusRefusal) return { error: byteplusRefusal };
  if (!canUseVideoModel(profile.role, modelId)) {
    return { error: `${getModel(modelId).label} is not available to your role.` };
  }
  const allowed = offerable(isAudioEnabled());
  const chosen = allowed.find((o) => o.model.id === modelId && o.resolution === resolution);
  if (!chosen) {
    return {
      error:
        `${modelId || "That model"} at ${resolution || "that resolution"} is not offered. ` +
        `Available: ${allowed.map((o) => `${o.model.label} ${ugcTierLabel(o.model.id, o.resolution)}`).join(", ")}.`,
    };
  }

  const model = getModel(modelId);

  // Gemini's image/video quota and its audio-id mismatch are rejected before
  // the cap check and before this action creates any rows. Existing models
  // intentionally skip this branch and retain their current handling.
  if (chosen.model.id === "gemini-omni-video") {
    const uploadedPrimaryKind =
      hasUpload && image instanceof File
        ? isAcceptedReferenceAudio(image)
          ? "audio"
          : isAcceptedReferenceVideo(image)
            ? "video"
            : "image"
        : "image";
    const referenceRefusal = await geminiReferenceRefusal(
      admin,
      user.id,
      prompt,
      uploadedPrimaryKind,
      elementId,
      resolution,
      primaryVideoDurationS,
    );
    if (referenceRefusal) return { error: referenceRefusal };
  }

  // Carried on the SCENE, not the project. The UGC project's render_settings
  // are whatever the column defaults to and nobody edits them; the model and
  // resolution chosen for THIS clip ride on the scene, the same way a retry's
  // model override does.
  //
  // Built directly rather than through RenderSettingsOverrideSchema, which is
  // the RETRY path's shape and carries `model` alone. Passing a resolution to
  // it did not fail — zod stripped the key and returned success — so this
  // route wrote a clip with no resolution, the merge fell back to the model's
  // default (Seedance's 480P, the tier offerable() refuses because nobody has
  // been billed for it), and the cap was checked against a rate the operator
  // was never shown. That schema is `.strictObject` now so the same mistake
  // fails at the call site instead of silently.
  //
  // The pair is already validated: offerable() above rejects any model and
  // resolution this route may not sell, which is a stronger check than a
  // shape schema — it asks whether the price is real, not whether the field
  // exists. render_settings_override is a partial jsonb blob (0045), so both
  // keys are legal to store.
  // chosen.model.id, NOT model.id, and the difference was a wrong charge.
  //
  // `model` above comes from getModel(), which returns SEEDANCE_2_5 for an id
  // it does not know instead of failing. lib/models.ts had been left at three
  // descriptors while offerable() (reading lib/kie/models.ts) had grown to
  // five, so picking Seedance 2.0 passed the gate here and was then written
  // to the scene as seedance-2.5 — a clip quoted at 19 credits/s and rendered
  // at 28. Silent, because a fallback is not an error.
  //
  // Both lists carry all five now, so the two agree again. This line reads
  // `chosen` regardless: `chosen` is the offer the operator actually selected
  // and the one whose price they were shown, and taking the id from it means
  // no future gap between the tables can be resolved into a different model
  // behind their back.
  const voice = geminiVoiceFor(chosen.model.id, formData.get("geminiVoice"));
  // No price effect: kie bills per second by resolution, not by frame shape.
  const aspectRatio = videoAspectRatioFor(chosen.model.id, formData.get("aspectRatio"));
  // No price effect either: only our own re-encode reads it (lib/video-quality.ts).
  // The editor's pick; a BytePlus scene with none still defaults to High.
  const quality =
    videoQualityFor(formData.get("quality")) ??
    (chosen.model.id === BYTEPLUS_SEEDANCE_ID ? BYTEPLUS_SEEDANCE_QUALITY : null);
  const override = {
    model: chosen.model.id,
    resolution,
    ...(voice && { voice }),
    ...(aspectRatio && { aspect_ratio: aspectRatio }),
    ...(quality && { quality }),
  };

  const settings = mergeRenderSettings(project.render_settings, override);
  const audioEnabled = isAudioEnabled();

  // --- Gate first, write second. ------------------------------------------
  //
  // Run against a synthetic scene carrying exactly the two fields these
  // guards read. They are pure shape checks — assertRenderableDurations asks
  // whether pickModel's chosen model allows this duration, and
  // assertSettingsAllowedForDurations whether the fps does — so a shape is
  // the honest input, and running them here means an illegal 4s Hailuo clip
  // is refused before an image is uploaded rather than after.
  //
  // is_talking_head is what asks Kling for sound. PickModel never routes BY
  // is_talking_head — settings.model is authoritative (see its own doc
  // comment) — but for a scene that already resolves to Kling,
  // nativeAudioModel turns the wire "sound" flag on only when
  // is_talking_head && AUDIO_ENABLED, and pricingAudioOn reads the same pair
  // on this side to choose a rate table. Seedance ignores it outright —
  // generate_audio already follows AUDIO_ENABLED alone. With no script_line
  // on any /ugc scene, promptForScene's "Dialogue, spoken aloud" append can
  // never fire either way.
  //
  // KLING READS THE SUBMITTED SOUND CHOICE, not nativeAudio unconditionally
  // — that was the whole route before this control existed, and it meant
  // every Kling render asked for sound whether or not the operator wanted
  // it. `&& audioEnabled` is the same belt-and-braces the column's own
  // effectiveSoundOn applies: a hand-posted "sound=1" cannot turn audio on
  // when AUDIO_ENABLED is off, regardless of what the UI would have allowed.
  const isTalkingHead = isKlingSubmission
    ? formData.get("sound") === "1" && audioEnabled
    : getModel(chosen.model.id).nativeAudio;
  const intended = [{ duration_s: durationS, is_talking_head: isTalkingHead }];

  const durationsResult = guardResult(() =>
    assertRenderableDurations(intended, settings, audioEnabled),
  );
  if (durationsResult) return durationsResult;

  const settingsResult = guardResult(() =>
    assertSettingsAllowedForDurations(intended, model, settings),
  );
  if (settingsResult) return settingsResult;

  // THREE INDEPENDENT READS, run together instead of one after another.
  // taggedVideoInputDurationsS, resolveElementTags and unknownElementTags
  // each do their own `elements`/`assets` lookup over the same (userId,
  // prompt) pair, and none of them reads anything the other two write — so
  // nothing stops them running concurrently.
  //
  // ERROR PRECEDENCE IS UNCHANGED. Today: the cap check runs first (using
  // taggedVideoInputDurationsS's result), and resolveElementTags/
  // promptTooLongForModel are not even COMPUTED until after it passes —
  // unknownElementTags never produces an error at all, only a notice
  // reported at the very end. Running resolveElementTags and
  // unknownElementTags concurrently with taggedVideoInputDurationsS means
  // they now RESOLVE earlier (even on a submission the cap is about to
  // refuse), but their results are still only INSPECTED in the same order
  // as before: assertWithinSpendCaps is checked and returned first, and only
  // once it has passed does promptTooLongForModel's pre-computed result get
  // looked at. A submission that busts the cap and overflows the prompt
  // limit still gets the cap's message.
  //
  // estimateCost, not a rate times a duration: this clip may route to a
  // different model than the one selected (pickModel substitutes the
  // default for an unrecognised id — see its own doc comment), and the cap
  // has to be enforced against what the worker will actually charge.
  // THE VIDEO'S OWN SECONDS ARE BILLED TOO, and until 2026-09-10 nothing
  // told the cap so. A 4s clip carrying a 4.064s video bills 136 credits
  // where this quoted 112 — the cap was being enforced against a number
  // 21% under the real one. (Above roughly 6.2s of output the error flips
  // and the quote is too HIGH instead, because the per-second rate drops
  // from 28 to 17 when a video is attached; neither direction is a quote
  // worth defending.)
  //
  // KLING NEVER SUBSTITUTES. There is no box for it and no allowlist to
  // enforce, and the whole point of leaving an '@' in a Kling prompt is that
  // the WORKER, not this action, decides what to do with it — 42d29e3 made
  // bindUITags strip a bare '@' for a model without role references rather
  // than treat it as an index into reference_image_urls. Running
  // resolveElementTags here anyway would substitute a description in for
  // any tag that happens to have one, which is exactly the mechanism that
  // put a 4,740-character prompt past Kling's cap while the operator was
  // looking at a 2,310-character box (this file's own history, and the
  // reason maxPromptChars exists at all) — so a Kling submission's
  // submittedPrompt is the prompt exactly as typed, and promptTooLongForModel
  // below checks exactly that length.
  const [videoReferenceDurationsS, submittedPrompt, unknownTags] = await Promise.all([
    taggedVideoInputDurationsS(admin, user.id, prompt),
    isKlingSubmission ? Promise.resolve(prompt) : resolveElementTags(admin, user.id, prompt),
    unknownElementTags(admin, user.id, prompt),
  ]);
  const allVideoReferenceDurationsS =
    hasUpload && image instanceof File && isAcceptedReferenceVideo(image)
      ? [...videoReferenceDurationsS, primaryVideoDurationS]
      : videoReferenceDurationsS;
  const estimate = estimateCost(
    {
      character: "",
      scenes: [
        {
          script_line: "",
          video_prompt: prompt,
          is_talking_head: isTalkingHead,
          duration_s: durationS,
          videoReferenceDurationsS: allVideoReferenceDurationsS,
        },
      ],
    },
    audioEnabled,
    settings,
  );
  const capResult = await assertWithinSpendCaps(user.id, profile, estimate.totalUsd);
  if (capResult) return capResult;

  // --- Write. -------------------------------------------------------------

  // What the operator wrote, and what the vendor will be given. The second is
  // the first with every "@name" swapped for that element's description; see
  // resolveElementTags above for why this is a substitution and not a model
  // call. Already resolved above, concurrently with the cap check's own
  // dependency — nothing here re-reads it.
  //
  // Substitution reads `prompt` — the box as it stands now — and NOT
  // authoredPrompt. When Refine ran, the box holds Refine's output and
  // operatorPrompt holds what preceded it; substituting the earlier text
  // would throw the refinement away. The box is always what gets sent.
  const authoredPrompt = operatorPrompt || prompt;

  // BEFORE THE SCENE IS WRITTEN, so an over-long prompt costs a message
  // rather than a queued row that dies at the vendor. Nothing has been spent
  // at this point — the cap check has passed but the worker has not seen
  // this scene — so returning here leaves no trace to clean up.
  const tooLong = promptTooLongForModel(chosen.model.id, submittedPrompt);
  if (tooLong) return tooLong;

  // unknownTags was resolved in the same concurrent batch above, from the
  // same text substitution's own prompt — and it is only ever reported at
  // the very end, after the render is safely queued. This must never be
  // able to stop a clip: the trade "a worse clip, not a lost one" is older
  // than this warning and is not being reversed by it.

  // The conditioning frame IS the image — no nano-banana pass, no
  // composite. That is the biggest difference from the wizard, where
  // actions/frames.ts generates a ref_frame from the character and product
  // references. Here the operator brought their own (or picked one they
  // already saved), so generating one from it would cost $0.02 and a wait
  // to arrive at a worse version of the image they just chose.
  let storageKey: string | null = null;
  let primaryDurationS: number | null = null;
  // Resolved by whichever branch below runs, and carried all the way to
  // scene_references so the worker puts it in the right one of kie's arrays.
  let primaryKind: "image" | "audio" | "video" = "image";
  // NO SNAPSHOT COLUMNS HERE. An earlier draft of this route wrote the
  // element's category, description and name onto the scene so the worker
  // could tell Seedance what "@image1" was. That whole mechanism is gone: a
  // clip sends no reference images at all, and the description is resolved
  // into the prompt text by Refine before the scene is ever created.
  //
  // The three columns it wrote were never in a migration — the 0071 draft
  // that added them was replaced by scene_references before it was
  // committed, and this insert kept naming them. types/db.ts kept typing
  // them too, so it type-checked, and every Generate on /ugc failed in
  // production with "Could not find the 'ref_frame_category' column of
  // 'scenes' in the schema cache". lib/db-types-drift.test.ts now fails on
  // that shape.
  //
  // The provenance a snapshot used to carry lives in the pair 0072 added —
  // video_prompt holds the operator's words, ai_generated_prompt holds what
  // Seedance was actually sent — and ref_frame_asset_id still records which
  // image was chosen. Nothing was lost by dropping them.
  if (elementId) {
    // Ownership is checked here, in TypeScript, the same way requireScene
    // checks a scene id — elements RLS would filter a stranger's row on the
    // read below to nothing, but that reads as "not found" either way, so
    // the explicit user_id compare is what turns a forged elementId into a
    // clear refusal instead of a generic missing-row error.
    const { data: element, error: elementError } = await admin
      .from("elements")
      .select("asset_id, user_id")
      .eq("id", elementId)
      .is("deleted_at", null)
      .maybeSingle();
    if (elementError) {
      throw new Error(`Failed to read reference ${elementId}: ${elementError.message}`);
    }
    if (!element || element.user_id !== user.id) {
      return { error: "That saved reference is no longer available." };
    }
    const { data: sourceAsset, error: sourceAssetError } = await admin
      .from("assets")
      .select("storage_key, kind, duration_s")
      .eq("id", element.asset_id)
      .maybeSingle();
    if (sourceAssetError) {
      throw new Error(`Failed to read the reference's image: ${sourceAssetError.message}`);
    }
    if (!sourceAsset) {
      return { error: "That saved reference's image is missing." };
    }
    // Copied into THIS project, not pointed at across projects — same
    // reason useCharacter (actions/character-library.ts) copies a library
    // character's photo rather than referencing it: a scene's ref_frame_asset_id
    // pointing at another project's asset row would make this project's
    // clip depend on that other project (and its asset) continuing to
    // exist, which elements.asset_id's own `on delete cascade` cannot
    // promise once the source is no longer under THIS operator's eyes here.
    // THE PRIMARY CAN BE A VOICE, and this path did not know that until
    // 2026-09-04. It copied every picked reference under 'ref_frame' with a
    // jpg default, so a picked MP3 became a ref_frame asset holding audio
    // bytes — which attachSceneReferences then read as an image and sent in
    // reference_image_urls. kie answered exactly what you would expect:
    //
    //   vendor reported code=500 msg="File type not supported"
    //
    // The tagged-reference loop above was taught this and this branch was
    // not, which is the whole bug: one route into the same table, written
    // twice.
    // AND THEN IT HAPPENED A THIRD TIME. The paragraph above describes this
    // branch learning about audio in 2026-09-04 after the tag loop already
    // knew; 0093 added video_ref and this line read `=== "audio" ? ... :
    // "image"` again, so a picked MP4 became a ref_frame asset holding video
    // bytes under a .jpg name. Same copy, same wrong reference_image_urls,
    // same 500 from kie — the denylist shape is what repeats, not the kind.
    //
    // The client no longer offers a video for this slot at all
    // (components/ugc-column.tsx's taggedReferences), so reaching here with
    // one means a hand-posted form. It is still handled rather than refused:
    // storing the bytes correctly costs one ternary, and a video that lands
    // here as 'video' is a reference the render can actually use, where one
    // that lands as a .jpg is a guaranteed vendor error after the spend was
    // approved.
    primaryKind =
      sourceAsset.kind === "audio" ? "audio" : sourceAsset.kind === "video_ref" ? "video" : "image";
    primaryDurationS = sourceAsset.kind === "video_ref" ? sourceAsset.duration_s : null;
    const toKey = buildStorageKey({
      projectId: project.id,
      kind: primaryAssetKind(primaryKind),
      ext: extFromFilename(
        sourceAsset.storage_key,
        primaryKind === "audio" ? "mp3" : primaryKind === "video" ? "mp4" : "jpg",
      ),
    });
    await copyStorageObject(sourceAsset.storage_key, toKey);
    storageKey = toKey;
  } else if (hasUpload) {
    // A fresh upload through the dialog, which accepts all three kinds.
    // "both" was accurate until 0093 and is the same two-way reading that
    // put video bytes behind a .jpg on the branch above; an unrecognised
    // file still falls to "image", which is what the dialog's own accept
    // attribute has already narrowed to a picture.
    primaryKind = isAcceptedReferenceAudio(image as File)
      ? "audio"
      : isAcceptedReferenceVideo(image as File)
        ? "video"
        : "image";
    primaryDurationS = primaryKind === "video" ? primaryVideoDurationS : null;
    ({ storageKey } = await uploadFile({
      file: image as File,
      projectId: project.id,
      kind: primaryAssetKind(primaryKind),
    }));
  }

  let primaryAssetId: string | null = null;
  if (storageKey) {
    const { data: asset, error: assetError } = await admin
      .from("assets")
      .insert({
        project_id: project.id,
        // MUST AGREE WITH THE KEY ABOVE. This said `audio, else ref_frame`,
        // so a video stored under projects/{id}/video_ref/... was recorded as
        // a ref_frame — the row and the object disagreeing about what the
        // bytes are, which is precisely the question this column exists to
        // answer for storage cleanup and the library grid.
        kind: primaryAssetKind(primaryKind),
        storage_key: storageKey,
        duration_s: primaryDurationS,
      })
      .select("id")
      .single();

    if (assetError || !asset) {
      throw new Error(`Failed to record the reference frame: ${assetError?.message ?? "no row"}`);
    }
    primaryAssetId = asset.id;
  }

  // scenes has `unique (project_id, idx)`. Unlike the brief editor's addScene
  // this never interleaves — a /ugc clip is always appended — so max+1 is
  // correct and the negative-placeholder dance persistOrder needs does not
  // apply.
  const { data: last, error: idxError } = await admin
    .from("scenes")
    .select("idx")
    .eq("project_id", project.id)
    .order("idx", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (idxError) throw new Error(`Failed to read the last scene index: ${idxError.message}`);
  const idx = (last?.idx ?? 0) + 1;

  const { data: scene, error: sceneError } = await admin
    .from("scenes")
    .insert({
      project_id: project.id,
      idx,
      // No script_line: there is no script. The prompt is the whole
      // instruction, written by the operator, and it is what the worker sends
      // verbatim.
      // THE PAIR (0072), and the reason both halves are kept.
      //
      // video_prompt is what the operator can read back and edit: their own
      // words, "@lena_ref" and all. ai_generated_prompt is what the worker
      // actually submits — the same text with every resolvable tag replaced
      // by the element's description.
      //
      // Null when they are identical, which is the honest encoding of "no
      // substitution happened": the worker falls back to video_prompt, and a
      // scene that named no element is not made to look like one that did.
      //
      // A wrong clip therefore has a readable cause. video_prompt says what
      // was asked for, ai_generated_prompt says what was sent, and the
      // difference between them is exactly what the references contributed.
      video_prompt: authoredPrompt,
      ai_generated_prompt: submittedPrompt === authoredPrompt ? null : submittedPrompt,
      duration_s: durationS,
      is_talking_head: isTalkingHead,
      ref_frame_asset_id: primaryAssetId,
      render_settings_override: override,
      status: "frame_ready",
    })
    .select("*")
    .single();

  if (sceneError || !scene) {
    throw new Error(`Failed to create the clip: ${sceneError?.message ?? "no row"}`);
  }

  await attachSceneReferences({
    admin,
    projectId: project.id,
    userId: user.id,
    sceneId: scene.id,
    prompt: authoredPrompt,
    primaryAssetId,
    primaryKind,
    primaryElementId: elementId || null,
    // undefined for every other model (runs the tag loop exactly as
    // before); present for Kling, even as null, so the loop is skipped and
    // only the end frame (if any) is attached — see that argument's own
    // doc comment on attachSceneReferences.
    ...(isKlingSubmission ? { klingEndElementId: endElementId } : {}),
  });

  // The two guards that need a real row, run against the row that was
  // actually written. Both should hold by construction — the frame was just
  // pinned and the status was just set — so a failure here means the insert
  // did not do what it claimed, which is worth refusing over rather than
  // queueing a render against.
  const framedResult = guardResult(() => {
    if (!supportsPromptOnlyVideo(modelId)) assertAllFramed([scene]);
  });
  if (framedResult) return framedResult;
  const spentResult = guardResult(() => assertNotAlreadySpent([scene]));
  if (spentResult) return spentResult;

  // Open a version row, the same as every other path that queues a scene.
  //
  // An earlier draft of this file skipped it, reasoning that a /ugc clip is
  // generated once, downloaded, and never re-rendered through the wizard's
  // version picker. That was wrong about this workflow. The loop here is
  // generate, look, generate again — retries are the normal case, not the
  // exception — and every attempt is billed. Without the row there is no
  // record of what the earlier takes were rendered with or what they cost.
  //
  // Best-effort by design: openSceneVersion logs and swallows its own
  // failures, because bookkeeping must not block a render the cap check has
  // already cleared.
  await openSceneVersion(admin, scene, settings);

  if (
    typeof (admin as { rpc?: unknown }).rpc === "function" &&
    typeof (assertWithinSpendCaps as { queueScenes?: unknown }).queueScenes === "function"
  ) {
    const queueResult = await (
      assertWithinSpendCaps as typeof assertWithinSpendCaps & {
        queueScenes: typeof queueScenesIfWithinCaps;
      }
    ).queueScenes({
      admin,
      projectId: project.id,
      userId: user.id,
      profile,
      sceneIds: [scene.id],
      estimatesUsd: [estimate.totalUsd],
    });
    if (queueResult.outcome === "blocked") return { error: queueResult.error };
  } else {
    const { error: queueError } = await admin
      .from("scenes")
      .update({ status: "queued", dev: isDev() })
      .eq("id", scene.id);

    if (queueError) throw new Error(`Failed to queue the clip: ${queueError.message}`);
  }

  revalidatePath(`/ugc/${projectId}`);

  // THE CLIP IS ALREADY QUEUED. This is the last thing that happens and it
  // changes nothing about the render — it only stops the one failure mode
  // this whole route could not report: money spent on a reference that was
  // never attached.
  if (unknownTags.length > 0) {
    const named = unknownTags.map((t) => `@${t}`).join(", ");
    return {
      sceneId: scene.id,
      notice:
        unknownTags.length === 1
          ? `Rendering without ${named} — you have no reference by that name. Renamed it?`
          : `Rendering without ${named} — no references by those names. Renamed them?`,
    };
  }
  return { sceneId: scene.id };
}

/**
 * Re-renders the selected scene, opening ANOTHER version beside its current
 * clip rather than replacing it.
 *
 * The button says "Regenerate" rather than "Generate" whenever the result box
 * holds something, and this is what that word means. Both spend, so the two
 * must be distinguishable before the press: Generate makes a new scene, this
 * makes a new attempt at an existing one.
 *
 * Saves the prompt first when it has been edited, for the same reason
 * GenerateReferenceAction does on the Character screen: the operator asked
 * for a render of the words in front of them, and spending on the previous
 * text is the expensive kind of surprise.
 *
 * The money guards are NOT re-implemented here. rerenderScene (a 'done'
 * scene) and retryScene (a 'failed' one — see the status branch below) own
 * them — requireScene for ownership, assertRenderableDurations, a server-
 * side re-price off the scene's own effective settings, and
 * assertWithinSpendCaps — and duplicating that sequence is exactly how the
 * six existing writers drifted apart from each other. regenerateClip runs
 * its OWN early status check (not assertSceneRerenderable — see that check's
 * own comment for why), so a refusal writes nothing before rerenderScene/
 * retryScene ever repeat a check of their own.
 *
 * A FAILED SCENE REGENERATES TOO, as of /ugc's own "Try again" control being
 * retired from the failure panel (page.tsx) — Regenerate is now the only
 * requeue control this route has, so it cannot refuse the one status that
 * control used to own. See the status branch at the bottom of this function.
 */
export async function regenerateClip(formData: FormData): Promise<ActionResult> {
  const sceneId = String(formData.get("sceneId") ?? "");
  if (!sceneId) return { error: "No scene selected to regenerate." };

  const prompt = String(formData.get("prompt") ?? "").trim();
  if (!prompt) {
    return { error: "Write a prompt first — it is the whole instruction the model gets." };
  }

  // requireScene, not requireUser: this is a write against someone else's
  // possible scene id, and ownership is enforced in TypeScript here rather
  // than by RLS (the write below goes through the admin client). `user` is
  // requireScene's own requireProject(scene.project_id) call surfacing the
  // scene's owner — the same identity generateClip's insert uses as
  // resolveElementTags' userId — not a new check reached for here; nothing
  // widens by naming it.
  const { user, project, scene, profile } = await requireScene(sceneId);

  // Same marker/box reasoning as generateClip above — only enforced when the
  // column actually rendered a box (a caller that skips the column entirely,
  // as retryClip used to, must not be judged against one it never showed).
  const referencesBoxSubmitted = formData.get("referencesBox") === "1";
  const boxTags = formData.getAll("referenceTag").map((t) => String(t));
  if (referencesBoxSubmitted && boxTags.length > MAX_REFERENCES) {
    return { error: `A scene holds at most ${MAX_REFERENCES} references.` };
  }
  if (referencesBoxSubmitted) {
    const outsideBox = await elementTagsOutsideBox(createAdminClient(), user.id, prompt, boxTags);
    if (outsideBox.length > 0) {
      return {
        error:
          `${outsideBox.map((t) => `@${t}`).join(", ")} ` +
          `${outsideBox.length === 1 ? "is" : "are"} tagged in the prompt but not in this scene's ` +
          `References box. Add ${outsideBox.length === 1 ? "it" : "them"} to the box, or remove ` +
          `the tag from the prompt.`,
      };
    }
  }

  // REGENERATE, NOT JUST rerenderScene's OWN GUARD. assertSceneRerenderable
  // (lib/enqueue-guard.ts) is 'done'-only — it is shared with scene-
  // rerender-dialog.tsx's built-in "rerender" kind and the scripted
  // pipeline's own Re-render control, and loosening IT would let those
  // re-render a scene that has never finished rendering at all. /ugc's own
  // rule is different since its "Try again" control was retired: Regenerate
  // is now the ONLY requeue control on this route, so it has to accept a
  // FAILED scene too, not just a done one — see the branch on scene.status
  // below, which calls retryScene (with this route's own versionMode) for
  // "failed" and rerenderScene (unchanged) for "done".
  //
  // Checked HERE, BEFORE the settings write below, for the same reason the
  // old rerenderable check ran early: this function writes
  // render_settings_override/is_talking_head onto the scene first, so a
  // refusal has to happen before that write, not after — a scene still
  // queued/rendering must not have its settings overwritten out from under
  // the in-flight job's own ingest/reconcile/webhook.
  //
  // A PLAIN MESSAGE, not assertSceneRerenderable's own — that one is written
  // for the scripted pipeline ("Use retryScene for a failed scene, or
  // enqueueRender...") and reached /ugc's editors verbatim in production
  // (scene 3, prod) as developer-speak about actions this route does not
  // even expose.
  if (scene.status === "queued" || scene.status === "rendering") {
    return {
      error:
        "This scene is already rendering. Wait for the current attempt to finish before pressing Regenerate again.",
    };
  }
  if (scene.status !== "done" && scene.status !== "failed") {
    return { error: "This scene hasn't rendered yet, so there's nothing to regenerate." };
  }

  // The pickers are an INPUT here, not just a report.
  //
  // rerenderScene takes no settings — it prices and submits whatever the scene
  // stores — so a model or length chosen in the column reaches the render only
  // if it is written first. Before this, changing LENGTH from 4s to 8s moved
  // the quote on the button to 504 credits and then rendered 4s for 252: a
  // control that looked live, changed the price, and did nothing.
  //
  // Validated BEFORE anything is written — this block's own checks, and the
  // rerenderable check above — so a refusal FROM THESE CHECKS cannot leave
  // the scene claiming settings it was never rendered at. The cap is not
  // checked here on purpose: rerenderScene checks it below, against the
  // settings this block just stored, which is the only check that describes
  // the render that will actually run — and a cap refusal from rerenderScene
  // still leaves this write in place; that gap is not addressed here.
  const modelId = String(formData.get("modelId") ?? "");
  const resolution = String(formData.get("resolution") ?? "");
  const durationRaw = formData.get("durationS");
  const durationS = durationRaw === null ? null : Number(durationRaw);

  const updates: {
    render_settings_override?: {
      model: string;
      resolution: string;
      voice?: string;
      aspect_ratio?: string;
      quality?: string;
    };
    duration_s?: number;
    video_prompt?: string;
    ai_generated_prompt?: string | null;
    is_talking_head?: boolean;
    ref_frame_asset_id?: string | null;
  } = {};

  // KLING'S OWN PAIR, read unconditionally: the column only ever submits
  // these when its own model select is on Kling, but reading them here
  // (rather than inside the `if (modelId || resolution)` block below) means
  // a Regenerate that changes NEITHER — not this route's shape, since the
  // column always sends both, but a defensive read for any other caller —
  // still refuses an end frame that names a non-Kling scene, below.
  const startElementIdRaw = String(formData.get("startElementId") ?? "").trim();
  const endElementIdRaw = String(formData.get("endElementId") ?? "").trim();
  const endElementId = endElementIdRaw || null;

  const admin = createAdminClient();

  // Set inside the block below when a model/resolution was actually
  // submitted (the column always sends both). Stays false for any other
  // caller that changes neither — resolveElementTags then runs unchanged,
  // which is the pre-existing behaviour for a plain prompt edit.
  let isKlingNow = false;

  if (modelId || resolution) {
    // isAudioEnabled(), for the reason spelled out in generateClip above:
    // this is the same gate on the settings-change path, and a pair it
    // refuses here is one the picker has already shown.
    const byteplusRefusal = byteplusResolutionRefusal(modelId, resolution);
    if (byteplusRefusal) return { error: byteplusRefusal };
    if (!canUseVideoModel(profile.role, modelId)) {
      return { error: `${getModel(modelId).label} is not available to your role.` };
    }
    const allowed = offerable(isAudioEnabled());
    const chosen = allowed.find((o) => o.model.id === modelId && o.resolution === resolution);
    if (!chosen) {
      return {
        error:
          `${modelId || "That model"} at ${resolution || "that resolution"} is not offered. ` +
          `Available: ${allowed.map((o) => `${o.model.label} ${ugcTierLabel(o.model.id, o.resolution)}`).join(", ")}.`,
      };
    }
    isKlingNow = getModel(chosen.model.id).nativeAudio;

    // Same refusal as generateClip's, and for the same reason (see
    // klingTagRefusal's own comment) — BEFORE any write below, let alone the
    // spend/cap check rerenderScene runs.
    if (isKlingNow) {
      const tagRefusal = klingTagRefusal(prompt);
      if (tagRefusal) return { error: tagRefusal };
    }

    // Built directly rather than through RenderSettingsOverrideSchema — that
    // is the retry path's shape and carries `model` alone. See generateClip's
    // own note on the zod strip this avoids.
    const voice = geminiVoiceFor(chosen.model.id, formData.get("geminiVoice"));
    const aspectRatio = videoAspectRatioFor(chosen.model.id, formData.get("aspectRatio"));
    const quality =
      videoQualityFor(formData.get("quality")) ??
      (chosen.model.id === BYTEPLUS_SEEDANCE_ID ? BYTEPLUS_SEEDANCE_QUALITY : null);
    updates.render_settings_override = {
      model: chosen.model.id,
      resolution,
      ...(voice && { voice }),
      ...(aspectRatio && { aspect_ratio: aspectRatio }),
      ...(quality && { quality }),
    };
    // Same rule generateClip's insert follows now — see its own comment.
    // Switching Seedance -> Kling here must turn sound on, and Kling ->
    // Seedance must turn it back off; rerenderScene re-reads the row after
    // this write, so its estimate follows whichever way this just moved.
    //
    // KLING READS THE SUBMITTED SOUND CHOICE, same reasoning as
    // generateClip's own isTalkingHead — nativeAudio unconditionally was
    // the whole route before the Sound On/Off control existed.
    updates.is_talking_head = isKlingNow
      ? formData.get("sound") === "1" && isAudioEnabled()
      : getModel(chosen.model.id).nativeAudio;

    // The length is checked against THIS offer's own durations, not against
    // lib/models.ts's descriptor.
    //
    // They are two lists — KieModel.durationsS is what the column builds its
    // dropdown from, VideoModelDescriptor.allowedDurationsS is what the
    // scripted pipeline validates against — and validating here against the
    // one the operator was NOT offered would refuse a length the picker had
    // just presented as available. Checking the offer closes the loop: the
    // same object that produced the option approves it.
    if (durationS !== null) {
      if (!Number.isInteger(durationS) || durationS <= 0) {
        return { error: "Pick a clip length." };
      }
      if (!chosen.model.durationsS.includes(durationS)) {
        return {
          error: `${chosen.model.label} does not render ${durationS}s clips. It offers ${chosen.model.durationsS.join(", ")}s.`,
        };
      }
      updates.duration_s = durationS;
    }

    if (isKlingNow) {
      if (!startElementIdRaw && (!supportsPromptOnlyVideo(modelId) || endElementId)) {
        return { error: "Pick a start frame — Kling needs one to regenerate." };
      }
      if (!startElementIdRaw) {
        updates.ref_frame_asset_id = null;
        const { error } = await admin.from("scene_references").delete().eq("scene_id", scene.id);
        if (error) throw new Error(`Failed to clear references: ${error.message}`);
      } else {
        const startError = await refuseIfNotOwnedImageElement(
          admin,
          user.id,
          startElementIdRaw,
          "start",
        );
        if (startError) return { error: startError };
        if (endElementId) {
          const endError = await refuseIfNotOwnedImageElement(admin, user.id, endElementId, "end");
          if (endError) return { error: endError };
        }

        // COPIED, NOT POINTED AT — same "this scene owns its own bytes" rule
        // generateClip's elementId branch follows for a fresh Generate. The
        // operator may have picked a DIFFERENT start frame than the scene
        // already had, so this always copies fresh rather than reusing
        // scene.ref_frame_asset_id.
        const { data: startElement, error: startElementError } = await admin
          .from("elements")
          .select("asset_id")
          .eq("id", startElementIdRaw)
          .is("deleted_at", null)
          .maybeSingle();
        if (startElementError || !startElement) {
          throw new Error(
            `Failed to read the start frame: ${startElementError?.message ?? "no row"}`,
          );
        }
        const { data: startAsset, error: startAssetError } = await admin
          .from("assets")
          .select("storage_key")
          .eq("id", startElement.asset_id)
          .maybeSingle();
        if (startAssetError || !startAsset) {
          throw new Error(
            `Failed to read the start frame's image: ${startAssetError?.message ?? "no row"}`,
          );
        }
        const toKey = buildStorageKey({
          projectId: scene.project_id,
          kind: "ref_frame",
          ext: extFromFilename(startAsset.storage_key, "jpg"),
        });
        await copyStorageObject(startAsset.storage_key, toKey);
        const { data: copied, error: copiedError } = await admin
          .from("assets")
          .insert({
            project_id: scene.project_id,
            scene_id: scene.id,
            kind: "ref_frame",
            storage_key: toKey,
          })
          .select("id")
          .single();
        if (copiedError || !copied) {
          throw new Error(`Failed to record the start frame: ${copiedError?.message ?? "no row"}`);
        }
        updates.ref_frame_asset_id = copied.id;

        // REPLACE THE SCENE'S REFERENCES, not append — attachSceneReferences'
        // own delete-then-insert (see its doc comment) is exactly the
        // "regenerating on Kling ends with only start/end refs" rule the spec
        // for this route states, whether the scene was last rendered on Kling
        // or on Seedance with a whole box of tags.
        await attachSceneReferences({
          admin,
          projectId: scene.project_id,
          userId: user.id,
          sceneId: scene.id,
          prompt,
          primaryAssetId: copied.id,
          primaryKind: "image",
          primaryElementId: startElementIdRaw,
          klingEndElementId: endElementId,
        });
      }
    } else if (endElementId) {
      // Defensive, same reasoning as generateClip's own check: an end frame
      // only means anything to Kling.
      return { error: "An end frame only applies to Kling." };
    }
  } else if (endElementId) {
    return { error: "An end frame only applies to Kling." };
  }

  // A Gemini model switch must validate the scene's retained references
  // before the settings/prompt write below. Regenerate does not rebuild the
  // References box for non-Kling models, so inspecting the current
  // scene_references rows is the only reliable source of what the worker
  // will actually submit (and avoids counting stale scene assets).
  const effectiveRegenerateSettings = mergeRenderSettings(
    project.render_settings,
    updates.render_settings_override ?? scene.render_settings_override,
  );
  if (
    !supportsPromptOnlyVideo(effectiveRegenerateSettings.model) &&
    !(updates.ref_frame_asset_id === undefined
      ? scene.ref_frame_asset_id
      : updates.ref_frame_asset_id)
  ) {
    return { error: "This model needs a reference image. Pick a frame or switch models." };
  }
  if (effectiveRegenerateSettings.model === "gemini-omni-video") {
    const referenceRefusal = await geminiSceneReferenceRefusal(
      admin,
      scene.id,
      scene.ref_frame_asset_id,
      effectiveRegenerateSettings.resolution,
    );
    if (referenceRefusal) return { error: referenceRefusal };
  }

  if (prompt !== (scene.video_prompt ?? "").trim()) {
    updates.video_prompt = prompt;
  }

  // THE BUG THIS CLOSES. scenes.ai_generated_prompt is written in exactly
  // one other place — generateClip's insert — and dispatch.go's
  // promptForScene (worker/internal/loop/dispatch.go) prefers it over
  // video_prompt whenever it is non-empty. Before this block, editing a
  // tagged scene's prompt here updated video_prompt and stopped: the column
  // the worker actually reads kept the OLD substitution forever, so
  // Regenerate quietly re-rendered what the operator had just edited away
  // from. Confirmed in production 2026-08-30 — a scene re-rendered after a
  // substitution fix shipped came back byte-identical at 5483 characters,
  // billed in full for a clip nobody asked for.
  //
  // Recomputed on EVERY regenerate, not gated on `prompt !== video_prompt`
  // above: an element's description can be written or edited long after its
  // scene exists (voice elements got theirs hours after their scenes were
  // created, 2026-09), and keying the recompute off the prompt TEXT would
  // leave those scenes' substitutions stale too, with nothing left to
  // explain why the render still looked wrong.
  // KLING NEVER SUBSTITUTES — same reasoning as generateClip's own
  // submittedPrompt, and it has to hold on THIS path too: this recompute
  // runs on every Regenerate regardless of whether the prompt text changed,
  // so a Kling scene left alone would otherwise pick up a substitution the
  // very next time an element's description was edited.
  const submittedPrompt = isKlingNow ? prompt : await resolveElementTags(admin, user.id, prompt);
  const tooLong = promptTooLongForModel(effectiveRegenerateSettings.model, submittedPrompt);
  if (tooLong) return tooLong;
  // Same rule generateClip's insert follows for this column: null means
  // "identical to what was authored," so a scene whose @tags were edited or
  // deleted out stops carrying a stale substitution instead of keeping one
  // around with nothing left to name it.
  const nextAiGeneratedPrompt = submittedPrompt === prompt ? null : submittedPrompt;
  if (nextAiGeneratedPrompt !== (scene.ai_generated_prompt ?? null)) {
    updates.ai_generated_prompt = nextAiGeneratedPrompt;
  }

  if (Object.keys(updates).length > 0) {
    const { error } = await admin.from("scenes").update(updates).eq("id", scene.id);
    if (error) throw new Error(`Failed to save this clip's settings: ${error.message}`);
  }

  // "new" unless the operator explicitly chose otherwise in the confirm
  // step. The default is the non-destructive one on purpose — "update"
  // deletes the clip currently standing — and it is NOT remembered between
  // presses, so a destructive choice has to be made each time it is wanted.
  const versionMode = formData.get("versionMode") === "update" ? "update" : "new";
  // 'failed' -> retryScene (this route's own versionMode, honored per that
  // function's own doc comment); 'done' -> rerenderScene, unchanged. The
  // status branch above has already refused everything else, so this is
  // exhaustive.
  const result =
    scene.status === "failed"
      ? await retryScene(scene.id, undefined, versionMode)
      : await rerenderScene(scene.id, versionMode);
  revalidatePath(`/ugc/${scene.project_id}`);
  return result;
}

/**
 * Deletes a whole clip, versions and all.
 *
 * Its own action rather than actions/brief.ts's deleteScene, which refuses
 * anything past 'frame_ready' — "delete is only available before a clip
 * exists" — and is right to on the scripted pipeline, where scenes are an
 * ordered cut and removing a rendered one changes the film. A clip project is
 * not that: it is a bag of independent clips an operator assembles elsewhere,
 * and deleting a bad one is housekeeping rather than an edit to a sequence.
 *
 * What the delete takes with it, checked against the schema rather than
 * assumed:
 *
 *   assets          ON DELETE CASCADE  — the clip and poster rows go
 *   scene_versions  ON DELETE CASCADE  — every attempt goes
 *   runs            ON DELETE SET NULL — the SPEND RECORD SURVIVES
 *
 * That last one is why this is safe to offer. runs keeps project_id and
 * cost_usd, so deleting a clip does not rewrite what the account was billed;
 * it only detaches those rows from a scene that no longer exists. A cascade
 * there would have made the delete button a way to make spending disappear.
 *
 * Storage objects are left, as everywhere else here (see deleteClipVersion).
 */
export async function deleteClipScene(formData: FormData): Promise<ActionResult> {
  const sceneId = String(formData.get("sceneId") ?? "");
  if (!sceneId) return { error: "No scene to delete." };

  const { scene } = await requireScene(sceneId);

  // A render in flight is the one state worth refusing. The worker has the
  // row, and deleting it mid-flight leaves a submitted job whose result
  // arrives to nothing — the cost is already committed either way, so the
  // honest move is to wait for it to land and then delete.
  if (scene.status === "queued" || scene.status === "rendering") {
    return {
      error: "This clip is still rendering. Wait for it to finish or fail, then delete it.",
    };
  }

  const admin = createAdminClient();
  // Preserve the prompt on the scene's runs before ON DELETE SET NULL clears
  // runs.scene_id, so the attempt stays readable in Runs even after the scene
  // (and its Bin entry) is gone.
  if (scene.video_prompt) {
    const { error: promptError } = await admin
      .from("runs")
      .update({ prompt: scene.video_prompt })
      .eq("scene_id", scene.id)
      .is("prompt", null);
    if (promptError) {
      console.error(`deleteClipScene: prompt not recorded for scene ${scene.id}`, promptError);
    }
  }
  const { error } = await admin.from("scenes").delete().eq("id", scene.id);
  if (error) throw new Error(`Failed to delete the clip: ${error.message}`);

  revalidatePath(`/ugc/${scene.project_id}`);
  revalidatePath("/create");
  revalidatePath("/bin");
  return undefined;
}

/**
 * Undoes deleteClipScene (or a project delete that cascaded to it): re-inserts
 * a scene and its assets/scene_versions/scene_references from the snapshot
 * 0088_deleted_scenes.sql's BEFORE DELETE trigger wrote one step ahead of the
 * cascade, then removes the trash entry so nothing can restore it twice.
 *
 * GUARD: requireProject, not requireScene — the scene is gone from `scenes`
 * (that is the entire reason it has a row here), so there is nothing for
 * requireScene to look up by id. Anchoring on deleted_scenes.project_id
 * instead runs the exact same strict, owner-only, admin-excluded check
 * deleteClipScene gets via requireScene->requireProject, and it also proves
 * the one thing a restore additionally needs: a live project to attach the
 * restored row to. A project-cascade delete's archived rows (user_id
 * snapshotted NULL, per 0088's header) can never reach this far anyway —
 * their own project no longer exists, so requireProject 404s before ownership
 * is even asked.
 *
 * ORDER: scene, then assets, then scene_versions, then scene_references —
 * the dependency order 0088's own trigger reads them in, reversed. Reused
 * rather than remapped: nothing in the live schema still points at any of
 * these ids (runs.scene_id was already nulled by 0054 when the scene died,
 * and everything else here was deleted alongside it), so re-inserting the
 * SAME ids the snapshot carries is both simpler and more honest than handing
 * the restored rows new ones — this is the same clip and version history,
 * not a new one wearing the old prompt.
 *
 * TWO COLUMNS HAVE TO BE PATCHED IN AFTERWARDS, not set on the first insert:
 * scenes.ref_frame_asset_id (assets(id)) and scenes.active_version_id
 * (scene_versions(id), 0058) both point at rows that do not exist yet the
 * moment the scene itself is inserted, and neither FK is declared
 * DEFERRABLE — 0001_init.sql adds the first one after the fact for exactly
 * this circularity, and 0058 does the same for the second. Insert the scene
 * with both null, insert its children, then UPDATE the two columns back in.
 *
 * THE TRASH ENTRY IS CLAIMED, NOT MERELY READ — this closes a real,
 * reproduced bug. The read used to be the ONLY check: two overlapping
 * restores of the same trash entry (two tabs, or one stale page pressed
 * twice — no unlucky timing required, since the second press starts before
 * this page's own revalidatePath has repainted the trash list) both passed
 * it, both reached the inserts below, and reusing the ORIGINAL scene id
 * (see ORDER above) meant the loser's insert failed on `scenes`' own
 * primary key. Its catch then "compensated" by deleting THAT scene_id —
 * which by then was the WINNER's live, fully-inserted scene, not the
 * loser's own failed one; the catch has no way to tell the two apart, since
 * both attempts share the same id by construction. Net effect: the scene,
 * every version, and the only snapshot of it all gone, while the winning
 * tab still reported success.
 *
 * The fix is `delete from deleted_scenes where scene_id = ? returning *`,
 * run through the ADMIN client, immediately after requireProject and before
 * a single `scenes` row is touched. A row-level delete is atomic, so of two
 * overlapping restores exactly one gets `claimed` back and the other gets
 * null — the loser exits immediately with "already restored" and never
 * reaches an insert at all, which removes the whole class above rather
 * than narrowing its window. This is a SECOND read of the same row, not a
 * replacement for the session-client read above it: that first read still
 * has to run first, and still has to go through the session client, for
 * the RLS reason its own comment gives — the claim below only runs once
 * requireProject has already confirmed ownership.
 *
 * NOT WRAPPED IN A DATABASE TRANSACTION, but a partial failure across the
 * scene/assets/versions/refs/patch sequence is still recoverable, unlike a
 * partial failure in this file's own generateClip: that function creates a
 * FRESH id every call, so a failed attempt is naturally retryable on its
 * own, while this reuses the ORIGINAL id (see ORDER above) — a scene left
 * half-restored would otherwise make every later Restore attempt on this
 * same trash entry fail on a duplicate key, forever. Recovering it is two
 * steps now, not one, and the ORDER between them is load-bearing: the claim
 * above already deleted the archive row, so the catch must put `claimed`
 * BACK FIRST and only THEN delete the scene this attempt partially wrote.
 * Reversed, the `scenes` delete would fire archive_deleted_scene() (0088)
 * while deleted_scenes still had no row for this scene_id, so its `on
 * conflict (scene_id) do nothing` would have nothing to conflict WITH — it
 * would insert a fresh candidate built from whatever partial, possibly
 * half-written state this catch is cleaning up, permanently replacing the
 * correct original snapshot with a worse one. Re-inserting the original
 * first means that same trigger fires into an occupied seat and discards
 * its own candidate instead, exactly as it always has (see the catch's own
 * comment below for the rest of this argument).
 *
 * RULE 3 — deleting the trash entry once every insert had succeeded — is
 * gone. The claim above already deleted it, atomically, before a single
 * `scenes` row existed; a second delete at the end would either be a
 * harmless no-op (the common case) or, worse, quietly cover for a claim
 * that somehow ran twice.
 *
 * DOES NOT TOUCH runs. 0088's header is explicit that runs.scene_id stays
 * NULL forever once a scene dies — re-linking it here would be rewriting the
 * one ledger 0040's spend unions depend on never double-counting. A restored
 * scene's render history before the delete is simply gone from its own
 * page; the money it cost is still exactly and only in runs, same as always.
 */
export async function restoreScene(formData: FormData): Promise<ActionResult> {
  const sceneId = String(formData.get("sceneId") ?? "");
  if (!sceneId) return { error: "No scene to restore." };

  // THE SESSION CLIENT, NOT THE ADMIN ONE, FOR THIS FIRST READ. guard.ts's own
  // header is explicit that every one of its guards "MUST run — and pass —
  // before any createAdminClient() call in a Server Action", because the
  // admin client bypasses RLS entirely. There is no scenes row left to run
  // requireScene against (that is the whole reason this scene has a row
  // here), so deleted_scenes_select's own RLS (`user_id = auth.uid() or
  // is_admin()`, 0088) is what has to stand in for it — a stranger gets
  // `archived: null` back from THIS read, same as requireProject's own
  // "row missing or not yours reads identical" philosophy, without ever
  // reaching an admin client that could hand them someone else's snapshot.
  const supabase = await createClient();
  const { data: archived, error: archivedError } = await supabase
    .from("deleted_scenes")
    .select("*")
    .eq("scene_id", sceneId)
    .maybeSingle();
  if (archivedError) throw new Error(`Failed to read the trash entry: ${archivedError.message}`);
  if (!archived) return { error: "That scene is not in the trash." };

  // Defensive, not reachable in practice: OLD.project_id is scenes.project_id
  // (0001_init.sql, `not null`), so the trigger that wrote this row always
  // had a real project id to snapshot. deleted_scenes.project_id is only
  // nullable in the schema because the table carries no foreign keys at all
  // (0088's own reasoning) — narrowing here is for TypeScript, not for a case
  // this data can actually be in.
  if (!archived.project_id) {
    throw new Error(`Archived scene ${sceneId} has no project_id — this should never happen.`);
  }

  // requireProject over requireScene — see this function's own doc comment
  // above for why. RLS above already refuses a plain stranger; this is what
  // additionally refuses an ADMIN who isn't the owner (RLS's `is_admin()`
  // clause would otherwise have let the read above through) — the same
  // owner-only, admin-excluded check deleteClipScene gets via
  // requireScene->requireProject, via the same notFound().
  const { project } = await requireProject(archived.project_id);

  if (typeof archived.deleted_at === "string" && isBinEntryExpired(archived.deleted_at)) {
    return { error: "That scene has expired from the bin after 2 weeks." };
  }

  const admin = createAdminClient();

  // THE CLAIM. Ownership is proven; from here on every read/write goes
  // through the admin client. This delete is what makes "whoever gets the
  // row owns the restore" true — see this function's own doc comment for
  // the interleaving it closes, and why it has to run before ANY `scenes`
  // write, not just before the ones immediately below.
  // `.is("hard_deleted_at", null)` (0092): a scene an editor has already
  // PURGED from the bin must not be claimable back by this same delete —
  // without it, this claim would happily delete-and-return a row
  // purgeDeletedScene had marked forgotten, restoring a scene the editor
  // deliberately said to stop keeping.
  const { data: claimed, error: claimError } = await admin
    .from("deleted_scenes")
    .delete()
    .eq("scene_id", sceneId)
    .is("hard_deleted_at", null)
    .select("*")
    .maybeSingle();
  if (claimError) throw new Error(`Failed to claim the trash entry: ${claimError.message}`);
  if (!claimed) {
    // Two different things land here and they are not the same news, so the
    // message has to tell them apart. Either another restore of this SAME
    // entry won the race (another tab, or a second press before this page's
    // own revalidatePath repainted the trash list), or the entry was purged
    // and the `.is()` above declined to claim it. Telling someone their
    // scene "has already been restored" when it was in fact permanently
    // removed sends them hunting for a scene that is not coming back.
    // Nothing was inserted by THIS call either way, so there is nothing to
    // undo — it simply refuses, same shape as every other guard failure here.
    const { data: purged } = await admin
      .from("deleted_scenes")
      .select("hard_deleted_at")
      .eq("scene_id", sceneId)
      .maybeSingle();
    if (purged?.hard_deleted_at) {
      return { error: "That scene was permanently removed from the bin." };
    }
    return { error: "That scene has already been restored." };
  }

  // Trusted cast, not a Zod parse: this jsonb was written by
  // archive_deleted_scene() (0088) as to_jsonb(OLD)/jsonb_agg(to_jsonb(...))
  // of our OWN rows a moment before they were deleted, never from outside
  // input — same reasoning types/db.ts's header gives for typing this column
  // `unknown` rather than `Json` in the first place.
  //
  // Sourced from `claimed` (this call's own atomic delete...returning), not
  // `archived` (the plain read above) — the two name the same row in the
  // ordinary case, but `claimed` is the one guaranteed not to have been
  // raced out from under this call between the two reads.
  const archivedScene = claimed.scene as Database["public"]["Tables"]["scenes"]["Row"];
  const archivedAssets = (claimed.assets ?? []) as Database["public"]["Tables"]["assets"]["Row"][];
  const archivedVersions = (claimed.versions ??
    []) as Database["public"]["Tables"]["scene_versions"]["Row"][];
  const archivedRefs = (claimed.refs ??
    []) as Database["public"]["Tables"]["scene_references"]["Row"][];

  // RULE 1: the scene comes back at the end, not its old slot. scenes has
  // `unique (project_id, idx)` and both consoles repack indices after a
  // delete, so the archived idx is very likely taken by now. Same max+1 rule
  // generateClip already uses above (search this file for "has `unique
  // (project_id, idx)`") — max over the project's LIVE scenes, never the
  // snapshot's own idx.
  const { data: last, error: idxError } = await admin
    .from("scenes")
    .select("idx")
    .eq("project_id", project.id)
    .order("idx", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (idxError) throw new Error(`Failed to read the last scene index: ${idxError.message}`);
  const idx = (last?.idx ?? 0) + 1;

  // RULE 2: never restore as queued/rendering. Neither delete action can
  // archive a scene in either state — deleteClipScene (above) refuses them
  // outright, and rerenderScene's own guard requires 'done' — so this branch
  // should be unreachable through the app's own UI. It stays as a hard clamp
  // anyway, because it is the ONLY path by which restoring a scene could get
  // it picked up by ClaimQueuedScenes (worker/internal/store/store.go) and
  // spend real money on a render nobody just asked for. 'failed' is the
  // nearest sane terminal status: 'draft' would misrepresent a scene that
  // already has a frame and a prompt, 'frame_ready' would let regenerateClip
  // queue it straight back with no operator review, and 'failed' is the one
  // status that drops the operator directly onto retryScene's own recovery
  // path (actions/enqueue.ts, requires status 'failed') with nothing silently
  // resumed on their behalf.
  const status: SceneStatus =
    archivedScene.status === "queued" || archivedScene.status === "rendering"
      ? "failed"
      : archivedScene.status;

  const sceneInsert: Database["public"]["Tables"]["scenes"]["Insert"] = {
    ...archivedScene,
    idx,
    status,
    // Nulled here, patched back in below once the rows they point at exist
    // again — see this function's own doc comment on why neither FK can be
    // set on this first insert.
    ref_frame_asset_id: null,
    active_version_id: null,
  };

  // WRAPPED, because a failure partway through — scene inserted, then
  // assets/versions/refs/patch does not all land — has to be recoverable.
  // See this function's own doc comment on why: reusing the ORIGINAL scene
  // id (unlike generateClip's always-fresh one) means a half-restored scene
  // left behind here would make every later Restore on this same trash
  // entry fail on a duplicate key, forever.
  try {
    const { data: restoredScene, error: sceneInsertError } = await admin
      .from("scenes")
      .insert(sceneInsert)
      .select("id")
      .single();
    if (sceneInsertError || !restoredScene) {
      throw new Error(`Failed to restore the scene: ${sceneInsertError?.message ?? "no row"}`);
    }

    if (archivedAssets.length > 0) {
      const { error: assetsError } = await admin.from("assets").insert(archivedAssets);
      if (assetsError) {
        throw new Error(`Failed to restore the scene's assets: ${assetsError.message}`);
      }
    }

    if (archivedVersions.length > 0) {
      const { error: versionsError } = await admin.from("scene_versions").insert(archivedVersions);
      if (versionsError) {
        throw new Error(`Failed to restore the scene's versions: ${versionsError.message}`);
      }
    }

    if (archivedRefs.length > 0) {
      const { error: refsError } = await admin.from("scene_references").insert(archivedRefs);
      if (refsError) {
        throw new Error(`Failed to restore the scene's references: ${refsError.message}`);
      }
    }

    // The two columns nulled out above, now that what they point at exists
    // again. A no-op update (both still null in the snapshot) is skipped
    // rather than sent — a scene never framed, or never rendered, has
    // nothing to relink.
    if (archivedScene.ref_frame_asset_id || archivedScene.active_version_id) {
      const { error: patchError } = await admin
        .from("scenes")
        .update({
          ref_frame_asset_id: archivedScene.ref_frame_asset_id,
          active_version_id: archivedScene.active_version_id,
        })
        .eq("id", restoredScene.id);
      if (patchError) throw new Error(`Failed to relink the restored scene: ${patchError.message}`);
    }
  } catch (err) {
    // COMPENSATE, THEN RETHROW — and in THIS order. The claim above already
    // deleted the archive row, so unlike before this fixing, deleted_scenes
    // has no row for this scene_id right now. Putting `claimed` back FIRST
    // matters: if the `scenes` delete below ran first instead, it would
    // fire archive_deleted_scene() (0088) while deleted_scenes was still
    // empty for this id, and its `on conflict (scene_id) do nothing` would
    // have nothing to conflict with — it would insert a FRESH candidate
    // built from whatever partial, possibly half-written state this catch
    // is cleaning up, permanently replacing the correct original snapshot
    // with a worse one.
    const { error: reinsertError } = await admin.from("deleted_scenes").insert(claimed);
    if (reinsertError) {
      // Logged, not thrown, for the same reason the compensating delete's
      // own error below is logged rather than thrown: the ORIGINAL error is
      // what the operator needs to see and retry on. A failed reinsert here
      // is a second, independent problem — the archive row for this scene
      // may now be gone for good — worth finding, not worth hiding the real
      // failure behind.
      console.error(
        `restoreScene: reinserting the trash entry for scene ${sceneId} failed after a restore error: ${reinsertError.message}`,
      );
    }

    // Deletes the scene this attempt just (partially) inserted, keyed on
    // `sceneId` rather than a row returned from the insert above — that
    // insert may itself be what failed, in which case there is nothing to
    // delete and this is a harmless no-op (zero rows matched, no error).
    //
    // Safe again now that `claimed` has been put back above: this delete
    // fires archive_deleted_scene() (0088) for this same scene_id, finds
    // deleted_scenes already occupied by the reinserted original, and its
    // `on conflict (scene_id) do nothing` discards the trigger's own fresh
    // candidate — the reinserted original snapshot is what survives. Net
    // effect: after this compensating delete, the world looks exactly like
    // the failed restore never started, and the next Restore press reads
    // that same, still-intact archive row and starts clean.
    const { error: compensateError } = await admin.from("scenes").delete().eq("id", sceneId);
    if (compensateError) {
      // Logged, not thrown: the ORIGINAL error above is the one worth
      // surfacing to the operator and worth retrying on. Throwing this one
      // instead would hide it behind "the cleanup also failed", and the
      // caller would learn nothing about what actually went wrong. A failed
      // compensation does leave a half-restored scene behind — a second,
      // independent problem, logged here so it can be found, not silently
      // accepted.
      console.error(
        `restoreScene: compensating delete for scene ${sceneId} also failed after a restore error: ${compensateError.message}`,
      );
    }
    throw err;
  }

  revalidatePath(`/ugc/${project.id}`);
  revalidatePath("/bin");
  return undefined;
}

/**
 * Removes archived Storage objects that are no longer referenced by any live
 * `assets` row. Best-effort after the archive row itself has been deleted so
 * a missing Storage object never leaves a ghost row in /bin.
 */
async function removeUnreferencedArchivedAssets(
  admin: ReturnType<typeof createAdminClient>,
  candidateKeys: string[],
): Promise<void> {
  if (candidateKeys.length === 0) return;
  try {
    const { data: liveAssets } = await admin
      .from("assets")
      .select("storage_key")
      .in("storage_key", candidateKeys);
    const liveKeySet = new Set((liveAssets ?? []).map((row) => row.storage_key));
    const keysToRemove = candidateKeys.filter((key) => !liveKeySet.has(key));
    if (keysToRemove.length > 0) {
      await removeStorageObjects(keysToRemove);
    }
  } catch (cleanupError) {
    console.error("Could not clean up purged bin storage objects", cleanupError);
  }
}

/**
 * Hard-deletes any `deleted_scenes` and `deleted_scene_versions` rows that
 * have passed the 2-week (14-day) bin retention window (or were previously
 * soft-marked with `hard_deleted_at`), along with their unreferenced Storage
 * objects.
 */
export async function reapExpiredBinEntries(): Promise<void> {
  await requireUser();
  const admin = createAdminClient();
  const cutoffIso = binRetentionCutoffIso();

  try {
    const [
      { data: expiredScenes },
      { data: legacyPurgedScenes },
      { data: expiredVersions },
      { data: legacyPurgedVersions },
    ] = await Promise.all([
      admin.from("deleted_scenes").delete().lt("deleted_at", cutoffIso).select("assets"),
      admin.from("deleted_scenes").delete().not("hard_deleted_at", "is", null).select("assets"),
      admin
        .from("deleted_scene_versions")
        .delete()
        .lt("deleted_at", cutoffIso)
        .select("clip_asset"),
      admin
        .from("deleted_scene_versions")
        .delete()
        .not("hard_deleted_at", "is", null)
        .select("clip_asset"),
    ]);

    const keys = new Set<string>();
    for (const row of [...(expiredScenes ?? []), ...(legacyPurgedScenes ?? [])]) {
      for (const key of extractArchivedStorageKeys(row.assets)) {
        keys.add(key);
      }
    }
    for (const row of [...(expiredVersions ?? []), ...(legacyPurgedVersions ?? [])]) {
      for (const key of extractArchivedStorageKeys(undefined, row.clip_asset)) {
        keys.add(key);
      }
    }
    await removeUnreferencedArchivedAssets(admin, Array.from(keys));
  } catch (reapError) {
    console.error("reapExpiredBinEntries: failed to reap expired bin rows", reapError);
  }
}

/**
 * Permanently deletes one scene entry from the bin, including its archived
 * Storage objects.
 *
 * GUARD: requireAdmin — regular users can only restore scenes during the
 * 2-week retention window so that admins can review deleted work in /bin.
 * Only an admin may permanently delete a bin entry before the 2 weeks elapse.
 */
export async function purgeDeletedScene(formData: FormData): Promise<ActionResult> {
  const sceneId = String(formData.get("sceneId") ?? "");
  if (!sceneId) return { error: "No scene to remove." };

  await requireAdmin();

  const admin = createAdminClient();
  const { data: purged, error } = await admin
    .from("deleted_scenes")
    .delete()
    .eq("scene_id", sceneId)
    .select("scene_id, project_id, assets")
    .maybeSingle();
  if (error) throw new Error(`Failed to remove the trash entry: ${error.message}`);
  if (!purged) return { error: "That's already been removed." };

  await removeUnreferencedArchivedAssets(admin, extractArchivedStorageKeys(purged.assets));

  revalidatePath("/bin");
  revalidatePath("/accounts-control");
  if (purged.project_id) {
    revalidatePath(`/ugc/${purged.project_id}`);
  }
  return undefined;
}

/**
 * Deletes one attempt at a scene.
 *
 * Refuses two cases outright rather than guessing at what was meant:
 *
 *   - The CURRENT version. Deleting what the scene resolves to would leave it
 *     pointing at nothing, and the alternative — silently promoting some other
 *     take — decides for the operator which one replaces it. Clicking another
 *     version is one click and says so explicitly.
 *   - The LAST version. A scene with no attempts is a row that says 'done'
 *     with nothing behind it, which reads as a bug wherever it is next shown.
 *
 * The clip's storage OBJECT is deliberately left in place, matching what
 * "update this version" already does (actions/enqueue.ts deletes the asset row
 * and nothing else). It matters more than it looks: every render before the
 * per-attempt key landed shares one object with its siblings, so deleting the
 * file for one version would blank the others. Removing the row is what makes
 * the version disappear; the bytes are cheap and orphaned safely.
 */
export async function deleteClipVersion(formData: FormData): Promise<ActionResult> {
  const sceneId = String(formData.get("sceneId") ?? "");
  const versionId = String(formData.get("versionId") ?? "");
  if (!sceneId || !versionId) return { error: "Missing scene or version." };

  const { scene } = await requireScene(sceneId);
  const admin = createAdminClient();

  // Scoped to the scene as well as the id, for the same reason
  // setActiveVersion is: a version id from another scene must not resolve.
  const { data: version, error: readError } = await admin
    .from("scene_versions")
    .select("id, clip_asset_id")
    .eq("id", versionId)
    .eq("scene_id", scene.id)
    .maybeSingle();
  if (readError) throw new Error(`Failed to read the version: ${readError.message}`);
  if (!version) return { error: "That version does not belong to this scene." };

  if (scene.active_version_id === version.id) {
    return {
      error: "That is the current version. Click another version to make it current first.",
    };
  }

  const { count, error: countError } = await admin
    .from("scene_versions")
    .select("id", { count: "exact", head: true })
    .eq("scene_id", scene.id);
  if (countError) throw new Error(`Failed to count versions: ${countError.message}`);
  if ((count ?? 0) <= 1) {
    return { error: "This is the scene's only version. Delete the scene instead." };
  }

  // ORDER MATTERS, and it is the reverse of how this used to read. The
  // version goes first, the clip asset second.
  //
  // scene_versions.clip_asset_id is `on delete set null` (0058), so deleting
  // the asset row first already nulls it out — before
  // archive_deleted_scene_version() (0092) ever runs. That trigger snapshots
  // the clip by reading `select to_jsonb(a) from assets a where a.id =
  // OLD.clip_asset_id`, so by the time it fired against an already-null
  // clip_asset_id it would find nothing to snapshot, and a version restored
  // from that archive row would have no clip — the exact bug this fixes.
  // Deleting the version FIRST lets its own BEFORE DELETE trigger read a
  // still-live clip_asset_id and snapshot the real asset row; the asset
  // itself is only removed second, once nothing needs to capture it.
  const { error: deleteError } = await admin.from("scene_versions").delete().eq("id", version.id);
  if (deleteError) throw new Error(`Failed to delete the version: ${deleteError.message}`);

  if (version.clip_asset_id) {
    const { error } = await admin.from("assets").delete().eq("id", version.clip_asset_id);
    if (error) throw new Error(`Failed to delete the clip: ${error.message}`);
  }

  revalidatePath(`/ugc/${scene.project_id}`);
  revalidatePath("/bin");
  return undefined;
}

/**
 * Undoes deleteClipVersion: re-inserts a scene_versions row (and its clip
 * asset, if it had one) from the snapshot 0092's BEFORE DELETE trigger wrote
 * one step ahead of the delete, then removes the trash entry so nothing can
 * restore it twice. restoreScene's own doc comment is the long version of
 * every argument below; this one only calls out where a VERSION's restore
 * differs from a SCENE's.
 *
 * GUARD: requireProject, not requireScene — same reason restoreScene gives:
 * the version is gone from `scene_versions` (that is the entire reason it
 * has a row here), so there is nothing for requireScene to look up by id.
 * Anchoring on deleted_scene_versions.project_id runs the identical strict,
 * owner-only, admin-excluded check, read via the SESSION client first
 * (RLS stands in for the missing live row), then requireProject for the
 * admin-excluding half.
 *
 * REFUSES UP FRONT, BEFORE THE CLAIM, if the parent scene is not currently
 * live. scene_versions.scene_id is `not null references scenes(id) on
 * delete cascade` (0058) — an insert naming a scene that no longer exists
 * is a foreign key violation, not a graceful refusal, and the honest
 * message is "restore the scene first," not a database error. This scene
 * is exactly answerable from `archived.scene_id` before anything is
 * claimed, so checking it here (rather than after the claim, as a
 * compensate-and-refuse) means the ordinary case — a version whose scene
 * was ALSO later deleted — never touches the archive row at all. The rare
 * race (scene deleted in the instant between this check and the insert
 * below) still ends up correct: the insert fails on the same FK, and the
 * try/catch below compensates exactly as it would for any other failure.
 *
 * RENUMBERS on restore, and this is the one genuinely new piece of
 * bookkeeping a version's restore needs that a scene's does not. `n` is
 * assigned by openSceneVersion (actions/enqueue.ts) as max(n over this
 * scene's LIVE versions)+1 at the moment a version opens, and scene_versions
 * enforces `unique (scene_id, n)` (0058). Time did not stop while this
 * version sat in the bin — a newer version, numbered past it, may already
 * occupy the archived `n` — so restoring under the OLD number blind ships a
 * unique-violation crash the instant that slot is taken. The archived `n` is
 * not lost; it survives untouched inside the snapshot (`claimed.version.n`)
 * for display. Only the LIVE row this call inserts gets a fresh number.
 *
 * clip_asset BEFORE the version, the opposite order from a delete: the
 * version's own `clip_asset_id` FK has to resolve by the time that row
 * lands, so whatever it pointed at must exist again first. Reused, not
 * re-minted — `claimed.clip_asset` is `to_jsonb(a) where a.id =
 * OLD.clip_asset_id`, so it already carries the asset's original id, and
 * `archivedVersion.clip_asset_id` already names that same id. No relinking
 * step is needed the way restoreScene needs one for ref_frame_asset_id: this
 * version's OWN ref_frame_asset_id was never touched by deleteClipVersion
 * (which only ever deletes a version's CLIP asset — see that function's own
 * comment), so the frame it pointed at was never gone in the first place.
 *
 * COMPENSATION mirrors restoreScene's own, in the same order and for the
 * identical reason: putting `claimed` back into deleted_scene_versions
 * FIRST means that if the compensating `scene_versions` delete below fires
 * archive_deleted_scene_version() (0092) again, that trigger's own
 * `on conflict (version_id) do nothing` finds the seat already occupied by
 * the real snapshot and discards its fresh candidate instead of overwriting
 * it with a partial one. The compensating deletes are themselves ordered
 * version-then-asset, the same order deleteClipVersion's own fix above
 * uses and for the same reason: while the version row still exists, its
 * clip_asset_id is still live, so if that no-op archive attempt fires, it
 * has a real asset to (uselessly, thanks to the conflict) look at rather
 * than one already nulled by the asset's own `on delete set null`.
 */
export async function restoreClipVersion(formData: FormData): Promise<ActionResult> {
  const versionId = String(formData.get("versionId") ?? "");
  if (!versionId) return { error: "No version to restore." };

  const supabase = await createClient();
  const { data: archived, error: archivedError } = await supabase
    .from("deleted_scene_versions")
    .select("*")
    .eq("version_id", versionId)
    .maybeSingle();
  if (archivedError) throw new Error(`Failed to read the trash entry: ${archivedError.message}`);
  if (!archived) return { error: "That version is not in the trash." };

  // Defensive, not reachable in practice — same reasoning as restoreScene's
  // identical checks: the trigger that wrote this row only ever runs while
  // OLD.scene_id (not-null, 0058) and its live project both resolve (see
  // 0092's header — the early-return skips archiving altogether otherwise),
  // so both columns are only nullable here because the table carries no FK,
  // not because this data can actually be in that state.
  if (!archived.scene_id) {
    throw new Error(`Archived version ${versionId} has no scene_id — this should never happen.`);
  }
  if (!archived.project_id) {
    throw new Error(`Archived version ${versionId} has no project_id — this should never happen.`);
  }

  const { project } = await requireProject(archived.project_id);

  if (typeof archived.deleted_at === "string" && isBinEntryExpired(archived.deleted_at)) {
    return { error: "That version has expired from the bin after 2 weeks." };
  }

  const admin = createAdminClient();

  // THE ORPHAN CHECK — see this function's own doc comment for why this
  // runs before the claim rather than after it.
  const { data: liveScene, error: sceneCheckError } = await admin
    .from("scenes")
    .select("id")
    .eq("id", archived.scene_id)
    .maybeSingle();
  if (sceneCheckError) {
    throw new Error(`Failed to check the clip's scene: ${sceneCheckError.message}`);
  }
  if (!liveScene) {
    return { error: "That clip's scene is in the bin. Restore the scene first." };
  }

  // THE CLAIM. `.is("hard_deleted_at", null)` (0092) so a version an editor
  // already purged from the bin cannot be claimed back by this same delete.
  const { data: claimed, error: claimError } = await admin
    .from("deleted_scene_versions")
    .delete()
    .eq("version_id", versionId)
    .is("hard_deleted_at", null)
    .select("*")
    .maybeSingle();
  if (claimError) throw new Error(`Failed to claim the trash entry: ${claimError.message}`);
  if (!claimed) {
    // Lost the race, or purged out from under this call — the claim cannot
    // tell them apart on its own, but the editor needs to know which. See
    // restoreScene for the same read and the same reasoning. Nothing was
    // inserted by THIS call either way, so there is nothing to undo.
    const { data: purged } = await admin
      .from("deleted_scene_versions")
      .select("hard_deleted_at")
      .eq("version_id", versionId)
      .maybeSingle();
    if (purged?.hard_deleted_at) {
      return { error: "That version was permanently removed from the bin." };
    }
    return { error: "That version has already been restored." };
  }

  // Trusted casts, not a Zod parse — same reasoning restoreScene's own
  // identical casts give: this jsonb was written by
  // archive_deleted_scene_version() (0092) as to_jsonb(OLD)/to_jsonb(a) of
  // our OWN rows a moment before they were deleted, never from outside
  // input.
  const archivedVersion = claimed.version as Database["public"]["Tables"]["scene_versions"]["Row"];
  const archivedClipAsset = claimed.clip_asset as
    Database["public"]["Tables"]["assets"]["Row"] | null;

  // Reading max(n) and inserting n+1 is not atomic, exactly as
  // openSceneVersion's own numbering is not. Two restores of two DIFFERENT
  // versions of the SAME scene can therefore both compute the same n and
  // collide on `unique (scene_id, n)`. Rare, and the loser loses nothing —
  // but until now it was reachable from a Restore click, and a raw Postgres
  // constraint string is not something to put in front of an editor.
  let raceRefusal: string | null = null;

  try {
    // RENUMBER — see this function's own doc comment.
    const { data: latest, error: latestError } = await admin
      .from("scene_versions")
      .select("n")
      .eq("scene_id", archived.scene_id)
      .order("n", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestError) {
      throw new Error(`Failed to read the scene's version numbers: ${latestError.message}`);
    }
    const n = (latest?.n ?? 0) + 1;

    // Clip asset before the version — see this function's own doc comment
    // for why the order is the reverse of a delete's.
    if (archivedClipAsset) {
      const { error: assetError } = await admin.from("assets").insert(archivedClipAsset);
      if (assetError) throw new Error(`Failed to restore the clip: ${assetError.message}`);
    }

    // The rest of the row comes back exactly as archived — same id, same
    // scene_id, same prompt/frame/settings/duration/created_at — only `n`
    // is fresh.
    const { error: versionError } = await admin
      .from("scene_versions")
      .insert({ ...archivedVersion, n });
    if (versionError) {
      if (versionError.code === "23505") {
        raceRefusal = "Another version was restored at the same moment. Try again.";
      }
      throw new Error(`Failed to restore the version: ${versionError.message}`);
    }
  } catch (err) {
    // COMPENSATE, THEN RETHROW, in this order — see this function's own doc
    // comment for why.
    const { error: reinsertError } = await admin.from("deleted_scene_versions").insert(claimed);
    if (reinsertError) {
      console.error(
        `restoreClipVersion: reinserting the trash entry for version ${versionId} failed after a restore error: ${reinsertError.message}`,
      );
    }

    const { error: versionCompensateError } = await admin
      .from("scene_versions")
      .delete()
      .eq("id", versionId);
    if (versionCompensateError) {
      console.error(
        `restoreClipVersion: compensating delete of version ${versionId} also failed after a restore error: ${versionCompensateError.message}`,
      );
    }

    if (archivedClipAsset) {
      const { error: assetCompensateError } = await admin
        .from("assets")
        .delete()
        .eq("id", archivedClipAsset.id);
      if (assetCompensateError) {
        console.error(
          `restoreClipVersion: compensating delete of clip asset ${archivedClipAsset.id} also failed after a restore error: ${assetCompensateError.message}`,
        );
      }
    }

    // Compensation has run either way; only the message differs. A numbering
    // collision is a retry, not a fault, so it refuses in words instead of
    // throwing a constraint name at the editor.
    if (raceRefusal) return { error: raceRefusal };

    throw err;
  }

  revalidatePath(`/ugc/${project.id}`);
  revalidatePath("/bin");
  return undefined;
}

/**
 * purgeDeletedScene's twin for a single version's bin entry — permanently
 * deletes the row from deleted_scene_versions and cleans up its unreferenced
 * clip object in Storage. Guarded by requireAdmin so only admins can
 * permanently delete before the 2-week retention window expires.
 */
export async function purgeDeletedVersion(formData: FormData): Promise<ActionResult> {
  const versionId = String(formData.get("versionId") ?? "");
  if (!versionId) return { error: "No version to remove." };

  await requireAdmin();

  const admin = createAdminClient();
  const { data: purged, error } = await admin
    .from("deleted_scene_versions")
    .delete()
    .eq("version_id", versionId)
    .select("version_id, project_id, clip_asset")
    .maybeSingle();
  if (error) throw new Error(`Failed to remove the trash entry: ${error.message}`);
  if (!purged) return { error: "That's already been removed." };

  await removeUnreferencedArchivedAssets(
    admin,
    extractArchivedStorageKeys(undefined, purged.clip_asset),
  );

  revalidatePath("/bin");
  revalidatePath("/accounts-control");
  if (purged.project_id) {
    revalidatePath(`/ugc/${purged.project_id}`);
  }
  return undefined;
}

// retryClip — the failed-scene-only requeue this route used to expose as
// "Try again" on the result panel's failure state — is GONE. It called
// retryScene directly (no settings write of its own) because a failed scene
// used to be something ONLY it could act on: regenerateClip's own guard
// refused anything that was not 'done'. That refusal read as developer-speak
// to an editor ("Scene is failed, not done — ... Use retryScene for a failed
// scene") and, worse, ignored whatever frames/prompt/model the operator had
// just changed in the column — the "Try again" press re-ran the SAVED
// inputs, not what was on screen. regenerateClip's own status branch above
// now accepts 'failed' directly (see its doc comment), so Regenerate is the
// one requeue control this route has, for every status that can be requeued
// at all — and retryClip had no other caller left to keep it for.

/**
 * Makes one version the scene's current one.
 *
 * Separate from selecting a version to LOOK at, which changes nothing on the
 * server. Conflating the two is how a good take gets demoted by a click meant
 * only to inspect it — so this is its own explicit control, and the only
 * thing that writes active_version_id from this route.
 *
 * Spends nothing: it repoints a row at a clip that has already been paid for.
 */
export async function setActiveVersion(formData: FormData): Promise<ActionResult> {
  const sceneId = String(formData.get("sceneId") ?? "");
  const versionId = String(formData.get("versionId") ?? "");
  if (!sceneId || !versionId) return { error: "Missing scene or version." };

  const { scene } = await requireScene(sceneId);

  const admin = createAdminClient();
  // Scoped to the scene as well as the version id: a version id from another
  // scene would otherwise repoint this one at a clip that is not its own.
  const { data: version, error: readError } = await admin
    .from("scene_versions")
    .select("id")
    .eq("id", versionId)
    .eq("scene_id", scene.id)
    .maybeSingle();
  if (readError) throw new Error(`Failed to read the version: ${readError.message}`);
  if (!version) return { error: "That version does not belong to this scene." };

  const { error } = await admin
    .from("scenes")
    .update({ active_version_id: version.id })
    .eq("id", scene.id);
  if (error) throw new Error(`Failed to set the current version: ${error.message}`);

  revalidatePath(`/ugc/${scene.project_id}`);
  return undefined;
}

/**
 * What a clip project is called before anyone renames it.
 *
 * No dialog asks for a name at creation. Making someone name a thing before
 * they have made it is a stop at the wrong moment — the master guide this
 * route was built from names itself on its first line, after the work
 * exists, not before it.
 *
 * The cost is ten rows all reading the same thing, which is why the console
 * makes the title itself editable (components/ugc-title.tsx) rather than
 * leaving rename on the Settings page.
 */
const NEW_CLIP_PROJECT_TITLE = "New project";

/**
 * Starts a clip project and opens it.
 *
 * A POST rather than a link, because it WRITES. An earlier draft had /ugc
 * find-or-create a single project per user by matching the exact title
 * "UGC clips" — a weak key that also made one operator's scene strip their
 * entire history forever, with no way to keep two ads apart. A project per ad
 * is the shape the rest of this app already uses, and it brings requireProject
 * with it.
 *
 * redirect() throws, so this never returns on the happy path — any client
 * calling it needs unstable_rethrow, which ActionForm already does.
 */
/**
 * The caller's hidden personal clip project, made on first use (0117).
 *
 * /create's Video tab has no project step: every clip it queues goes into this
 * one, found by the is_personal marker and never by title. The partial unique
 * index makes a double first press safe — the loser's insert fails with 23505
 * and re-reads the winner's row.
 */
export async function ensurePersonalClipProject(): Promise<
  { projectId: string } | { error: string }
> {
  const { user } = await requireUser();
  const admin = createAdminClient();

  const find = async (): Promise<string | null> => {
    const { data } = await admin
      .from("projects")
      .select("id")
      .eq("user_id", user.id)
      .eq("is_personal", true)
      .maybeSingle();
    return data?.id ?? null;
  };

  const existing = await find();
  if (existing) return { projectId: existing };

  const { data: project, error } = await admin
    .from("projects")
    // kind: "clip" — see createClipProject below for why it is load-bearing.
    .insert({ user_id: user.id, title: "Create", kind: "clip", is_personal: true })
    .select("id")
    .single();
  if (project) return { projectId: project.id };
  if (error?.code === "23505") {
    const winner = await find();
    if (winner) return { projectId: winner };
  }
  return { error: "Could not start generating. Try again." };
}

export async function createClipProject(): Promise<never> {
  const { user } = await requireUser();

  const admin = createAdminClient();
  const { data: project, error } = await admin
    .from("projects")
    // kind: "clip" is load-bearing, not decoration. It is what routes this
    // project's title in the /projects table to the clip console rather than
    // the six-step wizard — the whole reason 0064_project_kind.sql exists.
    // Omitting it let the column default to 'scripted', so every project this
    // button created opened the wrong screen: the exact defect the migration
    // was written to close, reintroduced one insert later.
    .insert({ user_id: user.id, title: NEW_CLIP_PROJECT_TITLE, kind: "clip" })
    .select("id")
    .single();

  if (error || !project) {
    throw new Error(`Failed to start a clip project: ${error?.message ?? "no row"}`);
  }

  revalidatePath("/projects");
  redirect(`/ugc/${project.id}`);
}
