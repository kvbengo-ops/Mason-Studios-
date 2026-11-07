export const IMAGE_DESCRIBE_ESTIMATE_USD = 0.001;
export const AUDIO_DESCRIBE_ESTIMATE_USD = 0.001;
export const VIDEO_DESCRIBE_ESTIMATE_USD = 0.0002;

export function elementDescribeEstimateUsd(kind: "image" | "audio" | "video"): number {
  if (kind === "audio") return AUDIO_DESCRIBE_ESTIMATE_USD;
  if (kind === "video") return VIDEO_DESCRIBE_ESTIMATE_USD;
  return IMAGE_DESCRIBE_ESTIMATE_USD;
}
