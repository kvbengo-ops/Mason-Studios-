import { describe, expect, it } from "vitest";
import type { ElementTag } from "./elements";
import { unknownPromptTags, unknownTagsWarning } from "./unknown-tags";

const element = (name: string, assetKind: string): ElementTag =>
  ({ id: name, name, category: "image", assetKind, previewUrl: "" }) as unknown as ElementTag;

const library = [element("mara_ref", "ref_frame"), element("voice1", "audio")];

describe("unknownPromptTags", () => {
  it("lists tags that match no saved element, once each, in order", () => {
    expect(unknownPromptTags("@mara_ref in @ghost with @Ghost and @other", library)).toEqual([
      "ghost",
      "other",
    ]);
  });

  it("matches a saved element case-insensitively", () => {
    expect(unknownPromptTags("@MARA_REF", library)).toEqual([]);
  });

  it("on the image bar, a tag naming a voice counts as unusable", () => {
    expect(unknownPromptTags("@voice1", library)).toEqual([]);
    expect(unknownPromptTags("@voice1", library, { imagesOnly: true })).toEqual(["voice1"]);
  });

  it("finds nothing when the prompt tags nothing", () => {
    expect(unknownPromptTags("a plain prompt", library)).toEqual([]);
  });
});

describe("unknownTagsWarning", () => {
  it("says nothing without a bad tag", () => {
    expect(unknownTagsWarning([])).toBeNull();
  });

  it("names one tag in the singular", () => {
    expect(unknownTagsWarning(["ghost"])).toBe(
      "@ghost doesn't match any saved element, so it will go through as plain text with no reference. Are you sure you want to render?",
    );
  });

  it("names several in the plural", () => {
    expect(unknownTagsWarning(["a", "b", "c"])).toContain("@a, @b and @c don't match");
  });
});
