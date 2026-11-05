import type { ImageAspectRatio } from "../image-aspect-ratios";
import type { ImageResolutionId } from "../image-resolutions";

// https://docs.kie.ai/market/seedream/5-pro-text-to-image
// https://docs.kie.ai/market/seedream/5-pro-image-to-image
//
// The ratio list below is transcribed from those two pages. Only 9:16 has
// actually been billed (docs/seedream-pro-integration.md); the other seven are
// documented rather than confirmed.
export const SEEDREAM_PRO_TEXT_ID = "seedream/5-pro-text-to-image";
export const SEEDREAM_PRO_EDIT_ID = "seedream/5-pro-image-to-image";
export const SEEDREAM_PRO_ASPECT_RATIOS: readonly ImageAspectRatio[] = [
  "9:16",
  "1:1",
  "3:4",
  "2:3",
  "16:9",
  "4:3",
  "3:2",
  "21:9",
];

export function seedreamProInput(
  model: string,
  prompt: string,
  aspectRatio: ImageAspectRatio,
  refImageUrls: readonly string[] = [],
  resolution: ImageResolutionId = "1K",
): Record<string, unknown> {
  // kie's `quality`: "Basic outputs 1K images, while High outputs 2K images."
  // There is no 4K.
  if (resolution === "4K") throw new Error("Seedream 5.0 Pro does not offer 4K.");
  if (!SEEDREAM_PRO_ASPECT_RATIOS.includes(aspectRatio)) {
    throw new Error("Seedream 5.0 Pro does not support this aspect ratio.");
  }
  if (model !== SEEDREAM_PRO_TEXT_ID && model !== SEEDREAM_PRO_EDIT_ID) {
    throw new Error("Unknown Seedream 5.0 Pro endpoint.");
  }
  if ((model === SEEDREAM_PRO_EDIT_ID) !== refImageUrls.length > 0) {
    throw new Error("Seedream 5.0 Pro references require the image-to-image endpoint.");
  }
  return {
    prompt,
    aspect_ratio: aspectRatio,
    // Fixed 1K tier: its receipt must match the price the picker quotes.
    quality: resolution === "2K" ? "high" : "basic",
    output_format: "png",
    ...(refImageUrls.length > 0 ? { image_urls: refImageUrls } : {}),
  };
}
