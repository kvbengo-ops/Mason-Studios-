import { describe, expect, it } from "vitest";
import { assertHasCharacter } from "./compile-guard";

describe("assertHasCharacter", () => {
  it("allows a typed character description with no reference photo", () => {
    expect(() => assertHasCharacter(true, false)).not.toThrow();
  });

  it("allows both a description and a reference photo", () => {
    expect(() => assertHasCharacter(true, true)).not.toThrow();
  });

  // The gap this guard closes: a project with neither previously compiled
  // fine, producing scenes whose reference frames had nothing to condition
  // on.
  it("refuses when neither a description nor a reference photo is set", () => {
    expect(() => assertHasCharacter(false, false)).toThrow(
      /character description|reference photo/i,
    );
  });

  // The wrong-person defect this guard now closes: a photo-only compile
  // used to be accepted, which let lib/claude.ts's compileBrief invent its
  // own character description from the script while frame generation
  // conditioned on the real uploaded photo — two different people in the
  // same ad. See this function's doc comment for the full mechanism.
  it("refuses an uploaded reference photo with no typed description", () => {
    expect(() => assertHasCharacter(false, true)).toThrow(/description/i);
  });
});
