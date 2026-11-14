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

// ponytail: Flash assumed to share 2.5's reference limits (same create-task API page).
const SEEDANCE_25_IDS: ReadonlySet<string> = new Set([
  "seedance-2.5",
  "seedance-2.5-byteplus",
  "seedance-2.5-flash-byteplus",
]);

export function referenceLimitsFor(modelId: string) {
  if (modelId === "gemini-omni-1.2") {
    return { image: 6, video: 0, audio: 0, total: 6, videoSeconds: 0, audioSeconds: 0 };
  }
  if (SEEDANCE_25_IDS.has(modelId)) {
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

const SEEDANCE_25_MIN_CLIP_S = 2;

/**
 * Refuses a Seedance 2.5 reference video or audio clip kie would reject with 422 ("Each
 * reference video must be between 2 and 30 seconds"): each clip 2-30 s, 30 s combined per type.
 * Checked before the scene is written, so it costs a message instead of a failed scene. A null
 * duration (not measured: audio saved before the app stored it, or a browser that could not
 * read it) passes through; the spend cap already refuses to price an unmeasured video.
 */
export function referenceDurationRefusal(
  modelId: string,
  kind: "video" | "audio",
  durationsS: readonly (number | null)[],
): string | null {
  if (!SEEDANCE_25_IDS.has(modelId)) return null;
  const max = kind === "video" ? SEEDANCE_25_LIMITS.videoSeconds : SEEDANCE_25_LIMITS.audioSeconds;
  const measured = durationsS.filter((s): s is number => typeof s === "number");
  const bad = measured.find((s) => s < SEEDANCE_25_MIN_CLIP_S || s > max);
  if (bad !== undefined) {
    return `Seedance 2.5 needs each reference ${kind} to be ${SEEDANCE_25_MIN_CLIP_S} to ${max} seconds. One is ${bad.toFixed(1)} s: trim it, then generate again.`;
  }
  const total = measured.reduce((sum, s) => sum + s, 0);
  if (total > max) {
    return `Seedance 2.5 allows ${max} seconds of reference ${kind} in total. These add up to ${total.toFixed(1)} s: trim or remove one.`;
  }
  return null;
}

/**
 * The /ugc References box's total for this model: Seedance 2.5 holds 12, every other model
 * the original ten. Kling is excluded on purpose: it takes its start/end frame pair, not the
 * box, so its API limit above (2 images) is not a box limit.
 */
export function maxReferencesFor(modelId: string): number {
  return modelId.startsWith("kling-") ? MAX_REFERENCES : referenceLimitsFor(modelId).total;
}
