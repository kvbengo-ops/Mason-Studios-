import { isAcceptedReferenceAudio, isAcceptedReferenceVideo } from "./file-type";
import { CLAUDE_SONNET_5, describeReferenceCostUsd } from "./models";

export const AUDIO_DESCRIBE_ESTIMATE_USD = 0.001;
export const VIDEO_DESCRIBE_ESTIMATE_USD = 0.0002;

export function elementDescribeEstimateUsd(kind: "image" | "audio" | "video"): number {
  if (kind === "audio") return AUDIO_DESCRIBE_ESTIMATE_USD;
  if (kind === "video") return VIDEO_DESCRIBE_ESTIMATE_USD;
  return describeReferenceCostUsd(CLAUDE_SONNET_5);
}

export function uploadDescribeEstimateUsd(file: File): number {
  return elementDescribeEstimateUsd(
    isAcceptedReferenceAudio(file) ? "audio" : isAcceptedReferenceVideo(file) ? "video" : "image",
  );
}
