// What the /ugc composer's prompt box will actually become before it reaches
// kie, computed CLIENT-SIDE so the operator can read it before pressing
// Generate — the whole reason this file exists is that nobody could, before.
//
// Two transforms happen invisibly between the box and the vendor:
//
//   1. substituteElementTags (element-tags.ts) replaces "@name" with the
//      referenced element's saved description, at create time, writing the
//      result to scenes.ai_generated_prompt.
//   2. worker/internal/loop/dispatch.go's bindUITags rewrites a BOUND image
//      tag to "@image1" and DELETES an audio tag outright — the bug this
//      whole feature exists to make visible turned "Dialogue audio sourced
//      entirely from @Audio_1." into "Dialogue audio sourced entirely from
//      ." on a real production render, and nobody saw it until the payload
//      was read by hand.
//
// (1) is reproduced EXACTLY here, by calling the same substituteElementTags
// the server calls (actions/ugc.ts's resolveElementTags) rather than writing
// a second copy of the substitution rule.
//
// (2) is NOT reproduced. bindUITags decides what to do with a tag using
// scene_references — which image or audio asset actually got attached,
// resolved server-side from ALL of the prompt's tags, not just the first one
// this column tracks for its own picker. Rebuilding that resolution here
// would be exactly the second, drifting implementation this file exists to
// avoid — so instead of guessing, tagBindingExact below reports whether
// bindUITags is PROVABLY a no-op (no "@" tag syntax survives at all — see its
// own first branch, `if len(matches) == 0 return prompt`) and the UI is
// required to say so honestly when it is not.
import { descriptionFor, substituteElementTags, ELEMENT_TAG } from "@/lib/element-tags";
import { wordCount } from "@/lib/description-quality";

/**
 * Natural speech runs about 2.5-3 words per second. This is the LOW end of
 * that range on purpose: the warning below exists to catch a line that will
 * make the model rush or slur, and a threshold set at the fast end of human
 * speech would stay quiet on lines that are already too tight for anyone
 * but an auctioneer. At 2.5 words/s a 5s clip holds ~12 words before this
 * warns — comfortably inside the "12-15 words for 5s" budget the feature was
 * specified against.
 */
export const SPEECH_WORDS_PER_SECOND = 2.5;

/** How many spoken words fit in a clip `durationS` seconds long, at SPEECH_WORDS_PER_SECOND. */
export function dialogueWordBudget(durationS: number): number {
  return Math.floor(durationS * SPEECH_WORDS_PER_SECOND);
}

/**
 * The exact template worker/internal/loop/dispatch.go's promptForScene uses
 * to append a spoken line, character for character:
 *
 *   base = fmt.Sprintf(`%s Dialogue, spoken aloud on camera: "%s"`, base, *scene.ScriptLine)
 *
 * Kept as ONE constant so there is exactly one place either side of this
 * feature can drift from the other, and ugc-prompt-preview-drift.test.ts
 * fails loudly the moment this string and the Go literal disagree — a
 * preview that quietly stops matching what ships is worse than no preview,
 * because an operator will trust it.
 */
export const DIALOGUE_APPEND_TEMPLATE = `%s Dialogue, spoken aloud on camera: "%s"`;

// Split on the two "%s" placeholders ONCE, rather than two sequential
// String.replace calls: a prompt or script line that itself contains the
// literal text "%s" would make a second .replace find that instead of the
// template's own second placeholder. Splitting the TEMPLATE (fixed, known
// text) is immune to whatever `base` and `scriptLine` happen to contain.
const [DIALOGUE_TEMPLATE_PRE, DIALOGUE_TEMPLATE_MID, DIALOGUE_TEMPLATE_POST] =
  DIALOGUE_APPEND_TEMPLATE.split("%s") as [string, string, string];

/** Appends a spoken-dialogue instruction to `base`, exactly as promptForScene does. */
export function appendDialogue(base: string, scriptLine: string): string {
  return `${DIALOGUE_TEMPLATE_PRE}${base}${DIALOGUE_TEMPLATE_MID}${scriptLine}${DIALOGUE_TEMPLATE_POST}`;
}

export interface UgcPromptPreviewInput {
  /** The composer's own box text — scenes.video_prompt for this clip. */
  prompt: string;
  /** The operator's saved @tag library — same list the composer's editor resolves against. */
  elements: readonly { name: string; description?: string | null; ai_description?: string | null }[];
  /**
   * scenes.script_line for the selected scene, or null. /ugc's own
   * generateClip sets is_talking_head true only for Kling (see
   * actions/ugc.ts) — it is what asks Kling for sound, not a Dialogue
   * control. /ugc still writes no script_line on any model, so this is read
   * straight off the schema and degrades to "no dialogue" whenever it is
   * absent, rather than assuming a UI control that does not exist here.
   */
  scriptLine: string | null;
  /** scenes.is_talking_head for the selected scene. */
  isTalkingHead: boolean;
  /**
   * isAudioEnabled() — the web-side mirror of AUDIO_ENABLED that /ugc/[id]/
   * page.tsx already reads to build `options`. Stands in for Go's
   * `model.HasAudio` (dispatch.go's withSpeech: `model.HasAudio &&
   * scene.IsTalkingHead`), which for Seedance really is `SupportsGenerateAudio
   * && AUDIO_ENABLED` — always true here, since every Seedance descriptor sets
   * SupportsGenerateAudio.
   *
   * KLING NOW REACHES THIS COLUMN (lib/ugc-options.ts enters it at its own
   * cheapest offerable tier), and for Kling `model.HasAudio` is `isTalkingHead &&
   * AUDIO_ENABLED`, not AUDIO_ENABLED alone. That collapse still holds here
   * because `dialogueAppended` below ANDs in `isTalkingHead` itself — if/when
   * the preview is remounted, its caller will pass the scene's real
   * is_talking_head, not a constant — so the combined gate matches Go's for
   * both model families without this preview needing its own copy of
   * SupportsGenerateAudio.
   */
  audioEnabled: boolean;
  /** scenes.duration_s (or the pending duration for a not-yet-created scene). */
  durationS: number;
}

export interface UgcPromptPreview {
  /**
   * The text this preview believes kie's `prompt` field will hold. Exact
   * when tagBindingExact is true; otherwise this is the text BEFORE the
   * worker's own tag rewrite, which is the most this preview can promise —
   * see tagBindingExact's own doc comment.
   */
  submitted: string;
  /**
   * True when substitution actually changed something, i.e. the scene this
   * clip creates would get a non-null ai_generated_prompt (0072). Informational
   * only: `submitted` above is the same string either way, because
   * promptForScene reads whichever of the pair is set and falls back to the
   * other when it is empty.
   */
  tagsSubstituted: boolean;
  /**
   * True when bindUITags is PROVABLY a no-op on `submitted` — no "@" tag
   * syntax survives substitution, so there is nothing left for the worker to
   * renumber into "@image1" or delete outright. False means a tag remains
   * (bound to an image, unbound, or an audio tag headed for deletion) and
   * this preview cannot promise `submitted` is the literal string kie
   * receives — reproducing that decision needs scene_references, which this
   * column does not fully resolve client-side. The UI must label this
   * honestly rather than show a guess as fact.
   */
  tagBindingExact: boolean;
  /** Whether the dialogue line was appended — mirrors promptForScene's `withSpeech` gate exactly (audio on, scene is a talking head, both the scene text and script_line are non-empty). */
  dialogueAppended: boolean;
  /** wordCount(scriptLine), 0 when scriptLine is null/blank. */
  scriptLineWordCount: number;
  /** dialogueWordBudget(durationS) — how many spoken words this clip's length can hold. */
  wordBudget: number;
  /** True when scriptLineWordCount exceeds wordBudget. Advisory only — see the constant's own doc comment on why this never blocks Generate. */
  overBudget: boolean;
}

/**
 * Builds the preview. Reuses substituteElementTags and descriptionFor
 * directly (not a reimplementation) with the same "byName keyed on elements
 * that actually have a description" rule actions/ugc.ts's resolveElementTags
 * applies, so `submitted` before the tag-binding caveat is byte-identical to
 * what the server would compute from the same inputs.
 */
export function buildUgcPromptPreview({
  prompt,
  elements,
  scriptLine,
  isTalkingHead,
  audioEnabled,
  durationS,
}: UgcPromptPreviewInput): UgcPromptPreview {
  const byName = new Map<string, string>();
  for (const element of elements) {
    const text = descriptionFor(element);
    if (text) byName.set(element.name.toLowerCase(), text);
  }
  const base = substituteElementTags(prompt, byName);
  const tagsSubstituted = base !== prompt;

  // A fresh RegExp, not the shared (`g`-flagged, stateful) ELEMENT_TAG
  // constant — same reason lib/elements.ts's findElementByTag rebuilds
  // TAG_PATTERN before each scan rather than reusing the module-level one.
  const tagBindingExact = !new RegExp(ELEMENT_TAG).test(base);

  const trimmedScriptLine = (scriptLine ?? "").trim();
  // Mirrors promptForScene's own gate: withSpeech (audio on AND is_talking_head)
  // AND a real scene text to append to AND a non-empty script_line.
  const dialogueAppended =
    audioEnabled && isTalkingHead && prompt.trim().length > 0 && trimmedScriptLine.length > 0;

  const submitted = dialogueAppended ? appendDialogue(base, scriptLine as string) : base;

  const scriptLineWordCount = wordCount(scriptLine ?? "");
  const wordBudget = dialogueWordBudget(durationS);

  return {
    submitted,
    tagsSubstituted,
    tagBindingExact,
    dialogueAppended,
    scriptLineWordCount,
    wordBudget,
    overBudget: scriptLineWordCount > wordBudget,
  };
}
