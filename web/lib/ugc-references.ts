// The clip picker and API share model-specific limits. Other image workflows
// still use the original ten-reference cap.
export const MAX_REFERENCES = 10;

// Seedance 2.5 on BOTH routes: 12 references in any mix up to 12 images, 1 video and 3
// voices (owner, 2026-11-11; was 8 images, the partner's stated maximum of 2026-11-09),
// each timed clip 2-30 s and 30 s combined. 12 is our product ceiling, not the vendors':
// - kie: 30 images, 10 videos, 10 audio, 30 s combined per type (kie.ai/seedance-2-5,
//   read 2026-11-11; docs.kie.ai/market/bytedance/seedance-2-5 returned 403).
// - BytePlus ModelArk: 0-30 images, 0-10 videos and 0-10 audio clips, each 2-30 s, 30 s
//   combined per type, no combined item cap stated ("Create a video generation task",
//   docs.byteplus.com/en/docs/ModelArk/1520757, updated 2026-10-28, read 2026-11-11).
const SEEDANCE_25_LIMITS = {
  image: 12,
  video: 1,
  audio: 3,
  total: 12,
  videoSeconds: 30,
  audioSeconds: 30,
};

export function referenceLimitsFor(modelId: string) {
  if (modelId === "gemini-omni-1.2") {
    return { image: 6, video: 0, audio: 0, total: 6, videoSeconds: 0, audioSeconds: 0 };
  }
  if (modelId === "seedance-2.5-byteplus" || modelId === "seedance-2.5") {
    return SEEDANCE_25_LIMITS;
  }
  if (modelId.startsWith("kling-")) {
    return { image: 2, video: 0, audio: 0, total: 2, videoSeconds: 0, audioSeconds: 0 };
  }
  if (modelId === "wan-3.0") {
    // kie.ai/wan3.0-video, read 2026-11-11 (docs.kie.ai/market/wan/3-0-video returned 403):
    // 10 images, 5 videos, 5 audio, each clip 1-15 s and 15 s combined per type.
    // ponytail: kie's "input video + output duration <= 30 s" rule is not checked here.
    return {
      image: 10,
      video: 5,
      audio: 5,
      total: MAX_REFERENCES,
      videoSeconds: 15,
      audioSeconds: 15,
    };
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
