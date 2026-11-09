// Seedance 2.5 BytePlus rules for /ugc. Client-safe (no server-only): the column and the
// actions both read it. Seedance 2.5 on Kie is a separate, ordinary choice: never a
// fallback for BytePlus, and never rewritten to it.

export const BYTEPLUS_SEEDANCE_ID = "seedance-2.5-byteplus";
/** The only tier /ugc sells on BytePlus Seedance. */
export const BYTEPLUS_SEEDANCE_RESOLUTION = "480p";
/** BytePlus Seedance's default Quality when the request carries none; editors may change it. */
export const BYTEPLUS_SEEDANCE_QUALITY = "high";

const PICKER_RESOLUTIONS: Readonly<Record<string, readonly string[]>> = {
  "seedance-2.5": ["480p"],
  "seedance-2.5-byteplus": ["480p"],
  "kling-4.0": ["720p"],
  "kling-4.0-reference": ["720p"],
  "wan-3.0": ["480P", "720P"],
  "gemini-omni-video": ["360p", "720p"],
  "gemini-omni-1.2": ["360p", "720p"],
};

export function ugcPickerResolutionAllowed(modelId: string, resolution: string): boolean {
  return PICKER_RESOLUTIONS[modelId]?.includes(resolution) ?? true;
}

export function ugcPickerResolutions(modelId: string, resolutions: readonly string[]): string[] {
  return resolutions.filter((resolution) => ugcPickerResolutionAllowed(modelId, resolution));
}

/** A refusal message when BytePlus Seedance is asked for anything but 480p, else null. */
export function byteplusResolutionRefusal(modelId: string, resolution: string): string | null {
  return modelId === BYTEPLUS_SEEDANCE_ID && resolution !== BYTEPLUS_SEEDANCE_RESOLUTION
    ? `Seedance 2.5 renders at ${BYTEPLUS_SEEDANCE_RESOLUTION} only.`
    : null;
}
