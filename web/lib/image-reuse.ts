import { IMAGE_ASPECT_RATIOS, type ImageAspectRatio } from "@/lib/image-aspect-ratios";

/**
 * "Reuse" in the image viewer fills the prompt bar with an earlier image's
 * prompt, model and ratio. The viewer and the bar are siblings with no shared
 * parent on every page that has them, so this is a window event rather than
 * props — the same bar listens wherever it is mounted.
 */
export const IMAGE_REUSE_EVENT = "image-reuse";

export interface ImageReuseDetail {
  prompt: string;
  /** The picker's model id; ignored if the bar does not offer it. */
  modelId: string | null;
  aspectRatio: ImageAspectRatio | null;
}

export function requestImageReuse(detail: ImageReuseDetail): void {
  window.dispatchEvent(new CustomEvent<ImageReuseDetail>(IMAGE_REUSE_EVENT, { detail }));
}

/**
 * Dragging a wall tile onto the prompt bar references that picture. The drag
 * carries the generated image's asset id under this type; the bar saves it to
 * the dragger's own elements (a prompt can only @tag a saved element) and tags it.
 */
export const GENERATED_IMAGE_DRAG_TYPE = "application/x-generated-image";

/** One fixed tag per picture, so dropping it twice reuses the element it made. */
export function dragReferenceName(assetId: string): string {
  return `img-${assetId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
}

/**
 * The standard ratio a picture's pixel size is closest to, by log distance so
 * 16:9 vs 9:16 and 3:2 vs 2:3 are judged on the same scale. Models return
 * sizes a few pixels off the nominal ratio, hence nearest rather than equal.
 */
export function nearestImageAspectRatio(width: number, height: number): ImageAspectRatio | null {
  if (!(width > 0) || !(height > 0)) return null;
  const target = Math.log(width / height);
  let best: ImageAspectRatio | null = null;
  let bestDistance = Infinity;
  for (const ratio of IMAGE_ASPECT_RATIOS) {
    const [w, h] = ratio.split(":").map(Number) as [number, number];
    const distance = Math.abs(Math.log(w / h) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = ratio;
    }
  }
  return best;
}
