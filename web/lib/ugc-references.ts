// The clip picker and API share model-specific limits. Other image workflows
// still use the original ten-reference cap.
export const MAX_REFERENCES = 10;

// Seedance 2.5 on BOTH routes: 12 references, 8 images + 1 video + 3 voices (the partner's
// stated maximum, 2026-11-09), each timed clip 2-30 s and 30 s combined. The vendors allow
// more per type (kie: 30 images, 10 videos, 10 audio, prompt up to 20,480 characters —
// docs.kie.ai/market/bytedance/seedance-2-5); 12 is our product ceiling, not theirs.
const SEEDANCE_25_LIMITS = {
  image: 8,
  video: 1,
  audio: 3,
  total: 12,
  videoSeconds: 30,
  audioSeconds: 30,
};

export function referenceLimitsFor(modelId: string) {
  if (modelId === "seedance-2.5-byteplus" || modelId === "seedance-2.5") {
    return SEEDANCE_25_LIMITS;
  }
  if (modelId.startsWith("kling-")) {
    return { image: 2, video: 0, audio: 0, total: 2, videoSeconds: 0, audioSeconds: 0 };
  }
  if (modelId === "seedance-2-mini") {
    return { image: 9, video: 3, audio: 3, total: 10, videoSeconds: 15, audioSeconds: 15 };
  }
  return {
    image: 10,
    video: 10,
    audio: 10,
    total: MAX_REFERENCES,
    videoSeconds: null,
    audioSeconds: null,
  };
}

/**
 * The /ugc References box's total for this model: Seedance 2.5 holds 12, every other model
 * the original ten. Kling is excluded on purpose: it takes its start/end frame pair, not the
 * box, so its API limit above (2 images) is not a box limit.
 */
export function maxReferencesFor(modelId: string): number {
  return modelId.startsWith("kling-") ? MAX_REFERENCES : referenceLimitsFor(modelId).total;
}
