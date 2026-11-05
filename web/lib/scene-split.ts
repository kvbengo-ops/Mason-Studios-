// Pure helper for the Split scene-surgery control (spec §3.5: `Split` ·
// `+ Below` · `✕ Delete`, "full scene-list surgery"). Kept dependency-free,
// like lib/scene-order.ts, so the one genuinely interesting decision here —
// how one script line divides into two an editor can shoot separately — is
// unit-testable without a database or a Claude call.

/**
 * Divides one script line into two halves. Splits at the sentence boundary
 * nearest the character midpoint rather than at a fixed word or character
 * count: punctuation the writer already put in the line marks a real
 * thought-boundary, and a scene that "tries to carry too much" (the reason
 * an editor reaches for Split) is almost always two sentences doing two
 * jobs, not one sentence that happens to be long. Falls back to the nearest
 * word boundary to the midpoint when the line has no internal sentence
 * punctuation to prefer, so a single long sentence still splits somewhere
 * that isn't mid-word.
 *
 * Returns the two halves trimmed; a caller that gets an empty half back
 * (a line too short to meaningfully divide) should refuse the split rather
 * than create a scene with no dialogue.
 */
export function splitScriptLine(line: string): [first: string, second: string] {
  const trimmed = line.trim();

  const sentenceBoundaries: number[] = [];
  const sentenceEnd = /[.!?]+\s+/g;
  for (const match of trimmed.matchAll(sentenceEnd)) {
    sentenceBoundaries.push(match.index + match[0].length);
  }

  const midpoint = trimmed.length / 2;

  if (sentenceBoundaries.length > 0) {
    const nearest = sentenceBoundaries.reduce((closest, candidate) =>
      Math.abs(candidate - midpoint) < Math.abs(closest - midpoint) ? candidate : closest,
    );
    return [trimmed.slice(0, nearest).trim(), trimmed.slice(nearest).trim()];
  }

  // No sentence punctuation to split on — find the space nearest the
  // midpoint instead, preferring the next space forward and falling back to
  // the previous one so a single-word line (no spaces at all) still returns
  // something rather than throwing.
  let cut = trimmed.indexOf(" ", Math.round(midpoint));
  if (cut === -1) cut = trimmed.lastIndexOf(" ", Math.round(midpoint));
  if (cut === -1) cut = trimmed.length;
  return [trimmed.slice(0, cut).trim(), trimmed.slice(cut).trim()];
}
