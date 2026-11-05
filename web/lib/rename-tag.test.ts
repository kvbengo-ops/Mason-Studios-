import { describe, expect, it } from "vitest";
import { promptMentionsTag, renameTagInPrompt } from "./rename-tag";

// What a rename must and must not touch. Both failures are silent in
// production: a missed tag stops steering the render, and an over-eager one
// repoints a DIFFERENT reference at the wrong picture.
describe("renameTagInPrompt", () => {
  it("rewrites the tag it was asked to rewrite", () => {
    expect(renameTagInPrompt("Subject Lock — @new1 holds the mug.", "new1", "lena")).toBe(
      "Subject Lock — @lena holds the mug.",
    );
  });

  it("rewrites every occurrence, not just the first", () => {
    expect(renameTagInPrompt("@new1 lifts it, then @new1 sets it down.", "new1", "lena")).toBe(
      "@lena lifts it, then @lena sets it down.",
    );
  });

  it("does not eat the front of a longer tag", () => {
    // The one that matters most here: this operator really does have @lena,
    // @lena_ref and @lena_ref1 side by side. A prefix match would repoint two
    // of them at the third's picture.
    expect(renameTagInPrompt("@lena and @lena_ref and @lena_ref1", "lena", "jen")).toBe(
      "@jen and @lena_ref and @lena_ref1",
    );
  });

  it("does not touch the name where it appears without an @", () => {
    expect(renameTagInPrompt("lena walks in. @lena lifts the mug.", "lena", "jen")).toBe(
      "lena walks in. @jen lifts the mug.",
    );
  });

  it("matches case-insensitively, because tag lookup does", () => {
    // findElementByTag resolves "@Jen" to the element named "jen" — the unique
    // index is on the raw column, not lower(name). A case-sensitive rename
    // would leave exactly the prompts that already work today behind.
    expect(renameTagInPrompt("@Lena and @lena", "lena", "jen")).toBe("@jen and @jen");
  });

  it("survives a name containing a hyphen", () => {
    // '-' is a range operator inside a character class; unescaped, this throws
    // or silently matches the wrong thing.
    expect(renameTagInPrompt("@my-ref stands there", "my-ref", "lena")).toBe("@lena stands there");
  });

  it("leaves a prompt that never mentioned it exactly as it was", () => {
    const prompt = "A woman at a kitchen counter, @other in frame.";
    expect(renameTagInPrompt(prompt, "new1", "lena")).toBe(prompt);
  });
});

describe("promptMentionsTag", () => {
  it("is true only for a whole tag", () => {
    expect(promptMentionsTag("@lena holds it", "lena")).toBe(true);
    expect(promptMentionsTag("@lena_ref holds it", "lena")).toBe(false);
    expect(promptMentionsTag("lena holds it", "lena")).toBe(false);
  });

  it("agrees with renameTagInPrompt about case", () => {
    expect(promptMentionsTag("@LENA holds it", "lena")).toBe(true);
  });
});
