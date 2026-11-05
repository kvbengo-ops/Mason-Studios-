// The Image Generator's unsent input, kept across navigation (0088).
// It is browser-local, so no database row is needed for a half-written prompt.
// Named fields keep runtime state and expiring signed image URLs out of storage.
import { isImageAspectRatio, type ImageAspectRatio } from "./image-aspect-ratios";

export interface ImageDraft {
  prompt: string;
  modelId: string;
  aspectRatio: ImageAspectRatio;
  imageCount: number;
}

export function serializeImageDraft(draft: ImageDraft): string {
  return JSON.stringify({
    prompt: draft.prompt,
    modelId: draft.modelId,
    aspectRatio: draft.aspectRatio,
    imageCount: draft.imageCount,
  });
}

/**
 * Reads a stored draft back, keeping only what is still valid.
 *
 * EVERY FIELD IS RE-VALIDATED rather than trusted. This string was last written
 * by an older version of this app, in a browser the operator also uses for
 * other things, and a model id or ratio can outlive the table that named it.
 * Restoring one the picker cannot display would leave the form quietly
 * submitting something the operator has no way to see or change.
 *
 * Returns a partial: a caller applies only the fields that came back, so a
 * corrupt or half-written draft degrades to "some of it survived" rather than
 * wiping live state.
 *
 * @param raw               what storage returned, or null when there was none
 * @param isSelectableModel whether this deployment still offers that model
 */
export function parseImageDraft(
  raw: string | null,
  isSelectableModel: (modelId: string) => boolean,
): Partial<ImageDraft> {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all. A draft that cannot be read is a draft that is not
    // there — never an error the operator has to clear before working.
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const draft = parsed as Record<string, unknown>;

  const out: Partial<ImageDraft> = {};
  if (typeof draft.prompt === "string") out.prompt = draft.prompt;
  if (typeof draft.modelId === "string" && isSelectableModel(draft.modelId)) {
    out.modelId = draft.modelId;
  }
  if (isImageAspectRatio(draft.aspectRatio)) out.aspectRatio = draft.aspectRatio;
  if (
    typeof draft.imageCount === "number" &&
    Number.isInteger(draft.imageCount) &&
    draft.imageCount >= 1 &&
    draft.imageCount <= 4
  ) {
    out.imageCount = draft.imageCount;
  }

  return out;
}
