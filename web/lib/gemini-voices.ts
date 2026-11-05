// Gemini's prebuilt voices, sent to kie as audio_ids by their lowercase name.
// kie accepts the lowercase spelling only ("Zephyr" 422s), and flags any
// render that carries one without an image reference (probed 2026-09-15).
export const GEMINI_VOICES = [
  ["achernar", "Female, soft"],
  ["achird", "Male, friendly"],
  ["algenib", "Male, gravelly"],
  ["algieba", "Male, smooth"],
  ["alnilam", "Male, firm"],
  ["aoede", "Female, breezy"],
  ["autonoe", "Female, bright"],
  ["callirrhoe", "Female, easy-going"],
  ["charon", "Male, informative"],
  ["despina", "Female, smooth"],
  ["enceladus", "Male, breathy"],
  ["erinome", "Female, clear"],
  ["fenrir", "Male, excitable"],
  ["gacrux", "Female, mature"],
  ["iapetus", "Male, clear"],
  ["kore", "Female, firm"],
  ["laomedeia", "Female, upbeat"],
  ["leda", "Female, youthful"],
  ["orus", "Male, firm"],
  ["puck", "Male, upbeat"],
  ["pulcherrima", "Female, forward"],
  ["rasalgethi", "Male, informative"],
  ["sadachbia", "Male, lively"],
  ["sadaltager", "Male, knowledgeable"],
  ["schedar", "Male, even"],
  ["sulafat", "Female, warm"],
  ["umbriel", "Male, easy-going"],
  ["vindemiatrix", "Female, gentle"],
  ["zephyr", "Female, bright"],
  ["zubenelgenubi", "Male, casual"],
] as const;

/** The voice to store for this clip, or undefined for "let Gemini pick". */
export function geminiVoiceFor(modelId: string, raw: unknown): string | undefined {
  if (modelId !== "gemini-omni-video" || typeof raw !== "string") return undefined;
  return GEMINI_VOICES.some(([name]) => name === raw) ? raw : undefined;
}
