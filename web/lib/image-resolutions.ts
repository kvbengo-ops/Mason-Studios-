/**
 * The pixel tiers kie sells for an image, as the picker labels them.
 *
 * `1K` is the base: every price in IMAGE_MODELS was measured there (nano-banana
 * 2 and 2.1 take kie's default, GPT Image 2.5 sends `resolution: "1K"`,
 * Seedream sends BytePlus pixel sizes). A higher tier is offered only once someone
 * has been billed for it — see ImageModelDescriptor.resolutionCostsUsd.
 */
export const IMAGE_RESOLUTION_IDS = ["1K", "2K", "4K"] as const;

export type ImageResolutionId = (typeof IMAGE_RESOLUTION_IDS)[number];

export const BASE_IMAGE_RESOLUTION: ImageResolutionId = "1K";

export function isImageResolution(value: unknown): value is ImageResolutionId {
  return typeof value === "string" && IMAGE_RESOLUTION_IDS.some((id) => id === value);
}
