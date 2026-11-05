// Word-count heuristic behind the Character/Product screens' "this is too
// thin" warning (SMN incident: "an athletic woman" was the whole character
// description, so the compiler invented hair/clothing/lighting fresh for
// every scene, and the same person looked different in every clip). This is
// advisory, not a write refusal — nothing here blocks Save or a compile, it
// only tells the operator BEFORE they spend money that the compiler has
// nothing to hold a character (or a product) consistent with across scenes.
//
// A plain word count, not a smarter heuristic (sentence count, a checklist
// of "did you mention hair/clothing"): counting whether specific attributes
// are present would require either a second Claude call (defeating the
// point of a free, instant warning) or a brittle keyword match that gives a
// false "complete" the moment an operator phrases something differently
// than the exact words this file happens to check for. Word count is a
// blunt but honest proxy — five words is never enough detail to hold a
// character together across scenes, and this makes no claim to be more
// precise than that.

/** Number of whitespace-delimited words in `text`. Empty/blank text is 0. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Below this many words, a description is considered too thin to hold a
 * character (or product) consistent across scenes — the compiler will
 * invent the rest, differently, every time it runs. Not derived from any
 * measurement of actual compiler behaviour; picked as a round number well
 * below what it takes to cover clothing + hair + a distinguishing feature +
 * lighting in even the terse, single-sentence style character_desc's own
 * placeholder demonstrates ("A woman in her late 20s with shoulder-length
 * dark hair, wearing a cream linen shirt, standing in a sunlit minimalist
 * kitchen." — 20 words).
 */
export const THIN_DESCRIPTION_WORD_THRESHOLD = 12;

/** True when `text` is under THIN_DESCRIPTION_WORD_THRESHOLD words. */
export function isThinDescription(text: string): boolean {
  return wordCount(text) < THIN_DESCRIPTION_WORD_THRESHOLD;
}
