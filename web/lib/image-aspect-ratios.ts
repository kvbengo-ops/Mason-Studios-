// Every ratio the image generator knows, in picker order. 9:16, 1:1 and 16:9 are on every
// model (owner's call, 2026-11-09); 4:5 was added 2026-11-18 only on the models whose vendor
// documents it, because kie drops a value it does not know and still bills the render.
// A draft saved with a removed ratio falls back to the default.
// 2.44:1 (owner, 2026-11-21) only where the vendor takes an exact pixel size (Seedream 5.0 Pro).
export const IMAGE_ASPECT_RATIOS = ["9:16", "4:5", "1:1", "16:9", "2.44:1"] as const;

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

/** The four ratios a model documenting 4:5 offers. */
export const STANDARD_IMAGE_ASPECT_RATIOS: readonly ImageAspectRatio[] = [
  "9:16",
  "4:5",
  "1:1",
  "16:9",
];

/** The ratios every image model documents; a model without 4:5 offers these. */
export const COMMON_IMAGE_ASPECT_RATIOS: readonly ImageAspectRatio[] = ["9:16", "1:1", "16:9"];

export function isImageAspectRatio(value: unknown): value is ImageAspectRatio {
  return typeof value === "string" && IMAGE_ASPECT_RATIOS.some((ratio) => ratio === value);
}
