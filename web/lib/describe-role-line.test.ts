import { describe, expect, it } from "vitest";
import { describeRoleLine } from "./describe-role-line";

describe("describeRoleLine", () => {
  // THE REGRESSION. Both describe vendors hard-coded "a", and since 0081 the
  // only two categories an upload can actually produce both begin with a
  // vowel — so every picture and every clip in production carried an
  // ungrammatical steer into a paid prompt.
  it("uses 'an' before the two categories every upload actually writes today", () => {
    expect(describeRoleLine("image")).toBe("This is saved as an image reference. ");
    expect(describeRoleLine("audio")).toBe("This is saved as an audio reference. ");
  });

  // The four subject words the CHECK has admitted since 0073. These are what
  // the column holds again if the category goes back to naming a subject, so
  // they are pinned here rather than left to be discovered later.
  it("uses 'a' before every consonant-initial category", () => {
    expect(describeRoleLine("character")).toBe("This is saved as a character reference. ");
    expect(describeRoleLine("product")).toBe("This is saved as a product reference. ");
    expect(describeRoleLine("location")).toBe("This is saved as a location reference. ");
    expect(describeRoleLine("voice")).toBe("This is saved as a voice reference. ");
  });

  // Preserves what both call sites already did with `args.category ? ... : ""`.
  // An element with no category must say NOTHING — not "This is saved as a
  // reference", which is a sentence that spends instruction on no information.
  it("returns an empty string rather than a contentless sentence", () => {
    expect(describeRoleLine(null)).toBe("");
    expect(describeRoleLine(undefined)).toBe("");
    expect(describeRoleLine("")).toBe("");
    expect(describeRoleLine("   ")).toBe("");
  });

  // The trailing space is load-bearing: both callers concatenate this
  // directly onto the next sentence of the instruction.
  it("ends with the separating space its callers depend on", () => {
    expect(describeRoleLine("voice").endsWith("reference. ")).toBe(true);
  });
});
