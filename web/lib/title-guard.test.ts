import { describe, expect, it } from "vitest";
import {
  EMPTY_TITLE_MESSAGE,
  MAX_TITLE_LENGTH,
  requireTitle,
  TITLE_TOO_LONG_MESSAGE,
} from "./title-guard";

describe("requireTitle", () => {
  it("accepts a non-empty title and trims it", () => {
    expect(requireTitle("  Q4 Launch  ")).toEqual({ title: "Q4 Launch" });
  });

  it("refuses a missing value", () => {
    expect(requireTitle(null)).toEqual({ error: EMPTY_TITLE_MESSAGE });
  });

  it("refuses an empty string", () => {
    expect(requireTitle("")).toEqual({ error: EMPTY_TITLE_MESSAGE });
  });

  it("refuses a whitespace-only string", () => {
    expect(requireTitle("   \n\t  ")).toEqual({ error: EMPTY_TITLE_MESSAGE });
  });

  it("refuses a non-string FormData value (e.g. a File)", () => {
    expect(requireTitle(new File(["x"], "title.txt"))).toEqual({ error: EMPTY_TITLE_MESSAGE });
  });

  it("accepts a title at exactly the maximum length", () => {
    const title = "a".repeat(MAX_TITLE_LENGTH);
    expect(requireTitle(title)).toEqual({ title });
  });

  it("refuses a title one character over the maximum length", () => {
    const title = "a".repeat(MAX_TITLE_LENGTH + 1);
    expect(requireTitle(title)).toEqual({ error: TITLE_TOO_LONG_MESSAGE(MAX_TITLE_LENGTH + 1) });
  });

  it("measures the maximum length after trimming, not before", () => {
    const title = `  ${"a".repeat(MAX_TITLE_LENGTH)}  `;
    expect(requireTitle(title)).toEqual({ title: "a".repeat(MAX_TITLE_LENGTH) });
  });
});
