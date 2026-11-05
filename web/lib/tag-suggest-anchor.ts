/**
 * Where the @tag suggestion menu goes.
 *
 * It used to hang off the bottom of the whole textarea (`inset-x-0 top-full`),
 * which is why it could open half a page away from the tag being typed and as
 * wide as the editor. This puts it under the caret instead, and the numbers it
 * needs all come from the highlight mirror: that layer already renders the same
 * string at the same metrics as the textarea, so a marker span placed at the
 * '@' sits exactly where the '@' is drawn.
 *
 * Kept out of the component because all three interesting cases are arithmetic
 * — a tag near the right edge, a tag on the last visible line, and a scrolled
 * textarea — and none of them are reachable in jsdom, where every offset is 0.
 */

/** Gap between the caret's line and the menu, in px. */
const GAP = 4;

export interface TagSuggestAnchorInput {
  /** Marker offsets within the mirror (its offsetParent). */
  caretTop: number;
  caretLeft: number;
  /** The marker's own height — one line at the editor's metrics. */
  caretHeight: number;
  /** How far the textarea is scrolled; the mirror is kept in step with it. */
  scrollTop: number;
  /** The editor box the menu is positioned inside. */
  boxWidth: number;
  boxHeight: number;
  menuWidth: number;
  menuHeight: number;
}

export interface TagSuggestAnchor {
  top: number;
  left: number;
}

export function tagSuggestAnchor(input: TagSuggestAnchorInput): TagSuggestAnchor {
  // Never past the right edge: a menu that opens off-screen is worse than one
  // that opens a few characters to the left of its tag. Math.max(0, …) matters
  // when the box is narrower than the menu — the clamp must not go negative.
  const maxLeft = Math.max(0, input.boxWidth - input.menuWidth);
  const left = Math.min(Math.max(input.caretLeft, 0), maxLeft);

  const lineTop = input.caretTop - input.scrollTop;
  const below = lineTop + input.caretHeight + GAP;
  const above = lineTop - GAP - input.menuHeight;

  // Below the caret unless that runs past the bottom of the editor AND there
  // is genuinely room above. A tag on the last line of a short box has neither,
  // and then below is still the better of two bad options: it overlaps the
  // button rather than the text being typed.
  if (below + input.menuHeight > input.boxHeight && above >= 0) return { top: above, left };
  return { top: below, left };
}
