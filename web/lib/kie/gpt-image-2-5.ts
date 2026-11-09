import type { ImageAspectRatio } from "../image-aspect-ratios";
import type { ImageResolutionId } from "../image-resolutions";

// https://docs.kie.ai/market/gpt/gpt-image-2-5-flare-text-to-image
// https://docs.kie.ai/market/gpt/gpt-image-2-5-sunburst-image-to-image
//
// Flare and Sunburst share one request shape: separate text/edit ids, and
// references in `input_urls` — neither image_urls nor image_input. Read from
// the docs (2026-10-25); both paths of both models measured the same day
// (lib/models.ts's IMAGE_MODELS carries the receipts).
export const GPT_IMAGE_2_5_IDS = {
  flare: {
    text: "gpt-image-2-5-flare-text-to-image",
    edit: "gpt-image-2-5-flare-image-to-image",
  },
  sunburst: {
    text: "gpt-image-2-5-sunburst-text-to-image",
    edit: "gpt-image-2-5-sunburst-image-to-image",
  },
} as const;

const ALL_IDS: readonly string[] = Object.values(GPT_IMAGE_2_5_IDS).flatMap((v) => [
  v.text,
  v.edit,
]);
const EDIT_IDS: readonly string[] = Object.values(GPT_IMAGE_2_5_IDS).map((v) => v.edit);

/** The three ratios the app offers (see lib/image-aspect-ratios.ts). */
export const GPT_IMAGE_2_5_ASPECT_RATIOS: readonly ImageAspectRatio[] = [
  "9:16",
  "1:1",
  "16:9",
];

export function isGptImage25Id(model: string): boolean {
  return ALL_IDS.includes(model);
}

export function gptImage25Input(
  model: string,
  prompt: string,
  aspectRatio: ImageAspectRatio,
  refImageUrls: readonly string[] = [],
  resolution: ImageResolutionId = "1K",
): Record<string, unknown> {
  if (!GPT_IMAGE_2_5_ASPECT_RATIOS.includes(aspectRatio)) {
    throw new Error("GPT Image 2.5 does not support this aspect ratio.");
  }
  if (EDIT_IDS.includes(model) !== refImageUrls.length > 0) {
    throw new Error("GPT Image 2.5 references require the image-to-image endpoint.");
  }
  return {
    prompt,
    aspect_ratio: aspectRatio,
    // Fixed 1K tier: its receipt must match the price the picker quotes.
    resolution,
    ...(refImageUrls.length > 0 ? { input_urls: [...refImageUrls] } : {}),
  };
}
