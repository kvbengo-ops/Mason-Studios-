import { describe, expect, it } from "vitest";
import { tagSuggestAnchor } from "./tag-suggest-anchor";

// A roomy editor with the menu comfortably inside it, so each test below can
// change exactly the one number it is about.
const BOX = {
  caretTop: 100,
  caretLeft: 40,
  caretHeight: 18,
  scrollTop: 0,
  boxWidth: 600,
  boxHeight: 400,
  menuWidth: 240,
  menuHeight: 120,
};

describe("tagSuggestAnchor", () => {
  it("opens just under the tag being typed, not under the field", () => {
    // The whole point of the change: 4px below the caret's own line, at the
    // caret's own column — the old menu was pinned to the bottom of the
    // textarea and could be most of a screen away from the '@'.
    expect(tagSuggestAnchor(BOX)).toEqual({ top: 122, left: 40 });
  });

  it("follows the text when the field is scrolled", () => {
    // The mirror's scrollTop is kept in step with the textarea's, so a caret
    // 100px into the content sits 40px into the box once 60px have scrolled
    // away. Without this the menu would stay where the tag used to be.
    expect(tagSuggestAnchor({ ...BOX, scrollTop: 60 }).top).toBe(62);
  });

  it("keeps the menu inside the right edge for a tag near it", () => {
    // A tag typed at the end of a long line: left-aligning the menu to the
    // caret would put two thirds of it off the page.
    expect(tagSuggestAnchor({ ...BOX, caretLeft: 560 }).left).toBe(360);
  });

  it("does not clamp to a negative left when the menu is wider than the box", () => {
    // A narrow editor on a phone. 0 is the only sane answer; a negative left
    // would push it off the other side instead.
    expect(tagSuggestAnchor({ ...BOX, boxWidth: 180, caretLeft: 40 }).left).toBe(0);
  });

  it("flips above the caret when there is no room below", () => {
    // Caret on the last visible line: below would run past the bottom of the
    // editor and cover the Regenerate button.
    expect(tagSuggestAnchor({ ...BOX, caretTop: 340 }).top).toBe(216);
  });

  it("stays below when there is no room either way", () => {
    // A short box with the caret near its bottom — flipping up would clip the
    // menu against the top of the field, which hides the entries the operator
    // is reaching for. Overlapping downward at least leaves them visible.
    const anchor = tagSuggestAnchor({ ...BOX, boxHeight: 130, caretTop: 100 });
    expect(anchor.top).toBe(122);
  });

  it("puts the first line's menu below, where the box has room", () => {
    // The regression risk in the flip: an over-eager rule would send a
    // first-line tag's menu to a negative top, off the top of the editor.
    expect(tagSuggestAnchor({ ...BOX, caretTop: 0 }).top).toBe(22);
  });
});
