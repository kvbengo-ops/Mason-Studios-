// "@lena_ref" in a clip prompt, the element's saved description out.
//
// A template literal, not a model: the operator writes `@lena_ref` the way
// JavaScript writes `${lena_ref}`, and this pastes in the text the element
// already carries. The one AI step happens once, when the element is saved
// and its picture is described — every prompt after that is string
// replacement, so there is nothing left to fail at render time.
//
// It lives here rather than in actions/ugc.ts because that file is "use
// server": every export there must be an async server action, which a pure
// function used by a test is not.

/**
 * A tag is "@" plus a name. The name shape matches elements.name and the
 * worker's own uiTagPattern (worker/internal/loop/dispatch.go) so both sides
 * agree on where a tag ends — a disagreement there is how "@jen@bottle" and
 * "wide-@jen" went wrong before.
 */
export const ELEMENT_TAG = /@([A-Za-z0-9][A-Za-z0-9_-]{0,63})/g;

/**
 * True when the character before a "@" is a letter or digit.
 *
 * Almost always an email address, and an address the operator typed is left
 * exactly as written: substituting into "jose@example.com" because an element
 * happens to be named "example" would corrupt text that was never a tag.
 */
export function tagLeadIsWordish(prompt: string, at: number): boolean {
  if (at === 0) return false;
  return /[A-Za-z0-9]/.test(prompt.charAt(at - 1));
}

/**
 * Replaces every resolvable "@name" with its description.
 *
 * `byName` is keyed by LOWERCASED element name, because the editor resolves
 * tags case-insensitively — "@Lena_ref" and "@lena_ref" are one element.
 *
 * An unresolved tag is LEFT AS WRITTEN. The worker's bindUITags strips the
 * surviving "@" before submitting, so it degrades to a bare word rather than
 * a token the video model would try to read as a name.
 */
export function substituteElementTags(prompt: string, byName: Map<string, string>): string {
  if (!prompt.includes("@") || byName.size === 0) return prompt;

  return prompt.replace(ELEMENT_TAG, (whole, name: string, at: number) => {
    if (tagLeadIsWordish(prompt, at)) return whole;
    return byName.get(name.toLowerCase()) ?? whole;
  });
}

/**
 * Voice tags get a name, not a paste.
 *
 * substituteElementTags above pastes a description into EVERY occurrence of
 * a tag, which is fine for a tag written once. It is a disaster for a voice
 * tag, which operators reuse as an ordinary noun: a real render on
 * 2026-08-30 had one operator write "@Audio_5" four times — "driven by
 * @Audio_5", "the @Audio_5 waveform", "sourced entirely from @Audio_5",
 * "besides the @Audio_5 dialogue track" — and each one got the same
 * ~200-character voice description pasted in, growing a 2310-character
 * prompt to 5463 and producing sentences like "generated entirely from the
 * A young adult female voice with a clear, bright timbre...". The sentence
 * wanted a short NAME and was handed a paragraph, four times over.
 *
 * The fix: write the description ONCE, in a declaration line ahead of the
 * operator's prose — "TagName is <description>." — and turn every mention
 * in the prose into the bare canonical name with no "@". The model reads
 * the declaration, then follows the name through the rest of the prompt the
 * way it would follow any noun it was introduced to.
 *
 * `byName` carries only tags worth declaring — i.e. an element WITH a
 * description. A tag absent from `byName` is left exactly as written,
 * "@" included: that is what lets the worker's bindUITags
 * (worker/internal/loop/dispatch.go) still strip it before submitting. Its
 * doc comment records why an undeclared bare name is worse than the tag it
 * replaces — "a name for something already sent by another route entirely,
 * sitting in the prose as scene direction" — and a declaration is precisely
 * what earns the bare name here. Without one, deleting the tag is correct.
 *
 * Declarations are emitted once per element, in the order it is first
 * mentioned, not once per occurrence — a name declared four times would
 * recreate the exact duplication this function exists to remove.
 */
export function declareAudioTags(
  prompt: string,
  byName: Map<string, { name: string; description: string }>,
): string {
  if (!prompt.includes("@") || byName.size === 0) return prompt;

  const declared: string[] = [];
  const seenNames = new Set<string>();
  const body = prompt.replace(ELEMENT_TAG, (whole, name: string, at: number) => {
    if (tagLeadIsWordish(prompt, at)) return whole;
    const entry = byName.get(name.toLowerCase());
    if (!entry) return whole;
    if (!seenNames.has(entry.name)) {
      seenNames.add(entry.name);
      declared.push(`${entry.name} is ${entry.description}.`);
    }
    return entry.name;
  });

  if (declared.length === 0) return body;
  return `${declared.join("\n")}\n\n${body}`;
}

/**
 * Every distinct tag name in the prompt, lowercased, in the order they FIRST
 * appear — which is the order their pictures are handed to the vendor.
 *
 * Order is the whole point. reference_image_urls is a positional array, so
 * element 0 is what a prompt would call "@image1". Reading the tags in
 * writing order means the operator's own sequence — character first, then
 * the product they are holding — is the sequence the model receives, rather
 * than whatever order a database happened to return rows in.
 *
 * A name repeated later in the prompt keeps its first position and is not
 * added twice: it is one picture, named twice.
 */
export function tagsInOrder(prompt: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of prompt.matchAll(ELEMENT_TAG)) {
    const at = match.index ?? 0;
    if (tagLeadIsWordish(prompt, at)) continue;
    const name = (match[1] ?? "").toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * The text an element contributes, or "" when it has none to give.
 *
 * The hand-written description wins over the generated one: the operator
 * edited it precisely because the model's account was not what they wanted,
 * and silently preferring the model's would undo that edit.
 */
export function descriptionFor(element: {
  description?: string | null;
  ai_description?: string | null;
}): string {
  return (element.description ?? "").trim() || (element.ai_description ?? "").trim();
}
