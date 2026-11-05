// Ratios the vendor DOCUMENTS for both Nano Banana endpoints and Nano Banana 2.
// Sources: https://kie.ai/nano-banana and https://kie.ai/nano-banana-2
//
// Documented, not measured, and the distinction is load-bearing: until the
// aspect ratio became selectable, every call this app made was hardcoded 9:16,
// so nine of these ten have never been sent to Kie at all. A wrong entry here
// costs a 422 on the first operator who picks it, not a bad charge -- the
// action refuses a ratio outside the model list before reserving -- but it
// would be a refusal nobody predicted. Confirm one with a paid call before
// treating this list as observed.
export const IMAGE_ASPECT_RATIOS = [
  "9:16",
  "1:1",
  "4:5",
  "3:4",
  "2:3",
  "16:9",
  "4:3",
  "3:2",
  "5:4",
  "21:9",
] as const;

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

export function isImageAspectRatio(value: unknown): value is ImageAspectRatio {
  return typeof value === "string" && IMAGE_ASPECT_RATIOS.some((ratio) => ratio === value);
}
