// Seedance 2.5 rules for /ugc. Client-safe (no server-only): the column and the
// actions both read it.

/** Seedance 2.5 on Kie. Retired for new renders; old clips keep resolving through it. */
export const RETIRED_KIE_SEEDANCE_ID = "seedance-2.5";
export const BYTEPLUS_SEEDANCE_ID = "seedance-2.5-byteplus";
/** The only tier /ugc sells on BytePlus Seedance, always stored with quality "high". */
export const BYTEPLUS_SEEDANCE_RESOLUTION = "480p";
export const BYTEPLUS_SEEDANCE_QUALITY = "high";

/** The settings a scene on retired Kie Seedance 2.5 moves to. */
export const BYTEPLUS_SEEDANCE_SETTINGS = {
  model: BYTEPLUS_SEEDANCE_ID,
  resolution: BYTEPLUS_SEEDANCE_RESOLUTION,
  quality: BYTEPLUS_SEEDANCE_QUALITY,
} as const;

/** A submitted pair with the retired Kie model moved to BytePlus at 480p. */
export function retargetRetiredModel(
  modelId: string,
  resolution: string,
): { modelId: string; resolution: string } {
  return modelId === RETIRED_KIE_SEEDANCE_ID
    ? { modelId: BYTEPLUS_SEEDANCE_ID, resolution: BYTEPLUS_SEEDANCE_RESOLUTION }
    : { modelId, resolution };
}

/** A refusal message when BytePlus Seedance is asked for anything but 480p, else null. */
export function byteplusResolutionRefusal(modelId: string, resolution: string): string | null {
  return modelId === BYTEPLUS_SEEDANCE_ID && resolution !== BYTEPLUS_SEEDANCE_RESOLUTION
    ? `Seedance 2.5 renders at ${BYTEPLUS_SEEDANCE_RESOLUTION} only.`
    : null;
}
