import { describe, expect, it } from "vitest";
import {
  activeTagQuery,
  findElementByTag,
  elementMatchesSearch,
  matchElementsByPrefix,
  splitPromptIntoTagSegments,
  type ElementTag,
} from "@/lib/elements";

function tag(overrides: Partial<ElementTag> = {}): ElementTag {
  return {
    id: "el-1",
    name: "jen",
    category: "character",
    description: null,
    assetKind: "ref_frame" as const,
    previewUrl: "https://example.com/jen.png",
    ...overrides,
  };
}

describe("findElementByTag", () => {
  it("matches case-insensitively", () => {
    const jen = tag({ name: "jen" });
    expect(findElementByTag([jen], "Jen")).toBe(jen);
    expect(findElementByTag([jen], "JEN")).toBe(jen);
  });

  it("returns undefined for a name nothing matches", () => {
    expect(findElementByTag([tag({ name: "jen" })], "bluebottle")).toBeUndefined();
  });
});

describe("splitPromptIntoTagSegments", () => {
  it("returns one plain segment for a prompt with no tags", () => {
    const segments = splitPromptIntoTagSegments("a woman at a counter", []);
    expect(segments).toEqual([{ text: "a woman at a counter", tag: null }]);
  });

  it("splits a known tag out from surrounding text", () => {
    const jen = tag({ name: "jen" });
    const segments = splitPromptIntoTagSegments("hey @jen sips coffee", [jen]);
    expect(segments).toEqual([
      { text: "hey ", tag: null },
      { text: "@jen", tag: { name: "jen", element: jen } },
      { text: " sips coffee", tag: null },
    ]);
  });

  it("marks a tag with no matching element as a miss", () => {
    const segments = splitPromptIntoTagSegments("@typojen sips coffee", []);
    expect(segments[0]).toEqual({
      text: "@typojen",
      tag: { name: "typojen", element: undefined },
    });
  });

  it("handles a tag at the very start and end with nothing between", () => {
    const segments = splitPromptIntoTagSegments("@jen", []);
    expect(segments).toEqual([{ text: "@jen", tag: { name: "jen", element: undefined } }]);
  });

  it("handles two adjacent tags separated by one space", () => {
    const jen = tag({ name: "jen" });
    const bottle = tag({ id: "el-2", name: "bluebottle", category: "product" });
    const segments = splitPromptIntoTagSegments("@jen @bluebottle", [jen, bottle]);
    expect(segments).toEqual([
      { text: "@jen", tag: { name: "jen", element: jen } },
      { text: " ", tag: null },
      { text: "@bluebottle", tag: { name: "bluebottle", element: bottle } },
    ]);
  });

  it("stops a tag at punctuation, not just whitespace", () => {
    const jen = tag({ name: "jen" });
    const segments = splitPromptIntoTagSegments("hey @jen, take a sip", [jen]);
    expect(segments).toEqual([
      { text: "hey ", tag: null },
      { text: "@jen", tag: { name: "jen", element: jen } },
      { text: ", take a sip", tag: null },
    ]);
  });

  it("is called repeatedly without state leaking between calls", () => {
    // Regression guard for the shared-RegExp.lastIndex trap this function's
    // own doc comment warns about: calling it twice must not silently skip
    // the first tag on the second call.
    const jen = tag({ name: "jen" });
    const first = splitPromptIntoTagSegments("@jen", [jen]);
    const second = splitPromptIntoTagSegments("@jen", [jen]);
    expect(first).toEqual(second);
  });
});

describe("activeTagQuery", () => {
  it("finds the tag the caret is inside", () => {
    const prompt = "hey @je";
    expect(activeTagQuery(prompt, prompt.length)).toEqual({ start: 4, query: "je" });
  });

  it("returns an empty query for a bare '@' just typed", () => {
    const prompt = "hey @";
    expect(activeTagQuery(prompt, prompt.length)).toEqual({ start: 4, query: "" });
  });

  it("returns null once the token is finished (caret past a trailing space)", () => {
    const prompt = "hey @jen ";
    expect(activeTagQuery(prompt, prompt.length)).toBeNull();
  });

  it("returns null when the caret sits in plain text with no '@' behind it", () => {
    const prompt = "just some words";
    expect(activeTagQuery(prompt, prompt.length)).toBeNull();
  });

  it("returns null when punctuation, not just whitespace, breaks the token", () => {
    const prompt = "hey @jen, more text";
    // Caret right after the comma — the '@jen' token already ended at ','.
    const cursor = prompt.indexOf(",") + 1;
    expect(activeTagQuery(prompt, cursor)).toBeNull();
  });

  it("resolves the tag under the caret when editing mid-prompt, not the one at the end", () => {
    const prompt = "@jen and @bluebottle";
    // Caret placed inside "@jen", not at the string's end.
    expect(activeTagQuery(prompt, 4)).toEqual({ start: 0, query: "jen" });
  });
});

describe("matchElementsByPrefix", () => {
  const jen = tag({ name: "jen" });
  const jenna = tag({ id: "el-2", name: "jenna" });
  const bottle = tag({ id: "el-3", name: "bluebottle", category: "product" });

  it("matches by case-insensitive prefix", () => {
    expect(matchElementsByPrefix([jen, jenna, bottle], "Je")).toEqual([jen, jenna]);
  });

  it("returns everything for an empty query", () => {
    expect(matchElementsByPrefix([jen, bottle], "")).toEqual([jen, bottle]);
  });

  it("caps the result at `limit`", () => {
    expect(matchElementsByPrefix([jen, jenna], "j", 1)).toEqual([jen]);
  });

  // THE BUG: twelve voice clips uploaded in one afternoon filled all eight
  // rows of the @ menu, and the twenty-two pictures in the same library were
  // unreachable through it — present, matching the query, and never offered.
  //
  // It arrived without a code change. 0081 renamed the category 'voice' to
  // 'audio', the page sorted by category, and 'audio' sorts before
  // 'character' where 'voice' had sorted after it. The page sorts by recency
  // now, but recency alone does not fix this: the clips WERE the newest
  // things in that library.
  const clip = (name: string, id: string): ElementTag =>
    tag({ id, name, category: "audio", assetKind: "audio" as const });
  const picture = (name: string, id: string): ElementTag => tag({ id, name });

  it("offers both kinds when both match, rather than letting one fill the menu", () => {
    const elements = [
      clip("new_audio12", "a1"),
      clip("new_audio11", "a2"),
      clip("new_audio10", "a3"),
      clip("new_audio9", "a4"),
      clip("new_audio8", "a5"),
      picture("new_image3", "i1"),
      picture("new_image2", "i2"),
      picture("new_image3b", "i3"),
    ];

    const shown = matchElementsByPrefix(elements, "new", 4);

    expect(shown.filter((el) => el.assetKind === "audio")).toHaveLength(2);
    expect(shown.filter((el) => el.assetKind !== "audio")).toHaveLength(2);
    // And each kind's own order is the caller's, not reshuffled: the first
    // picture and the first clip are the first of each in the input.
    expect(shown.map((el) => el.id)).toEqual(["i1", "a1", "i2", "a2"]);
  });

  it("still fills the menu from one kind when only that kind matches", () => {
    // The common case once two or three letters are typed. Reserving half the
    // menu for a kind with no matches would waste it.
    const elements = [clip("anny1", "a1"), clip("anny2", "a2"), picture("jen", "i1")];

    expect(matchElementsByPrefix(elements, "anny", 4).map((el) => el.id)).toEqual(["a1", "a2"]);
  });
});

describe("elementMatchesSearch", () => {
  // The whole reason this is not matchElementsByPrefix: that one completes an
  // @tag you are typing, so it anchors at the start of the name. Here you are
  // hunting for something you saved and half remember.
  it("matches the middle of a name, not just the start", () => {
    expect(elementMatchesSearch(tag({ name: "blue_bottle_2" }), "bottle")).toBe(true);
    expect(matchElementsByPrefix([tag({ name: "blue_bottle_2" })], "bottle")).toHaveLength(0);
  });

  it("ignores case and surrounding whitespace in the query", () => {
    expect(elementMatchesSearch(tag({ name: "Jen" }), "  jEn ")).toBe(true);
  });

  it("searches the human description", () => {
    expect(
      elementMatchesSearch(tag({ name: "jen", description: "red leather jacket" }), "jacket"),
    ).toBe(true);
  });

  // For a picture the generated one is usually the ONLY description, so a
  // search that skipped it would find nothing for exactly the elements
  // nobody got round to describing by hand.
  it("searches the generated description too", () => {
    expect(
      elementMatchesSearch(tag({ name: "jen", aiDescription: "a woman in a red coat" }), "coat"),
    ).toBe(true);
  });

  // "Not searching" is the state the box is in most of the time, and it must
  // not empty the grid.
  it.each(["", "   "])("treats a blank query (%o) as matching everything", (query) => {
    expect(elementMatchesSearch(tag(), query)).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(elementMatchesSearch(tag({ name: "jen", description: "red" }), "zebra")).toBe(false);
  });

  // description and aiDescription are both nullable, and aiDescription is
  // optional on top of that — a fixture without one must not throw.
  it("survives a null description and a missing aiDescription", () => {
    expect(elementMatchesSearch(tag({ description: null }), "jen")).toBe(true);
    expect(elementMatchesSearch(tag({ description: null }), "nope")).toBe(false);
  });
});
