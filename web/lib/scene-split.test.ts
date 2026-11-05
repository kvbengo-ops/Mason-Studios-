import { describe, expect, it } from "vitest";
import { splitScriptLine } from "./scene-split";

describe("splitScriptLine", () => {
  it("splits at the sentence boundary nearest the midpoint", () => {
    // Two sentences, deliberately uneven in length — the naive "cut it in
    // half by character count" approach would land inside "morning", not
    // at the period.
    const [first, second] = splitScriptLine(
      "Ever feel like your mornings are a race against the clock? That's why we built this.",
    );
    expect(first).toBe("Ever feel like your mornings are a race against the clock?");
    expect(second).toBe("That's why we built this.");
  });

  it("picks the boundary nearest the midpoint when more than two sentences are present", () => {
    const [first, second] = splitScriptLine(
      "One scoop. Cold water. Done. No blender, no mess, no excuses whatsoever today.",
    );
    // Of the three sentence boundaries in this line, the one after "Done."
    // sits closest to the character midpoint of the full 81-char line — not
    // the first boundary encountered and not the last.
    expect(first).toBe("One scoop. Cold water. Done.");
    expect(second).toBe("No blender, no mess, no excuses whatsoever today.");
  });

  it("falls back to a word boundary when the line has no internal sentence punctuation", () => {
    const [first, second] = splitScriptLine(
      "your first order ships completely free this entire week no matter what",
    );
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    // Reassembling (with the single space the split consumed) must recover
    // the original line — no words dropped or duplicated.
    expect(`${first} ${second}`).toBe(
      "your first order ships completely free this entire week no matter what",
    );
  });

  it("trims surrounding whitespace on both halves", () => {
    const [first, second] = splitScriptLine("  Hello there.   Ships free today.  ");
    expect(first).toBe("Hello there.");
    expect(second).toBe("Ships free today.");
  });

  it("returns an empty second half for a single word, so the caller can refuse the split", () => {
    // A caller (splitScene) must treat an empty half as "too short to
    // split" rather than create a scene with no dialogue — this pins the
    // exact degenerate shape that guard checks for.
    const [first, second] = splitScriptLine("Seranova");
    expect(first).toBe("Seranova");
    expect(second).toBe("");
  });

  it("returns two empty strings for an empty line", () => {
    expect(splitScriptLine("")).toEqual(["", ""]);
  });
});
