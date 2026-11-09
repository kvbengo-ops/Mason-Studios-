// Seedance 2.5 BytePlus rules for /ugc. Client-safe (no server-only): the column and the
// actions both read it. Seedance 2.5 on Kie is a separate, ordinary choice: never a
// fallback for BytePlus, and never rewritten to it.

export const BYTEPLUS_SEEDANCE_ID = "seedance-2.5-byteplus";
/** The only tier /ugc sells on BytePlus Seedance. */
export const BYTEPLUS_SEEDANCE_RESOLUTION = "480p";
/** BytePlus Seedance's default Quality when the request carries none; editors may change it. */
export const BYTEPLUS_SEEDANCE_QUALITY = "high";

/** A refusal message when BytePlus Seedance is asked for anything but 480p, else null. */
export function byteplusResolutionRefusal(modelId: string, resolution: string): string | null {
  return modelId === BYTEPLUS_SEEDANCE_ID && resolution !== BYTEPLUS_SEEDANCE_RESOLUTION
    ? `Seedance 2.5 renders at ${BYTEPLUS_SEEDANCE_RESOLUTION} only.`
    : null;
}
