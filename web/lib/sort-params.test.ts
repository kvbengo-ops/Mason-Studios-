import { describe, expect, it } from "vitest";
import { parseSort, toggleDirection } from "./sort-params";

const COLUMNS = ["email", "username", "joined", "spend"] as const;
const DEFAULT = { column: "joined", direction: "desc" } as const;

describe("parseSort", () => {
  it("parses a valid column and direction", () => {
    expect(parseSort(COLUMNS, DEFAULT, "spend", "asc")).toEqual({
      column: "spend",
      direction: "asc",
    });
  });

  it("falls back to the default column for an unknown value", () => {
    expect(parseSort(COLUMNS, DEFAULT, "drop_table", "asc")).toEqual({
      column: "joined",
      direction: "asc",
    });
  });

  it("falls back to the default direction for anything other than asc/desc", () => {
    expect(parseSort(COLUMNS, DEFAULT, "spend", "DESC")).toEqual({
      column: "spend",
      direction: "desc",
    });
    expect(parseSort(COLUMNS, DEFAULT, "spend", undefined)).toEqual({
      column: "spend",
      direction: "desc",
    });
  });

  it("falls back to the full default when both params are missing", () => {
    expect(parseSort(COLUMNS, DEFAULT, undefined, undefined)).toEqual(DEFAULT);
  });

  it("takes the first value when Next hands back an array (repeated query key)", () => {
    expect(parseSort(COLUMNS, DEFAULT, ["spend", "email"], ["asc", "desc"])).toEqual({
      column: "spend",
      direction: "asc",
    });
  });
});

describe("toggleDirection", () => {
  it("flips asc to desc", () => {
    expect(toggleDirection("asc")).toBe("desc");
  });

  it("flips desc to asc", () => {
    expect(toggleDirection("desc")).toBe("asc");
  });
});
