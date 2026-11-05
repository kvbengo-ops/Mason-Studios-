// The one sentence that tells a describe model what KIND of reference it is
// looking at (or listening to), shared by both describe vendors.
//
// WHY THIS IS ITS OWN FILE. The line was written twice, identically, in
// lib/claude.ts and lib/kie-audio-describe.ts:
//
//     const roleLine = args.category ? `This is saved as a ${category} reference. ` : "";
//
// Two copies of a sentence that goes into a paid vendor prompt is two places
// to fix and one to forget. It is also the only part of either instruction
// that varies per element, which makes it the part worth pinning in a test —
// and a pure function can be tested without standing up an Anthropic client
// or a fetch seam.
//
// WHY THE ARTICLE IS COMPUTED. Both copies hard-coded "a". Since 0081 the
// category values an operator can actually produce are 'image' and 'audio',
// so what production has been sending is:
//
//     "This is saved as a image reference. "     -> Anthropic, every picture
//     "This is saved as a audio reference. "     -> api.kie.ai, every clip
//
// Neither is English. This is not merely cosmetic in the way a typo in a
// comment is: the string is a text part in a request body to a language
// model, and it is the whole of the steer. lib/claude.ts's system prompt
// branches three ways on the subject — "For a person... For a product...
// For a place..." — and this sentence is the only thing that selects one.
//
// The vowel test is deliberately the naive one. This serves a CHECK-constrained
// vocabulary, not free text, so the cases English gets interesting about — a
// silent h ("an hour"), a consonant-sounding vowel ("a unicorn") — cannot
// arrive here. If the constraint ever admits such a word, this is the file
// that has to learn about it, which is the other half of why it is not two
// inline ternaries.

/** "an" before a vowel, "a" otherwise. See this file's header on the naivety. */
function articleFor(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/**
 * The role sentence for a describe prompt, ready to be prepended.
 *
 * Returns "" for a missing or blank category — an element that carries no
 * category says nothing rather than saying something empty, which is what
 * both call sites already did with their `args.category ? ... : ""`.
 *
 * The trailing space is part of the return value, because both callers
 * concatenate straight onto the next sentence.
 */
export function describeRoleLine(category: string | null | undefined): string {
  const word = (category ?? "").trim();
  if (!word) return "";
  return `This is saved as ${articleFor(word)} ${word} reference. `;
}
