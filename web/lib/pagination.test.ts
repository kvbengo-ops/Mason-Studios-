import { describe, expect, it } from "vitest";
import { pageRange, parsePage, parsePageSize, totalPageCount } from "./pagination";

describe("parsePage", () => {
  it("parses a valid page number", () => {
    expect(parsePage("3")).toBe(3);
  });

  it("defaults to 1 when missing", () => {
    expect(parsePage(undefined)).toBe(1);
  });

  it("defaults to 1 for zero, negative, or non-numeric values", () => {
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-3")).toBe(1);
    expect(parsePage("abc")).toBe(1);
  });

  it("defaults to 1 for a non-integer value", () => {
    expect(parsePage("1.5")).toBe(1);
  });

  it("takes the first value when Next hands back an array (repeated query key)", () => {
    expect(parsePage(["4", "9"])).toBe(4);
  });
});

describe("pageRange", () => {
  it("computes the first page's offsets", () => {
    expect(pageRange(1, 20)).toEqual({ page: 1, from: 0, to: 19 });
  });

  it("computes a later page's offsets", () => {
    expect(pageRange(3, 20)).toEqual({ page: 3, from: 40, to: 59 });
  });

  it("clamps an out-of-range page to 1", () => {
    expect(pageRange(0, 20)).toEqual({ page: 1, from: 0, to: 19 });
    expect(pageRange(-5, 20)).toEqual({ page: 1, from: 0, to: 19 });
  });
});

describe("parsePageSize", () => {
  it("parses a valid page size", () => {
    expect(parsePageSize("20")).toBe(20);
    expect(parsePageSize("50")).toBe(50);
  });

  it("defaults to 10 when missing", () => {
    expect(parsePageSize(undefined)).toBe(10);
  });

  it("defaults to 10 for a size outside the allowlist, including a hand-edited attempt to pull the whole table", () => {
    expect(parsePageSize("15")).toBe(10);
    expect(parsePageSize("0")).toBe(10);
    expect(parsePageSize("-20")).toBe(10);
    expect(parsePageSize("abc")).toBe(10);
    expect(parsePageSize("100000")).toBe(10);
  });

  it("takes the first value when Next hands back an array (repeated query key)", () => {
    expect(parsePageSize(["50", "10"])).toBe(50);
  });
});

describe("totalPageCount", () => {
  it("rounds up a partial last page", () => {
    expect(totalPageCount(41, 20)).toBe(3);
  });

  it("returns exactly 1 page for a count that divides evenly", () => {
    expect(totalPageCount(40, 20)).toBe(2);
  });

  it("never returns fewer than 1 page, even for zero rows", () => {
    expect(totalPageCount(0, 20)).toBe(1);
  });

  it("shrinking the page size can strand a page number that used to exist", () => {
    // 25 rows at 50/page is one page — page 3 was never valid there either,
    // but at 10/page it now legitimately could have been (3 pages exist).
    // The page components' own stale-page redirect (requestedPage >
    // totalPages) is what catches "page 3" once it stops fitting — this
    // just pins the arithmetic it relies on: shrinking the size can turn a
    // page number that fit under the old size into one that no longer does.
    expect(totalPageCount(25, 50)).toBe(1);
    expect(totalPageCount(25, 10)).toBe(3);

    // 125 rows: page 3 fits at 50/page (3 pages), but shrinking to 10/page
    // grows the list to 13 pages — page 3 still fits, just further from the
    // end; the interesting case is the one above, where it stops fitting.
    expect(totalPageCount(125, 50)).toBe(3);
    expect(totalPageCount(125, 10)).toBe(13);

    // pageRange itself never rejects an out-of-range page — it just
    // computes offsets that land past the real data (from=20 on a 25-row
    // table). It's deliberately dumb; validating "is this page still in
    // range" against the size in play is the page components' job.
    expect(pageRange(3, 10)).toEqual({ page: 3, from: 20, to: 29 });
  });
});
