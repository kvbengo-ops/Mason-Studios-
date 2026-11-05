/**
 * Rewriting one @tag inside a prompt, when the element behind it is renamed.
 *
 * WHY THIS HAS TO EXIST AT ALL. Tag substitution is by NAME, at render time:
 * actions/ugc.ts's resolveElementTags looks each written tag up in a map keyed
 * by `elements.name` and pastes in that element's description. So renaming an
 * element does not follow the prompts that already reference it — every one of
 * them keeps the old word, matches nothing, and is stripped of its '@' by the
 * worker before submission. The render still happens. It just quietly stops
 * carrying the reference, which is the failure mode this codebase keeps
 * relearning: nothing errors, so nothing complains.
 *
 * Split out from the action because the interesting part is entirely string
 * behaviour, and the two ways to get it wrong are both invisible in a happy-path
 * test: matching a PREFIX (renaming @lena must not touch @lena_ref) and
 * matching a SUBSTRING (it must not touch an email address or a word that
 * merely contains the name).
 */

/**
 * `TAG_PATTERN`'s own character class, as a lookahead-safe boundary: a tag ends
 * where a character that cannot be part of one begins. Kept here rather than
 * imported so the two cannot drift apart silently — if lib/elements.ts widens
 * what a tag may contain, this file's own test fails.
 */
const TAG_CHAR = "[A-Za-z0-9_-]";

/** Escapes a name for use inside a RegExp — names allow `-`, which is a range operator in a class. */
function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * Replaces every `@from` in `prompt` with `@to`, and nothing else.
 *
 * Case-insensitive, matching findElementByTag: `elements.name` has no enforced
 * case and "@Jen" resolves the same element as "@jen", so a rename has to
 * catch both or leave half the prompts broken.
 */
export function renameTagInPrompt(prompt: string, from: string, to: string): string {
  // (?<![A-Za-z0-9_-]) is NOT needed on the left — the '@' already anchors it,
  // and a tag cannot start mid-word. The right-hand lookahead is what stops
  // "@lena" from eating the front of "@lena_ref".
  const pattern = new RegExp(`@${escape(from)}(?!${TAG_CHAR})`, "gi");
  return prompt.replace(pattern, `@${to}`);
}

export function removeTagFromPrompt(prompt: string, name: string): string {
  const pattern = new RegExp(`@${escape(name)}(?!${TAG_CHAR})`, "gi");
  return prompt
    .replace(pattern, "")
    .replace(/[ \t]+([,.;!?])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** Whether a rename would change this prompt at all — used to skip writes. */
export function promptMentionsTag(prompt: string, name: string): boolean {
  return new RegExp(`@${escape(name)}(?!${TAG_CHAR})`, "i").test(prompt);
}
