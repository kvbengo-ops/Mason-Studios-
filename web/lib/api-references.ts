import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { IMAGE_ASSET_KINDS } from "@/lib/asset-kinds";
import {
  ELEMENT_TAG,
  declareAudioTags,
  descriptionFor,
  substituteElementTags,
  tagLeadIsWordish,
  tagsInOrder,
} from "@/lib/element-tags";
import { KLING_FRAME_EXTS } from "@/lib/elements";
import { geminiOmniVideoInputPaid } from "@/lib/kie/rates";
import { getModel } from "@/lib/models";
import { supportsPromptOnlyVideo } from "@/lib/prompt-only-video";
import {
  buildStorageKey,
  copyStorageObject,
  extFromFilename,
  removeStorageObjects,
} from "@/lib/storage";
import { referenceLimitsFor } from "@/lib/ugc-references";
import type { AssetKind, Database, ElementCategory } from "@/types/db";

export interface ResolvedApiRef {
  elementId: string;
  name: string;
  category: ElementCategory;
  description: string | null;
  aiDescription: string | null;
  assetId: string;
  assetKind: AssetKind;
  storageKey: string;
  durationS: number | null;
  refKind: "image" | "video" | "audio";
  ordinal: number;
}

export interface ResolvedApiReferencesSuccess {
  ok: true;
  /** Prompt with positional `@Image k`/`@Video k`/`@Audio k` rewritten to `@<element.name>`. */
  rewrittenPrompt: string;
  /** Prompt with element descriptions expanded (stored in `scenes.video_prompt`). */
  submittedPrompt: string;
  /** Prompt showing how `@<element.name>` binds to `@image1`/`@video1`/`@audio1` in array order. */
  providerReferencePrompt: string;
  /** Primary reference (ordinal 1 of the first populated kind, preferring image -> video -> audio). */
  primaryRef: ResolvedApiRef | null;
  /** Explicit tag names in exact array order for `attachSceneReferences`. */
  explicitOrderedTags: string[];
  /** Ordered references per media kind (`ordinal = 1..N`). */
  orderedReferences: {
    images: ResolvedApiRef[];
    videos: ResolvedApiRef[];
    audios: ResolvedApiRef[];
  };
  /** Measured durations (seconds) of all attached video references in ordinal order. */
  videoReferenceDurationsS: number[];
}

export interface ResolvedApiReferencesError {
  ok: false;
  status: 403 | 422;
  code:
    | "forbidden_reference"
    | "invalid_reference"
    | "invalid_reference_kind"
    | "invalid_reference_index"
    | "unknown_reference_tag"
    | "too_many_references"
    | "missing_reference"
    | "invalid_media_file"
    | "prompt_too_long"
    | "invalid_parameters";
  error: string;
}

export type ResolveApiReferencesResult = ResolvedApiReferencesSuccess | ResolvedApiReferencesError;

export function providerReferencePromptFromScene(
  prompt: string,
  modelId: string,
  references: readonly { kind: string; ordinal: number; tag: string | null }[],
): string {
  if (getModel(modelId).nativeAudio) return prompt;
  const providerByTag = new Map<string, string>();
  const audioPrefix = modelId === "seedance-2-mini" ? "voice" : "audio";
  for (const ref of references) {
    if (!ref.tag) continue;
    const prefix = ref.kind === "image" ? "image" : ref.kind === "video" ? "video" : audioPrefix;
    providerByTag.set(ref.tag.toLowerCase(), `@${prefix}${ref.ordinal}`);
  }
  return prompt.replace(ELEMENT_TAG, (whole, name: string, at: number) => {
    if (tagLeadIsWordish(prompt, at)) return whole;
    return providerByTag.get(name.toLowerCase()) ?? whole;
  });
}

// Matches `@Image 1`, `@image1`, `@Video 2`, `@video2`, `@Audio 1`, `@audio1`, `@voice1`
const POSITIONAL_REF_PATTERN = /@(image|video|audio|voice)\s*(\d+)\b/gi;

function findDuplicates(ids: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (!id) continue;
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

function classifyRefKind(assetKind: AssetKind): "image" | "video" | "audio" | null {
  if (assetKind === "audio") return "audio";
  if (assetKind === "video_ref") return "video";
  if (IMAGE_ASSET_KINDS.has(assetKind)) return "image";
  return null;
}

function klingTagRefusalMessage(prompt: string): string | null {
  const tags = tagsInOrder(prompt);
  const posMatches: string[] = [];
  for (const m of prompt.matchAll(POSITIONAL_REF_PATTERN)) {
    const at = m.index ?? 0;
    if (tagLeadIsWordish(prompt, at)) continue;
    posMatches.push(m[0]);
  }
  const all = [...new Set([...posMatches, ...tags.map((t) => `@${t}`)])];
  if (all.length === 0) return null;
  const named = all.slice(0, 3).join(", ");
  const more = all.length > 3 ? ` +${all.length - 3} more` : "";
  return `Kling can't use @tags — remove ${named}${more} to generate.`;
}

/**
 * Validates and resolves API references (`image_refs`, `video_refs`, `audio_refs`,
 * positional `@Image k`/`@Video k`/`@Audio k` mentions, and native `@<element.name>` tags)
 * identically for `POST /api/v1/quote` and `POST /api/v1/generate`.
 */
export async function resolveApiReferences(args: {
  admin: SupabaseClient<Database>;
  userId: string;
  modelId: string;
  resolution: string;
  prompt: string;
  imageRefs?: readonly string[];
  videoRefs?: readonly string[];
  audioRefs?: readonly string[];
}): Promise<ResolveApiReferencesResult> {
  const {
    admin,
    userId,
    modelId,
    resolution,
    prompt,
    imageRefs = [],
    videoRefs = [],
    audioRefs = [],
  } = args;

  const model = getModel(modelId);

  // 1. Reject duplicate element IDs within any reference array.
  for (const [label, list] of [
    ["image_refs", imageRefs],
    ["video_refs", videoRefs],
    ["audio_refs", audioRefs],
  ] as const) {
    const dup = findDuplicates(list);
    if (dup) {
      return {
        ok: false,
        status: 422,
        code: "invalid_parameters",
        error: `Duplicate element ID "${dup}" in ${label}.`,
      };
    }
  }

  // 2. For Kling (start+end frame only, no @tags), reject any @tag in prompt up front.
  if (model.nativeAudio) {
    const klingRefusal = klingTagRefusalMessage(prompt);
    if (klingRefusal) {
      return {
        ok: false,
        status: 422,
        code: "invalid_parameters",
        error: klingRefusal,
      };
    }
  }

  // 3. Load all active elements owned by userId + their assets.
  const { data: userElements, error: elementsError } = await admin
    .from("elements")
    .select("id, user_id, name, category, description, ai_description, asset_id")
    .eq("user_id", userId)
    .is("deleted_at", null);

  if (elementsError) {
    throw new Error(`Failed to read user elements: ${elementsError.message}`);
  }

  const ownedElements = userElements ?? [];
  const ownedById = new Map(ownedElements.map((e) => [e.id, e]));
  const ownedByName = new Map(ownedElements.map((e) => [e.name.toLowerCase(), e]));

  // If any requested element ID is missing from ownedById, check whether it belongs to another user (403) vs non-existent (422).
  const allRequestedIds = [...imageRefs, ...videoRefs, ...audioRefs].map((id) => id.trim());
  const missingIds = allRequestedIds.filter((id) => !ownedById.has(id));
  if (missingIds.length > 0) {
    const firstMissing = missingIds[0]!;
    const { data: foreignRow } = await admin
      .from("elements")
      .select("id, user_id")
      .eq("id", firstMissing)
      .is("deleted_at", null)
      .maybeSingle();

    if (foreignRow && foreignRow.user_id !== userId) {
      return {
        ok: false,
        status: 403,
        code: "forbidden_reference",
        error: `Reference element "${firstMissing}" belongs to another account.`,
      };
    }
    return {
      ok: false,
      status: 422,
      code: "invalid_reference",
      error: `Reference element "${firstMissing}" was not found.`,
    };
  }

  // Load assets for all owned elements.
  const assetIds = [...new Set(ownedElements.map((e) => e.asset_id).filter(Boolean))];
  const { data: assetRows, error: assetsError } =
    assetIds.length > 0
      ? await admin.from("assets").select("id, kind, storage_key, duration_s").in("id", assetIds)
      : {
          data: [] as {
            id: string;
            kind: AssetKind;
            storage_key: string;
            duration_s: number | null;
          }[],
          error: null,
        };

  if (assetsError) {
    throw new Error(`Failed to read element assets: ${assetsError.message}`);
  }
  const assetById = new Map((assetRows ?? []).map((a) => [a.id, a]));

  const buildResolved = (
    el: (typeof ownedElements)[number],
    expectedKind: "image" | "video" | "audio",
    ordinal: number,
  ): ResolvedApiRef | ResolvedApiReferencesError => {
    const asset = assetById.get(el.asset_id);
    if (!asset) {
      return {
        ok: false,
        status: 422,
        code: "invalid_reference",
        error: `Asset for element "${el.id}" (@${el.name}) is missing.`,
      };
    }
    const actualKind = classifyRefKind(asset.kind);
    if (actualKind !== expectedKind) {
      return {
        ok: false,
        status: 422,
        code: "invalid_reference_kind",
        error: `Element "${el.id}" (@${el.name}) is a ${actualKind ?? asset.kind} reference, not ${expectedKind}.`,
      };
    }
    return {
      elementId: el.id,
      name: el.name,
      category: el.category,
      description: el.description,
      aiDescription: el.ai_description,
      assetId: asset.id,
      assetKind: asset.kind,
      storageKey: asset.storage_key,
      durationS: asset.duration_s,
      refKind: expectedKind,
      ordinal,
    };
  };

  const orderedImages: ResolvedApiRef[] = [];
  for (let i = 0; i < imageRefs.length; i++) {
    const el = ownedById.get(imageRefs[i]!.trim())!;
    const res = buildResolved(el, "image", i + 1);
    if ("ok" in res) return res;
    orderedImages.push(res);
  }

  const orderedVideos: ResolvedApiRef[] = [];
  for (let i = 0; i < videoRefs.length; i++) {
    const el = ownedById.get(videoRefs[i]!.trim())!;
    const res = buildResolved(el, "video", i + 1);
    if ("ok" in res) return res;
    orderedVideos.push(res);
  }

  const orderedAudios: ResolvedApiRef[] = [];
  for (let i = 0; i < audioRefs.length; i++) {
    const el = ownedById.get(audioRefs[i]!.trim())!;
    const res = buildResolved(el, "audio", i + 1);
    if ("ok" in res) return res;
    orderedAudios.push(res);
  }

  // 4. Validate and rewrite positional `@Image k`, `@Video k`, `@Audio k` mentions in prompt.
  let positionalError: ResolvedApiReferencesError | null = null;
  const rewrittenPrompt = prompt.replace(
    POSITIONAL_REF_PATTERN,
    (whole, rawKind: string, rawIdx: string, at: number) => {
      if (positionalError) return whole;
      if (tagLeadIsWordish(prompt, at)) return whole;

      const kindLower = rawKind.toLowerCase();
      const normKind: "image" | "video" | "audio" =
        kindLower === "voice" ? "audio" : (kindLower as "image" | "video" | "audio");
      const idx = Number.parseInt(rawIdx, 10);
      const list =
        normKind === "image" ? orderedImages : normKind === "video" ? orderedVideos : orderedAudios;

      if (!Number.isInteger(idx) || idx < 1 || idx > list.length) {
        positionalError = {
          ok: false,
          status: 422,
          code: "invalid_reference_index",
          error: `Positional reference "${whole}" is out of bounds: ${list.length} ${normKind} reference(s) provided.`,
        };
        return whole;
      }

      const target = list[idx - 1]!;
      return `@${target.name}`;
    },
  );

  if (positionalError) return positionalError;

  // 5. Validate native `@<element.name>` tags in rewrittenPrompt (and attach any not already in the arrays).
  if (!model.nativeAudio) {
    const mentionedTags = tagsInOrder(rewrittenPrompt);
    for (const tag of mentionedTags) {
      const el = ownedByName.get(tag);
      if (!el) {
        return {
          ok: false,
          status: 422,
          code: "unknown_reference_tag",
          error: `Unknown reference tag "@${tag}". Upload the element first or pass its ID in image_refs/video_refs/audio_refs.`,
        };
      }
      const asset = assetById.get(el.asset_id);
      if (!asset) {
        return {
          ok: false,
          status: 422,
          code: "invalid_reference",
          error: `Asset for reference "@${el.name}" is missing.`,
        };
      }
      const refKind = classifyRefKind(asset.kind);
      if (!refKind) {
        return {
          ok: false,
          status: 422,
          code: "invalid_reference_kind",
          error: `Reference "@${el.name}" has unsupported asset kind "${asset.kind}".`,
        };
      }
      const targetList =
        refKind === "image" ? orderedImages : refKind === "video" ? orderedVideos : orderedAudios;
      if (!targetList.some((r) => r.elementId === el.id)) {
        targetList.push({
          elementId: el.id,
          name: el.name,
          category: el.category,
          description: el.description,
          aiDescription: el.ai_description,
          assetId: asset.id,
          assetKind: asset.kind,
          storageKey: asset.storage_key,
          durationS: asset.duration_s,
          refKind,
          ordinal: targetList.length + 1,
        });
      }
    }
  }

  // 6. Enforce model-specific reference limits and formats.
  const limits = referenceLimitsFor(modelId);
  const totalRefs = orderedImages.length + orderedVideos.length + orderedAudios.length;
  for (const [kind, count, limit] of [
    ["image", orderedImages.length, limits.image],
    ["video", orderedVideos.length, limits.video],
    ["audio", orderedAudios.length, limits.audio],
  ] as const) {
    if (count <= limit) continue;
    return {
      ok: false,
      status: 422,
      code: "too_many_references",
      error: `${model.label} accepts at most ${limit} ${kind} references (received ${count}).`,
    };
  }
  if (totalRefs > limits.total) {
    return {
      ok: false,
      status: 422,
      code: "too_many_references",
      error: `${model.label} accepts at most ${limits.total} total references (received ${totalRefs}).`,
    };
  }

  if (model.nativeAudio) {
    if (orderedVideos.length > 0 || orderedAudios.length > 0) {
      return {
        ok: false,
        status: 422,
        code: "invalid_parameters",
        error:
          "Kling only accepts start and end image frames — video and audio references cannot be used with Kling.",
      };
    }
    if (orderedImages.length < 1 || orderedImages.length > 2) {
      return {
        ok: false,
        status: 422,
        code: "invalid_parameters",
        error:
          "Kling requires 1 start frame and at most 1 optional end frame in image_refs (1 or 2 images).",
      };
    }
    for (const img of orderedImages) {
      const ext = extFromFilename(img.storageKey, "").toLowerCase();
      if (ext && !KLING_FRAME_EXTS.has(ext)) {
        return {
          ok: false,
          status: 422,
          code: "invalid_parameters",
          error: `@${img.name} is a ${ext.toUpperCase()} — Kling only takes PNG or JPG frames.`,
        };
      }
    }
  } else if (modelId.startsWith("gemini-")) {
    if (orderedAudios.length > 0) {
      return {
        ok: false,
        status: 422,
        code: "invalid_parameters",
        error: "Gemini Omni Video cannot use audio URL references yet; it requires Kie audio IDs.",
      };
    }
    if (orderedImages.length === 0) {
      return {
        ok: false,
        status: 422,
        code: "missing_reference",
        error: "Gemini Omni Video needs at least one image reference.",
      };
    }
    if (orderedVideos.length > 1) {
      return {
        ok: false,
        status: 422,
        code: "too_many_references",
        error: "Gemini Omni Video accepts only one source video.",
      };
    }
    if (orderedVideos.length > 0 && !geminiOmniVideoInputPaid(resolution)) {
      return {
        ok: false,
        status: 422,
        code: "invalid_parameters",
        error: "Gemini source-video input is unavailable until a paid video-input receipt exists.",
      };
    }
    if (orderedImages.length + orderedVideos.length * 2 > 7) {
      return {
        ok: false,
        status: 422,
        code: "too_many_references",
        error:
          "Gemini Omni Video supports at most 7 reference units (each image is 1; a video is 2).",
      };
    }
  }

  if (!supportsPromptOnlyVideo(modelId) && totalRefs === 0) {
    return {
      ok: false,
      status: 422,
      code: "missing_reference",
      error: `${model.label} requires at least one reference.`,
    };
  }

  // Every video reference must have a measured positive duration_s.
  const videoReferenceDurationsS: number[] = [];
  for (const vid of orderedVideos) {
    if (
      typeof vid.durationS !== "number" ||
      !Number.isFinite(vid.durationS) ||
      vid.durationS <= 0
    ) {
      return {
        ok: false,
        status: 422,
        code: "invalid_media_file",
        error: `Video reference "${vid.elementId}" (@${vid.name}) does not have a valid measured duration.`,
      };
    }
    videoReferenceDurationsS.push(vid.durationS);
  }
  if (limits.videoSeconds !== null) {
    const tooLong = videoReferenceDurationsS.find((seconds) => seconds > limits.videoSeconds!);
    const totalSeconds = videoReferenceDurationsS.reduce((sum, seconds) => sum + seconds, 0);
    if (tooLong !== undefined || totalSeconds > limits.videoSeconds) {
      return {
        ok: false,
        status: 422,
        code: "invalid_media_file",
        error: `${model.label} accepts at most ${limits.videoSeconds} seconds per video and ${limits.videoSeconds} seconds of video references total (received ${totalSeconds.toFixed(1)} s).`,
      };
    }
  }
  if (limits.audioSeconds !== null) {
    // Only measured lengths are checked. Audio uploaded through the app has no duration_s
    // (actions/elements.ts), and an unreadable length passes through to the vendor, as the
    // app's own dropzone does, rather than refusing a voice the editor already uses.
    // shortcut: an unmeasured clip is left out of the total; measure app uploads to close it.
    const durations = orderedAudios
      .map((ref) => ref.durationS)
      .filter(
        (seconds): seconds is number => typeof seconds === "number" && Number.isFinite(seconds),
      );
    const totalSeconds = durations.reduce((sum, seconds) => sum + seconds, 0);
    if (
      durations.some((seconds) => seconds > limits.audioSeconds!) ||
      totalSeconds > limits.audioSeconds
    ) {
      return {
        ok: false,
        status: 422,
        code: "invalid_media_file",
        error: `${model.label} accepts at most ${limits.audioSeconds} seconds per audio clip and ${limits.audioSeconds} seconds of audio references total (received ${totalSeconds.toFixed(1)} s).`,
      };
    }
  }

  // 7. Build submittedPrompt (with description substitution for non-Kling) and check maxPromptChars.
  let submittedPrompt = rewrittenPrompt;
  if (!model.nativeAudio && rewrittenPrompt.includes("@")) {
    const imageAndVideoDescByName = new Map<string, string>();
    const audioDescByName = new Map<string, { name: string; description: string }>();
    for (const ref of [...orderedImages, ...orderedVideos]) {
      const text = descriptionFor({
        description: ref.description,
        ai_description: ref.aiDescription,
      });
      if (text) imageAndVideoDescByName.set(ref.name.toLowerCase(), text);
    }
    for (const ref of orderedAudios) {
      const text = descriptionFor({
        description: ref.description,
        ai_description: ref.aiDescription,
      });
      if (text) audioDescByName.set(ref.name.toLowerCase(), { name: ref.name, description: text });
    }
    const withImages =
      imageAndVideoDescByName.size > 0
        ? substituteElementTags(rewrittenPrompt, imageAndVideoDescByName)
        : rewrittenPrompt;
    submittedPrompt =
      audioDescByName.size > 0 ? declareAudioTags(withImages, audioDescByName) : withImages;
  }

  if (model.maxPromptChars !== undefined && submittedPrompt.length > model.maxPromptChars) {
    const over = submittedPrompt.length - model.maxPromptChars;
    return {
      ok: false,
      status: 422,
      code: "prompt_too_long",
      error: `This prompt reaches ${model.label} ${over.toLocaleString()} characters over its ${model.maxPromptChars.toLocaleString()} limit.`,
    };
  }

  // 8. Build providerReferencePrompt (maps `@<name>` -> `@image1`/`@video1`/`@audio1` in array order).
  const providerTokenByName = new Map<string, string>();
  const audioPrefix = modelId === "seedance-2-mini" ? "voice" : "audio";
  for (const img of orderedImages) {
    providerTokenByName.set(img.name.toLowerCase(), `@image${img.ordinal}`);
  }
  for (const vid of orderedVideos) {
    providerTokenByName.set(vid.name.toLowerCase(), `@video${vid.ordinal}`);
  }
  for (const aud of orderedAudios) {
    providerTokenByName.set(aud.name.toLowerCase(), `@${audioPrefix}${aud.ordinal}`);
  }

  const providerReferencePrompt = model.nativeAudio
    ? rewrittenPrompt
    : rewrittenPrompt.replace(ELEMENT_TAG, (whole, name: string, at: number) => {
        if (tagLeadIsWordish(rewrittenPrompt, at)) return whole;
        return providerTokenByName.get(name.toLowerCase()) ?? whole;
      });

  const allInOrder = [...orderedImages, ...orderedVideos, ...orderedAudios];
  const primaryRef = allInOrder[0] ?? null;
  const explicitOrderedTags = allInOrder.map((r) => r.name);

  return {
    ok: true,
    rewrittenPrompt,
    submittedPrompt,
    providerReferencePrompt,
    primaryRef,
    explicitOrderedTags,
    orderedReferences: {
      images: orderedImages,
      videos: orderedVideos,
      audios: orderedAudios,
    },
    videoReferenceDurationsS,
  };
}

/**
 * Copies the resolved references' underlying storage objects to scene-scoped keys
 * under `projectId` and atomically attaches them to `sceneId` via
 * `public.attach_scene_references_fenced`, verifying `prepare_token` under a row lock.
 */
export async function attachApiSceneReferences(args: {
  admin: SupabaseClient<Database>;
  projectId: string;
  sceneId: string;
  prepareToken: string;
  orderedReferences: {
    images: ResolvedApiRef[];
    videos: ResolvedApiRef[];
    audios: ResolvedApiRef[];
  };
}): Promise<{
  attachedStorageKeys: string[];
  fenced: boolean;
}> {
  const { admin, projectId, sceneId, prepareToken, orderedReferences } = args;
  const allRefs = [
    ...orderedReferences.images,
    ...orderedReferences.videos,
    ...orderedReferences.audios,
  ];

  if (allRefs.length === 0) {
    return { attachedStorageKeys: [], fenced: false };
  }

  const attachedStorageKeys: string[] = [];
  const rowsPayload: Array<{
    asset_kind: AssetKind;
    storage_key: string;
    duration_s: number | null;
    kind: "image" | "video" | "audio";
    ordinal: number;
    category: ElementCategory | null;
    description: string | null;
    tag: string | null;
  }> = [];

  try {
    for (const ref of allRefs) {
      const assetKind: AssetKind =
        ref.refKind === "audio" ? "audio" : ref.refKind === "video" ? "video_ref" : "ref_frame";
      const defaultExt = ref.refKind === "audio" ? "mp3" : ref.refKind === "video" ? "mp4" : "jpg";
      const toKey = buildStorageKey({
        projectId,
        kind: assetKind,
        ext: extFromFilename(ref.storageKey, defaultExt),
      });
      await copyStorageObject(ref.storageKey, toKey);
      attachedStorageKeys.push(toKey);

      const desc =
        ref.refKind === "audio"
          ? null
          : descriptionFor({
              description: ref.description,
              ai_description: ref.aiDescription,
            }) || null;

      rowsPayload.push({
        asset_kind: assetKind,
        storage_key: toKey,
        duration_s: ref.durationS,
        kind: ref.refKind,
        ordinal: ref.ordinal,
        category: ref.category,
        description: desc,
        tag: ref.name,
      });
    }

    const { data, error } = await admin.rpc("attach_scene_references_fenced", {
      p_scene_id: sceneId,
      p_project_id: projectId,
      p_prepare_token: prepareToken,
      p_refs: rowsPayload,
    });

    if (error) throw new Error(`Failed to attach scene references: ${error.message}`);
    return { attachedStorageKeys, fenced: !data };
  } catch (error) {
    if (attachedStorageKeys.length > 0) {
      await removeStorageObjects(attachedStorageKeys).catch((cleanupError) => {
        console.warn(
          `Could not clean uncommitted API reference copies for ${sceneId}`,
          cleanupError,
        );
      });
    }
    throw error;
  }
}

/**
 * Finds or creates the caller's personal clip project (`is_personal = true, kind = 'clip'`).
 * Safe under concurrent first calls via `23505` unique-index fallback.
 */
export async function ensurePersonalClipProjectForUser(
  admin: SupabaseClient<Database>,
  userId: string,
): Promise<string> {
  const find = async (): Promise<string | null> => {
    const { data, error } = await admin
      .from("projects")
      .select("id")
      .eq("user_id", userId)
      .eq("is_personal", true)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to look up personal clip project: ${error.message}`);
    }
    return data?.id ?? null;
  };

  const existing = await find();
  if (existing) return existing;

  const { data: project, error } = await admin
    .from("projects")
    .insert({ user_id: userId, title: "API Runs", kind: "clip", is_personal: true })
    .select("id")
    .single();
  if (project) return project.id;
  if (error?.code === "23505") {
    const winner = await find();
    if (winner) return winner;
  }
  throw new Error(`Could not create personal clip project: ${error?.message ?? "unknown error"}`);
}
