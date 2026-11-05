// Every tag the editor can MAKE, the worker must be able to BIND.
//
// The '@' in a /ugc prompt is how an operator names a reference image, and
// Seedance genuinely resolves tags — BY INDEX. "@image1" is the first entry
// of reference_image_urls, "@image2" the second; there are no custom names.
// So "@lena" is not punctuation and not content: it is a tag the model cannot
// resolve, and dispatch.go's bindUITags rewrites it into the index the array
// actually has.
//
// That leaves two patterns for one concept, in two languages, with nothing
// between them: TAG_PATTERN here decides what the editor treats as a tag,
// uiTagPattern in Go decides what gets bound before the vendor sees it.
// Widen this one — allow a dot, raise the length cap — and the editor starts
// producing tags the worker walks straight past. Nothing would fail loudly:
// the render comes back having ignored a reference the operator believed they
// had attached, and paid for.
//
// THE TWO PATTERNS ARE NOW IDENTICAL, and that is a fix rather than a
// coincidence. Go used to carry a lead group — `(^|[^A-Za-z0-9_@-])@(...)` —
// meant to leave email addresses alone. Consuming that character broke three
// things at once: adjacent tags left a raw '@' behind, a tag after a hyphen
// (a shape the editor's own autocomplete produces) failed to bind at all, and
// the ASCII-only class rewrote "josé@example.com". bindUITags examines the
// lead in code now, without consuming it, so the PATTERN can match the
// editor's exactly.
//
// Which lets this guard assert equality outright — a stronger check than the
// "same name class, different lead" comparison it replaced.
//
// Same shape as render-error-drift.test.ts, and for the same reason: two files
// must agree and no compiler can check it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TAG_PATTERN } from "./elements";

const DISPATCH = fileURLToPath(
  new URL("../../worker/internal/loop/dispatch.go", import.meta.url),
);

/**
 * The Go pattern's source, read out of the `regexp.MustCompile` line rather
 * than hardcoded — a hardcoded copy would drift exactly the way the thing it
 * is guarding drifts, one indirection further away.
 */
function goTagPatternSource(): string {
  const go = readFileSync(DISPATCH, "utf8");
  const match = go.match(/uiTagPattern = regexp\.MustCompile\(`([^`]+)`\)/);
  if (!match?.[1]) {
    throw new Error(
      "Could not find uiTagPattern in worker/internal/loop/dispatch.go. If it was " +
        "renamed or removed, this guard is now checking nothing — fix the regex above " +
        "or delete the guard deliberately, but do not leave it silently matching zero.",
    );
  }
  return match[1];
}


describe("the editor's tag pattern and the worker's binding describe the same name", () => {
  it("is the same pattern the editor uses, character for character", () => {
    // Whole-source equality. The two used to differ deliberately and this
    // compared only the name class; they no longer differ, so anything less
    // than equality would leave room for a difference nobody chose.
    expect(
      goTagPatternSource(),
      "web/lib/elements.ts's TAG_PATTERN and worker dispatch.go's uiTagPattern have " +
        "diverged. If that is deliberate, say which behaviour it buys and go back to " +
        "comparing the name class alone — but a silent difference means the editor can " +
        "make a tag the worker will not bind, so a reference the operator attached is " +
        "absent from the prompt kie resolves.",
    ).toBe(TAG_PATTERN.source);
  });

  it("binds every tag the editor would highlight in a normal prompt", () => {
    // The behavioural half. The class comparison above would survive a
    // rewrite that kept the class and broke the replacement, so this runs
    // both patterns over the same prompts.
    const goPattern = new RegExp(goTagPatternSource(), "g");
    const prompts = [
      "@jen at a counter",
      "123123123fasd @wdd v3",
      "@jen holding @bottle",
      "@jen, smiling.",
      "@a",
      "@jen-2 and @bottle_x",
    ];

    for (const prompt of prompts) {
      const editorTags = Array.from(prompt.matchAll(new RegExp(TAG_PATTERN))).map((m) => m[1]);
      // m[1], not m[2]: the Go pattern lost its lead group when the lead
      // stopped being consumed, so the name is the only capture now — the
      // same group index the editor's pattern uses.
      const boundNames = Array.from(prompt.matchAll(goPattern)).map((m) => m[1]);

      expect(
        boundNames,
        `the editor reads tags ${JSON.stringify(editorTags)} in ${JSON.stringify(prompt)} ` +
          `but the worker would bind ${JSON.stringify(boundNames)} — the difference is a ` +
          "reference the operator attached and kie never sees",
      ).toEqual(editorTags);
    }
  });

  it("agrees on the email case the two used to split over", () => {
    // "hi@example.com" WAS the divergence: the editor matched it and failed
    // to resolve, the worker refused to match at all. Both match it now, and
    // bindUITags decides in code what to do — leaving it alone unless the
    // attached element is genuinely named "example", which is the same call
    // the editor makes. Stated as a test so the agreement is a decision.
    const goPattern = new RegExp(goTagPatternSource(), "g");
    const prompt = "a sign reading hi@example.com";

    expect(Array.from(prompt.matchAll(new RegExp(TAG_PATTERN))).length).toBe(1);
    expect(
      Array.from(prompt.matchAll(goPattern)).length,
      "the worker stopped seeing a token the editor still sees",
    ).toBe(1);
  });
});
