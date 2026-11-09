// The three ratios the image generator offers, on every model (owner's call, 2026-11-09).
// Every vendor documents all three; models that list more (kie's Nano Banana pages) are
// deliberately not exposed. A draft saved with a removed ratio falls back to the default.
export const IMAGE_ASPECT_RATIOS = ["9:16", "1:1", "16:9"] as const;

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

export function isImageAspectRatio(value: unknown): value is ImageAspectRatio {
  return typeof value === "string" && IMAGE_ASPECT_RATIOS.some((ratio) => ratio === value);
}
