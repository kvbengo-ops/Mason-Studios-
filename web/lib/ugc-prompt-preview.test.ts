import { describe, expect, it } from "vitest";
import {
  buildUgcPromptPreview,
  dialogueWordBudget,
  SPEECH_WORDS_PER_SECOND,
} from "./ugc-prompt-preview";

const NO_ELEMENTS: readonly { name: string; description?: string | null; ai_description?: string | null }[] = [];

describe("buildUgcPromptPreview — composition", () => {
  it("passes an untagged prompt through unchanged and marks tag binding exact", () => {
    const preview = buildUgcPromptPreview({
      prompt: "A hand pours coffee into a white mug.",
      elements: NO_ELEMENTS,
      scriptLine: null,
      isTalkingHead: false,
      audioEnabled: false,
      durationS: 4,
    });
    expect(preview.submitted).toBe("A hand pours coffee into a white mug.");
    expect(preview.tagsSubstituted).toBe(false);
    expect(preview.tagBindingExact).toBe(true);
    expect(preview.dialogueAppended).toBe(false);
  });

  it("substitutes a resolvable @tag with the element's description, exactly, and stays tag-binding exact", () => {
    const preview = buildUgcPromptPreview({
      prompt: "@lena reaches for the bottle.",
      elements: [{ name: "lena", description: "a woman in a blue apron" }],
      scriptLine: null,
      isTalkingHead: false,
      audioEnabled: false,
      durationS: 4,
    });
    expect(preview.submitted).toBe("a woman in a blue apron reaches for the bottle.");
    expect(preview.tagsSubstituted).toBe(true);
    // No "@" survives substitution here, so bindUITags provably has nothing
    // left to rewrite or delete.
    expect(preview.tagBindingExact).toBe(true);
  });

  it("leaves an unresolved @tag in place and flags tag binding as inexact", () => {
    const preview = buildUgcPromptPreview({
      prompt: "@nobody reaches for the bottle.",
      elements: NO_ELEMENTS,
      scriptLine: null,
      isTalkingHead: false,
      audioEnabled: false,
      durationS: 4,
    });
    // substituteElementTags leaves an unresolved tag exactly as written.
    expect(preview.submitted).toBe("@nobody reaches for the bottle.");
    expect(preview.tagsSubstituted).toBe(false);
    // A live "@" tag remains -- the worker's bindUITags WILL touch this
    // string (strip the "@", renumber it, or delete it if it is an audio
    // tag), and this preview cannot know which without scene_references.
    expect(preview.tagBindingExact).toBe(false);
  });

  it("appends the dialogue line when audio is on, the scene is a talking head, and both texts are non-empty", () => {
    const preview = buildUgcPromptPreview({
      prompt: "A woman speaks directly to camera.",
      elements: NO_ELEMENTS,
      scriptLine: "Try the new blend, it changes everything.",
      isTalkingHead: true,
      audioEnabled: true,
      durationS: 5,
    });
    expect(preview.dialogueAppended).toBe(true);
    expect(preview.submitted).toBe(
      'A woman speaks directly to camera. Dialogue, spoken aloud on camera: "Try the new blend, it changes everything."',
    );
  });

  it.each([
    ["audio disabled", { audioEnabled: false, isTalkingHead: true, scriptLine: "hi" }],
    ["not a talking head", { audioEnabled: true, isTalkingHead: false, scriptLine: "hi" }],
    ["no script_line", { audioEnabled: true, isTalkingHead: true, scriptLine: null }],
    ["blank script_line", { audioEnabled: true, isTalkingHead: true, scriptLine: "   " }],
  ])("does not append dialogue when %s", (_label, overrides) => {
    const preview = buildUgcPromptPreview({
      prompt: "A woman speaks directly to camera.",
      elements: NO_ELEMENTS,
      durationS: 5,
      ...overrides,
    });
    expect(preview.dialogueAppended).toBe(false);
    expect(preview.submitted).toBe("A woman speaks directly to camera.");
  });

  it("does not append dialogue when the scene text itself is empty, even with everything else set", () => {
    const preview = buildUgcPromptPreview({
      prompt: "   ",
      elements: NO_ELEMENTS,
      scriptLine: "hi",
      isTalkingHead: true,
      audioEnabled: true,
      durationS: 5,
    });
    expect(preview.dialogueAppended).toBe(false);
  });
});

describe("dialogueWordBudget / word-budget threshold", () => {
  it("matches the specified ~12-15 words for a 5s clip at the conservative end of the pace", () => {
    expect(SPEECH_WORDS_PER_SECOND).toBeGreaterThanOrEqual(2.5);
    expect(SPEECH_WORDS_PER_SECOND).toBeLessThanOrEqual(3);
    expect(dialogueWordBudget(5)).toBe(12);
  });

  it("scales with duration", () => {
    expect(dialogueWordBudget(4)).toBe(10);
    expect(dialogueWordBudget(10)).toBe(25);
  });

  it("flags overBudget only once the script line exceeds the budget, never below or at it", () => {
    const atBudget = buildUgcPromptPreview({
      prompt: "A woman speaks directly to camera.",
      elements: NO_ELEMENTS,
      // Exactly 12 words -- the budget for a 5s clip -- must NOT warn.
      scriptLine: "one two three four five six seven eight nine ten eleven twelve",
      isTalkingHead: true,
      audioEnabled: true,
      durationS: 5,
    });
    expect(atBudget.scriptLineWordCount).toBe(12);
    expect(atBudget.wordBudget).toBe(12);
    expect(atBudget.overBudget).toBe(false);

    const overBudget = buildUgcPromptPreview({
      prompt: "A woman speaks directly to camera.",
      elements: NO_ELEMENTS,
      // 13 words -- one over the 5s budget -- must warn.
      scriptLine: "one two three four five six seven eight nine ten eleven twelve thirteen",
      isTalkingHead: true,
      audioEnabled: true,
      durationS: 5,
    });
    expect(overBudget.scriptLineWordCount).toBe(13);
    expect(overBudget.overBudget).toBe(true);
  });

  it("never blocks — overBudget is advisory only, and dialogueAppended still resolves true when it fires", () => {
    const preview = buildUgcPromptPreview({
      prompt: "A woman speaks directly to camera.",
      elements: NO_ELEMENTS,
      scriptLine: "way more than twelve words in this single sentence spoken all at once, no pauses at all",
      isTalkingHead: true,
      audioEnabled: true,
      durationS: 5,
    });
    expect(preview.overBudget).toBe(true);
    expect(preview.dialogueAppended).toBe(true);
    expect(preview.submitted).toContain("way more than twelve words");
  });
});
