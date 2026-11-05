import { describe, expect, it } from "vitest";
import {
  declareAudioTags,
  descriptionFor,
  substituteElementTags,
  tagsInOrder,
} from "./element-tags";

const LENA = "a woman in her thirties with shoulder-length blonde hair";
const MUG = "a plain white ceramic mug";

function elements(): Map<string, string> {
  return new Map([
    ["lena_ref", LENA],
    ["mug", MUG],
  ]);
}

describe("substituteElementTags", () => {
  it("replaces a tag with the element's description", () => {
    expect(substituteElementTags("Frame Map: @lena_ref", elements())).toBe(`Frame Map: ${LENA}`);
  });

  // The operator's own prompt named the same element twice — once in the
  // frame map and again in the subject lock. Replacing only the first would
  // leave the second as a bare word after the worker strips its '@', which
  // reads as a typo in the middle of the scene direction.
  it("replaces every occurrence, not just the first", () => {
    const out = substituteElementTags("@lena_ref sits. Subject Lock — @lena_ref", elements());
    expect(out).toBe(`${LENA} sits. Subject Lock — ${LENA}`);
    expect(out).not.toContain("@");
  });

  it("resolves case-insensitively, the way the editor does", () => {
    expect(substituteElementTags("@Lena_Ref", elements())).toBe(LENA);
  });

  it("handles several different tags in one prompt", () => {
    expect(substituteElementTags("@lena_ref holds @mug", elements())).toBe(`${LENA} holds ${MUG}`);
  });

  // Left as written on purpose: the worker's bindUITags strips the '@' before
  // submitting, so an unknown tag degrades to a bare word. Substituting
  // nothing here is what lets that happen instead of erroring the render.
  it("leaves an unknown tag alone", () => {
    expect(substituteElementTags("@nobody is here", elements())).toBe("@nobody is here");
  });

  it("leaves an email address alone", () => {
    expect(substituteElementTags("mail jose@mug.com", elements())).toBe("mail jose@mug.com");
  });

  // The autocomplete produces this shape, and the worker binds it, so the two
  // sides have to agree that the tag starts at the '@' and not at the hyphen.
  it("substitutes a tag that follows a hyphen", () => {
    expect(substituteElementTags("wide-@mug", elements())).toBe(`wide-${MUG}`);
  });

  it("returns the prompt untouched when it has no tags", () => {
    expect(substituteElementTags("a quiet kitchen", elements())).toBe("a quiet kitchen");
  });

  it("returns the prompt untouched when nothing is saved", () => {
    expect(substituteElementTags("@lena_ref", new Map())).toBe("@lena_ref");
  });
});

describe("descriptionFor", () => {
  it("prefers the operator's own description over the generated one", () => {
    expect(descriptionFor({ description: "hers", ai_description: "the model's" })).toBe("hers");
  });

  it("falls back to the generated description", () => {
    expect(descriptionFor({ description: null, ai_description: "the model's" })).toBe("the model's");
  });

  // Whitespace is not an edit. A description cleared to spaces should fall
  // through to the generated text rather than substituting an empty string
  // and deleting the reference from the prompt entirely.
  it("treats a blank description as absent", () => {
    expect(descriptionFor({ description: "   ", ai_description: "the model's" })).toBe(
      "the model's",
    );
  });

  it("returns empty when the element has nothing to give", () => {
    expect(descriptionFor({ description: null, ai_description: null })).toBe("");
  });
});

describe("tagsInOrder", () => {
  it("returns tags in the order they are written", () => {
    expect(tagsInOrder("@lena holds @mug beside @lamp")).toEqual(["lena", "mug", "lamp"]);
  });

  // Order is positional on the wire: ordinal 1 becomes reference_image_urls[0].
  // A name written twice is one picture, and must not take two slots.
  it("keeps a repeated tag at its first position, once", () => {
    expect(tagsInOrder("@lena sits. Subject Lock \u2014 @lena. @mug on the counter")).toEqual([
      "lena",
      "mug",
    ]);
  });

  it("lowercases, so @Lena and @lena are one element", () => {
    expect(tagsInOrder("@Lena and @lena")).toEqual(["lena"]);
  });

  it("skips an email address", () => {
    expect(tagsInOrder("mail jose@mug.com about @lena")).toEqual(["lena"]);
  });

  it("returns nothing for a prompt with no tags", () => {
    expect(tagsInOrder("a quiet kitchen")).toEqual([]);
  });
});

describe("declareAudioTags", () => {
  const VOICE = "A young adult female voice with a clear, bright timbre and a standard " +
    "German accent, Spoken with a gentle, conversational tone at a moderate pace, " +
    "exhibiting clean articulation and soft vocal warmth";

  function audio(): Map<string, { name: string; description: string }> {
    return new Map([["audio_5", { name: "Audio_5", description: VOICE }]]);
  }

  // The regression test for the 2026-08-30 render: a voice tag used four
  // times used to paste this same ~200-character paragraph four times,
  // growing a 2310-character prompt to 5463. Against today's code this must
  // fail, because substituteElementTags (the old path) pastes at every
  // occurrence with no declaration at all.
  it("declares a four-times-used voice tag once and leaves four bare names", () => {
    const prompt =
      "driven by @Audio_5, the @Audio_5 waveform, sourced entirely from @Audio_5, " +
      "besides the @Audio_5 dialogue track";
    const out = declareAudioTags(prompt, audio());

    expect(out.match(new RegExp(VOICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(
      1,
    );
    expect(out).toBe(
      `Audio_5 is ${VOICE}.\n\n` +
        "driven by Audio_5, the Audio_5 waveform, sourced entirely from Audio_5, " +
        "besides the Audio_5 dialogue track",
    );
    expect(out).not.toContain("@");
  });

  // No description means no declaration was earned. The worker's bindUITags
  // still needs the '@' to know to strip it -- a bare "voice1" with nothing
  // introducing it would read as scene direction about something the prompt
  // never named.
  it("leaves an audio element with no description untouched", () => {
    expect(declareAudioTags("driven by @voice1", new Map())).toBe("driven by @voice1");
  });

  it("returns the prompt unchanged when it has no tags", () => {
    expect(declareAudioTags("a quiet kitchen", audio())).toBe("a quiet kitchen");
  });

  it("declares each of two distinct voices once, in first-mention order", () => {
    const byName = new Map([
      ["audio_5", { name: "Audio_5", description: VOICE }],
      ["narrator", { name: "Narrator", description: "A calm male narrator voice" }],
    ]);
    const prompt = "@Narrator introduces the scene, then @Audio_5 speaks, then @Narrator closes.";
    const out = declareAudioTags(prompt, byName);

    expect(out).toBe(
      "Narrator is A calm male narrator voice.\n" +
        `Audio_5 is ${VOICE}.\n\n` +
        "Narrator introduces the scene, then Audio_5 speaks, then Narrator closes.",
    );
  });
});
