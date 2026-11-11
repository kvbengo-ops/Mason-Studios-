// Builds the `input` object for a kie image createTask, per model.
//
// ONE function, because the field that carries references is NOT the same on
// every model and getting it wrong is silent and billable: kie accepts unknown
// input fields, returns 200, drops them, and charges for a picture that used no
// reference at all (AGENTS.md's own "probing support by submitting has cost
// money twice"). Three shapes exist today:
//
//   google/nano-banana-edit      image_urls   separate -edit model id
//   nano-banana-2                image_input  SAME id as text-to-image
//   nano-banana-2-1              image_input  SAME id as text-to-image
//   gpt-image-2-5-*-image-to-image input_urls separate model id
//
// scripts/measure-image-model.ts calls this too. That is the point: a receipt is
// only worth anything if the measured request is byte-for-byte the shape the app
// actually sends, and a second copy of this dispatch would drift from it quietly.
import type { ImageAspectRatio } from "../image-aspect-ratios";
import type { ImageResolutionId } from "../image-resolutions";
import { gptImage25Input, isGptImage25Id } from "./gpt-image-2-5";

export const GPT_IMAGE_2_6_ECONOMY_TEXT = "gpt-image-2-6/economy-text-to-image";
export const GPT_IMAGE_2_6_ECONOMY_EDIT = "gpt-image-2-6/economy-image-to-image";

/**
 * Nano Banana 2 — https://docs.kie.ai/market/google/nanobanana2
 *
 * No vendor prefix, and not a typo: every "google/"-prefixed spelling is
 * rejected with code=422 while the bare id is accepted.
 *
 * ONE id for both text-to-image and editing, unlike google/nano-banana's
 * separate `-edit`. `nano-banana-2-edit` really is rejected — but that means
 * "editing lives on the base id here", not "this model cannot take
 * references", which is the inference this table carried until the docs were
 * read. Up to 14 images.
 */
export const NANO_BANANA_2_ID = "nano-banana-2";

/** Nano Banana 2.1 — https://docs.kie.ai/market/google/nanobanana-2-1. Same shape as 2: one id, image_input, max 10. */
export const NANO_BANANA_2_1_ID = "nano-banana-2-1";

/** Seedream 5.5 text-to-image uses a distinct model id and defaults to 2K. */
export const SEEDREAM_5_5_TEXT_ID = "seedream/5-5-text-to-image";

export function kieImageInput(
  model: string,
  prompt: string,
  aspectRatio: ImageAspectRatio,
  refImageUrls: readonly string[] = [],
  resolution: ImageResolutionId = "1K",
): Record<string, unknown> {
  if (model === SEEDREAM_5_5_TEXT_ID) {
    return { prompt, aspect_ratio: aspectRatio, size: resolution };
  }
  if (model === GPT_IMAGE_2_6_ECONOMY_TEXT || model === GPT_IMAGE_2_6_ECONOMY_EDIT) {
    if (resolution !== "1K") throw new Error("GPT Image 2.6 Economy offers 1K only.");
    if ((model === GPT_IMAGE_2_6_ECONOMY_EDIT) !== refImageUrls.length > 0) {
      throw new Error("GPT Image 2.6 Economy references require the image-to-image endpoint.");
    }
    return {
      prompt,
      aspect_ratio: aspectRatio,
      ...(refImageUrls.length ? { input_urls: [...refImageUrls] } : {}),
    };
  }
  if (isGptImage25Id(model)) {
    return gptImage25Input(model, prompt, aspectRatio, refImageUrls, resolution);
  }
  const hasTiers = model === NANO_BANANA_2_ID || model === NANO_BANANA_2_1_ID;
  // google/nano-banana documents no resolution at all, and kie ignores unknown
  // fields WHILE BILLING — so a tier it cannot honour must be refused here.
  if (!hasTiers && resolution !== "1K") {
    throw new Error("This model does not offer a resolution choice.");
  }
  // 1K is kie's default on the nano-banana 2 pair, and the measured receipts
  // were taken without the field: omit it so the 1K request stays
  // byte-for-byte what was priced.
  const base = {
    prompt,
    aspect_ratio: aspectRatio,
    ...(hasTiers && resolution !== "1K" ? { resolution } : {}),
  };
  if (refImageUrls.length === 0) return base;
  return model === NANO_BANANA_2_ID || model === NANO_BANANA_2_1_ID
    ? { ...base, image_input: [...refImageUrls] }
    : { ...base, image_urls: [...refImageUrls] };
}
