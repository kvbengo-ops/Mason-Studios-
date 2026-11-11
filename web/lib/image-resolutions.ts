/**
 * The pixel tiers kie sells for an image, as the picker labels them.
 *
 * `1K` is the base tier in IMAGE_MODELS. A higher tier is offered only when
 * its price is known — see ImageModelDescriptor.resolutionCostsUsd.
 */
export const IMAGE_RESOLUTION_IDS = ["1K", "1.5K", "2K", "4K"] as const;

export type ImageResolutionId = (typeof IMAGE_RESOLUTION_IDS)[number];

export const BASE_IMAGE_RESOLUTION: ImageResolutionId = "1K";

export function isImageResolution(value: unknown): value is ImageResolutionId {
  return typeof value === "string" && IMAGE_RESOLUTION_IDS.some((id) => id === value);
}
