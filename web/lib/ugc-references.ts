// The clip picker and API share model-specific limits. Other image workflows
// still use the original ten-reference cap.
export const MAX_REFERENCES = 10;

export function referenceLimitsFor(modelId: string) {
  if (modelId === "gemini-omni-1.2") {
    return { image: 6, video: 0, audio: 0, total: 6, videoSeconds: 0, audioSeconds: 0 };
  }
  if (modelId === "seedance-2.5-byteplus") {
    return { image: 8, video: 1, audio: 3, total: 12, videoSeconds: 30, audioSeconds: 30 };
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
