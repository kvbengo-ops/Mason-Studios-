import type { ImageAspectRatio } from "./image-aspect-ratios";

/**
 * Seedream 5.0 Pro runs on BytePlus ModelArk only (lib/byteplus-image.ts), for both
 * prompt-only and reference calls: faces it makes on the worker's BytePlus account pass
 * Seedance 2.5's real-person check, which Kie's Seedream faces did not.
 *
 * The id recorded on runs.model. Not BytePlus's own model id (that is
 * BYTEPLUS_SEEDREAM_MODEL, which changes with BytePlus's dated releases).
 */
export const SEEDREAM_PRO_ID = "byteplus/seedream-5.0-pro";

/** Every ratio the app offers (see lib/image-aspect-ratios.ts): BytePlus takes any `WxH`. */
export const SEEDREAM_PRO_ASPECT_RATIOS: readonly ImageAspectRatio[] = [
  "9:16",
  "4:5",
  "1:1",
  "16:9",
];
