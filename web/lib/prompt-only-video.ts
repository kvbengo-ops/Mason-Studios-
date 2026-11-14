// These existing endpoints accept a prompt without image inputs.
export function supportsPromptOnlyVideo(modelId: string): boolean {
  return [
    "seedance-2.5",
    "seedance-2.5-byteplus",
    "seedance-2.5-flash-byteplus",
    "seedance-2",
    "seedance-2-fast",
    "seedance-2-mini",
    "kling-3.0-pro",
    "kling-4.0-reference",
    "wan-3.0",
    "gemini-omni-1.2",
  ].includes(modelId);
}
