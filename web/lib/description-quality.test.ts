import { describe, expect, it } from "vitest";
import {
  isThinDescription,
  THIN_DESCRIPTION_WORD_THRESHOLD,
  wordCount,
} from "./description-quality";

describe("wordCount", () => {
  it("counts whitespace-delimited words", () => {
    expect(wordCount("an athletic woman")).toBe(3);
  });

  it("is 0 for empty or whitespace-only text", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("   \n\t  ")).toBe(0);
  });

  it("collapses runs of whitespace instead of counting empty tokens", () => {
    expect(wordCount("one   two\n\nthree")).toBe(3);
  });
});

describe("isThinDescription", () => {
  it("flags the exact incident description as too thin", () => {
    // The reported incident: this was the WHOLE character description.
    expect(isThinDescription("an athletic woman")).toBe(true);
  });

  it("does not flag a description at or above the threshold", () => {
    const rich =
      "A woman in her late 20s with shoulder-length dark hair, wearing a cream linen shirt, " +
      "standing in a sunlit minimalist kitchen.";
    expect(wordCount(rich)).toBeGreaterThanOrEqual(THIN_DESCRIPTION_WORD_THRESHOLD);
    expect(isThinDescription(rich)).toBe(false);
  });

  it("sits exactly on the threshold boundary correctly", () => {
    const exact = Array.from({ length: THIN_DESCRIPTION_WORD_THRESHOLD }, () => "word").join(" ");
    const oneShort = Array.from({ length: THIN_DESCRIPTION_WORD_THRESHOLD - 1 }, () => "word").join(
      " ",
    );
    expect(isThinDescription(exact)).toBe(false);
    expect(isThinDescription(oneShort)).toBe(true);
  });
});
