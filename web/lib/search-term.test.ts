import { describe, expect, it } from "vitest";
import { buildIlikeOrFilter, sanitizeSearchTerm } from "./search-term";

describe("sanitizeSearchTerm", () => {
  it("passes an ordinary term through unchanged", () => {
    expect(sanitizeSearchTerm("NeuroBlast")).toBe("NeuroBlast");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeSearchTerm("  wide shot  ")).toBe("wide shot");
  });

  it("strips commas and parentheses, which are meaningful to PostgREST's .or() grammar", () => {
    expect(sanitizeSearchTerm("Metabolae, Inc. (2026)")).toBe("Metabolae Inc. 2026");
  });

  it("reduces a punctuation-only term to an empty string", () => {
    expect(sanitizeSearchTerm(",(),")).toBe("");
  });
});

describe("buildIlikeOrFilter", () => {
  it("builds one ilike clause per column, wrapped in %...%", () => {
    expect(buildIlikeOrFilter(["title", "product_name"], "smn16")).toBe(
      "title.ilike.%smn16%,product_name.ilike.%smn16%",
    );
  });

  it("returns null for an empty term", () => {
    expect(buildIlikeOrFilter(["title"], "")).toBeNull();
  });

  it("returns null for a whitespace/punctuation-only term", () => {
    expect(buildIlikeOrFilter(["title"], "  (),  ")).toBeNull();
  });

  it("sanitizes the term before interpolating it into the filter string", () => {
    expect(buildIlikeOrFilter(["title"], "a,b")).toBe("title.ilike.%ab%");
  });
});
