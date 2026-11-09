import "server-only";

import { estimateCost } from "@/lib/estimate";
import { offerable } from "@/lib/kie/offerable";
import { KIE_MODELS, videoAspectRatioFor } from "@/lib/kie/models";
import { quoteClip, type ClipQuote } from "@/lib/kie/cost";
import {
  getModel,
  isAudioEnabled,
  mergeRenderSettings,
  pricingAudioOn,
  type RenderSettings,
} from "@/lib/models";
import { resolveApiReferences, type ResolvedApiReferencesSuccess } from "@/lib/api-references";
import type { Resolution } from "@/lib/kie/rates";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { MAX_PROMPT_CHARS } from "@/lib/prompt-limits";

export interface ApiClipInput {
  prompt: string;
  modelId: string;
  resolution: Resolution;
  durationS: number;
  isTalkingHead: boolean;
  aspectRatio: string;
  imageRefs: string[];
  videoRefs: string[];
  audioRefs: string[];
}

export type ApiClipPreparation =
  | { ok: false; status: 400 | 403 | 422; code: string; error: string }
  | {
      ok: true;
      input: ApiClipInput;
      references: ResolvedApiReferencesSuccess;
      settings: RenderSettings;
      estimatedCostUsd: number;
      quote: ClipQuote;
    };

type ApiClipInputError = { ok: false; status: 400 | 422; code: string; error: string };

export function parseApiClipInput(body: Record<string, unknown>): ApiClipInput | ApiClipInputError {
  const allowed = new Set([
    "prompt",
    "model_id",
    "resolution",
    "duration_s",
    "is_talking_head",
    "aspect_ratio",
    "sound",
    "image_refs",
    "video_refs",
    "audio_refs",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return {
      ok: false,
      status: 400,
      code: "unknown_field",
      error: "Request contains an unknown field.",
    };
  }

  const { prompt, model_id: modelId, resolution, duration_s: durationS } = body;
  if (
    typeof prompt !== "string" ||
    prompt.trim().length === 0 ||
    typeof modelId !== "string" ||
    typeof resolution !== "string" ||
    typeof durationS !== "number" ||
    !Number.isInteger(durationS)
  ) {
    return {
      ok: false,
      status: 400,
      code: "invalid_parameters",
      error: "prompt, model_id, resolution, and integer duration_s are required.",
    };
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      status: 422,
      code: "prompt_too_long",
      error: `Prompt has ${prompt.length} characters; the limit is ${MAX_PROMPT_CHARS}.`,
    };
  }
  if (body.is_talking_head !== undefined && typeof body.is_talking_head !== "boolean") {
    return {
      ok: false,
      status: 400,
      code: "invalid_parameters",
      error: "is_talking_head must be a boolean.",
    };
  }
  if (body.sound !== undefined && typeof body.sound !== "boolean") {
    return {
      ok: false,
      status: 400,
      code: "invalid_parameters",
      error: "sound must be a boolean.",
    };
  }
  if (
    body.is_talking_head !== undefined &&
    body.sound !== undefined &&
    body.is_talking_head !== body.sound
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_parameters",
      error: "sound and is_talking_head must agree when both are sent.",
    };
  }

  const model = KIE_MODELS.find((candidate) => candidate.id === modelId);
  if (modelId === "seedance-2.5") {
    return {
      ok: false,
      status: 422,
      code: "model_retired",
      error: "seedance-2.5 is retired; use seedance-2.5-byteplus.",
    };
  }
  if (!model) {
    return { ok: false, status: 422, code: "unknown_model", error: `Unknown model "${modelId}".` };
  }
  const nativeAudio = getModel(modelId).nativeAudio;
  if (body.sound === false && !nativeAudio) {
    return {
      ok: false,
      status: 422,
      code: "unsupported_sound",
      error: modelId.startsWith("seedance-")
        ? "Seedance always generates audio; sound:false is unavailable."
        : `${model.label} cannot disable sound through this API.`,
    };
  }
  const aspectRatio =
    body.aspect_ratio === undefined ? "9:16" : videoAspectRatioFor(modelId, body.aspect_ratio);
  if (!aspectRatio) {
    return {
      ok: false,
      status: 422,
      code: "unsupported_aspect_ratio",
      error: `${model.label} does not support aspect_ratio "${String(body.aspect_ratio)}".`,
    };
  }
  if (!model.durationsS.includes(durationS as number)) {
    return {
      ok: false,
      status: 422,
      code: "unsupported_duration",
      error: `${model.label} does not support duration_s ${durationS}.`,
    };
  }
  // Case-insensitive: Wan 3.0 spells "480P" while every other model spells "480p".
  const canonicalResolution = model.resolutions.find(
    (r) => r.toLowerCase() === (resolution as string).toLowerCase(),
  );
  if (!canonicalResolution) {
    return {
      ok: false,
      status: 422,
      code: "unsupported_resolution",
      error: `${model.label} does not support resolution "${resolution}". Accepted: ${model.resolutions.join(", ")}.`,
    };
  }
  if (modelId === "seedance-2.5-byteplus" && canonicalResolution !== "480p") {
    return {
      ok: false,
      status: 422,
      code: "unsupported_resolution",
      error: "seedance-2.5-byteplus accepts only 480p.",
    };
  }
  const refs: Record<"image_refs" | "video_refs" | "audio_refs", string[]> = {
    image_refs: [],
    video_refs: [],
    audio_refs: [],
  };
  for (const key of Object.keys(refs) as (keyof typeof refs)[]) {
    const value = body[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.trim() === "")) {
      return {
        ok: false,
        status: 400,
        code: "invalid_parameters",
        error: `${key} must be an array of element IDs.`,
      };
    }
    refs[key] = (value as string[]).map((id) => id.trim());
  }

  return {
    prompt,
    modelId,
    resolution: canonicalResolution,
    durationS: durationS as number,
    isTalkingHead:
      (body.is_talking_head as boolean | undefined) ??
      (nativeAudio ? ((body.sound as boolean | undefined) ?? true) : false),
    aspectRatio,
    imageRefs: refs.image_refs,
    videoRefs: refs.video_refs,
    audioRefs: refs.audio_refs,
  };
}

export async function prepareApiClip(
  admin: SupabaseClient<Database>,
  userId: string,
  input: ApiClipInput,
): Promise<ApiClipPreparation> {
  if (
    !offerable(isAudioEnabled()).some(
      (offer) => offer.model.id === input.modelId && offer.resolution === input.resolution,
    )
  ) {
    return {
      ok: false,
      status: 422,
      code: "unavailable_rate",
      error: `No currently offerable rate exists for ${input.modelId} at ${input.resolution}.`,
    };
  }

  const references = await resolveApiReferences({
    admin,
    userId,
    modelId: input.modelId,
    resolution: input.resolution,
    prompt: input.prompt,
    imageRefs: input.imageRefs,
    videoRefs: input.videoRefs,
    audioRefs: input.audioRefs,
  });
  if (!references.ok) {
    return {
      ok: false,
      status: references.status,
      code: references.code,
      error: references.error,
    };
  }

  const settings = mergeRenderSettings(null, {
    model: input.modelId,
    resolution: input.resolution,
  });
  const estimate = estimateCost(
    {
      character: "",
      scenes: [
        {
          script_line: "",
          video_prompt: references.submittedPrompt,
          is_talking_head: input.isTalkingHead,
          duration_s: input.durationS,
          videoReferenceDurationsS: references.videoReferenceDurationsS,
        },
      ],
    },
    isAudioEnabled(),
    settings,
  );
  const quote = quoteClip(
    {
      modelId: input.modelId,
      resolution: input.resolution,
      durationS: input.durationS,
      withSound: pricingAudioOn(
        getModel(input.modelId),
        input.resolution,
        input.isTalkingHead,
        isAudioEnabled(),
      ),
    },
    new Date(),
  );
  if (!quote.ok) {
    return {
      ok: false,
      status: 422,
      code: "unavailable_rate",
      error: "This clip cannot be priced with the current rate table.",
    };
  }

  return {
    ok: true,
    input,
    references,
    settings,
    estimatedCostUsd: estimate.totalUsd,
    quote: quote.quote,
  };
}

export function apiClipQuote(prepared: Extract<ApiClipPreparation, { ok: true }>) {
  return {
    model_id: prepared.input.modelId,
    resolution: prepared.input.resolution,
    duration_s: prepared.input.durationS,
    output_estimate_usd: prepared.quote.usd,
    estimated_cost_usd: prepared.estimatedCostUsd,
    video_reference_seconds: prepared.references.videoReferenceDurationsS.reduce(
      (sum, seconds) => sum + seconds,
      0,
    ),
    price_source: prepared.quote.provenance,
    price_unpaid: prepared.quote.unpaid,
    promotion_stale: prepared.quote.stale,
    priced_at: prepared.quote.pricedAt,
  };
}
