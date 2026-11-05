import { describe, expect, it } from "vitest";
import {
  captionStyleFrom,
  CaptionStyleSchema,
  DEFAULT_CAPTION_STYLE,
  isLowContrast,
} from "./caption-style";

describe("CaptionStyleSchema", () => {
  it("accepts a six-digit hex colour in either case", () => {
    const parsed = CaptionStyleSchema.parse({
      captions_enabled: true,
      caption_box_color: "#730BF9",
      caption_text_color: "#ffffff",
    });
    expect(parsed.caption_box_color).toBe("#730BF9");
    // Case is preserved, not normalised: the worker upper-cases on its way
    // into ASS (color.go), so normalising here as well would be a second
    // place to keep in step for no gain.
    expect(parsed.caption_text_color).toBe("#ffffff");
  });

  it.each([
    ["missing the hash", "730BF9"],
    ["three-digit shorthand, deliberately NOT expanded", "#FFF"],
    ["eight digits", "#730BF9FF"],
    ["non-hex digits", "#GGGGGG"],
    ["an rgb() function", "rgb(115,11,249)"],
    ["a named colour", "purple"],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(() =>
      CaptionStyleSchema.parse({
        captions_enabled: true,
        caption_box_color: value,
        caption_text_color: "#FFFFFF",
      }),
    ).toThrow();
  });

  // The anchors are the point. An unanchored regex accepts every fixture in
  // the accept test above AND everything here, so without these two cases a
  // dropped ^ or $ passes the whole file — and trailing text in a colour
  // reaches libass as a garbage token that draws the wrong thing silently.
  it("rejects trailing and leading garbage around an otherwise valid colour", () => {
    for (const value of ["#730BF9;evil", "x#730BF9", "#730BF9\n#000000"]) {
      expect(() =>
        CaptionStyleSchema.parse({
          captions_enabled: true,
          caption_box_color: value,
          caption_text_color: "#FFFFFF",
        }),
      ).toThrow();
    }
  });

  it("falls back to today's palette when the fields are absent entirely", () => {
    // A form that never rendered these inputs must land on the current
    // rendering, not fail validation on a field the operator never saw.
    const parsed = CaptionStyleSchema.parse({ captions_enabled: true });
    expect(parsed.caption_box_color).toBe(DEFAULT_CAPTION_STYLE.caption_box_color);
    expect(parsed.caption_text_color).toBe(DEFAULT_CAPTION_STYLE.caption_text_color);
  });

  it("defaults captions_enabled to true, matching 0049's column default", () => {
    // Not a style preference: the column defaults true because it is ANDed
    // with the global CAPTIONS_ENABLED kill-switch. Defaulting it false would
    // mean turning captions on globally captions exactly zero projects.
    expect(CaptionStyleSchema.parse({}).captions_enabled).toBe(true);
  });
});

describe("DEFAULT_CAPTION_STYLE", () => {
  // The single most consequential literal in this feature. '#730BF9' is
  // ass.go's retired boxColorASS ('&H00F90B73&') read back into RGB — ASS is
  // &HAABBGGRR&, so pasting those digits in as hex gives '#F90B73', a pink,
  // and every project rendered before this feature silently changes colour.
  // The Go side pins the same pairing from the other direction in
  // TestDefaultColorsMatchLegacyASS.
  it("carries the pre-feature purple, not the ASS digits misread as hex", () => {
    expect(DEFAULT_CAPTION_STYLE.caption_box_color).toBe("#730BF9");
    expect(DEFAULT_CAPTION_STYLE.caption_box_color).not.toBe("#F90B73");
  });
});

describe("captionStyleFrom", () => {
  it("reads the three columns off a project row", () => {
    expect(
      captionStyleFrom({
        captions_enabled: false,
        caption_box_color: "#112233",
        caption_text_color: "#445566",
      }),
    ).toEqual({
      captions_enabled: false,
      caption_box_color: "#112233",
      caption_text_color: "#445566",
    });
  });

  it("coalesces nulls to the defaults for a row read through a pre-0049 type", () => {
    expect(captionStyleFrom({})).toEqual(DEFAULT_CAPTION_STYLE);
  });

  it("keeps captions_enabled false rather than treating it as unset", () => {
    // `?? default` and `|| default` differ on exactly this value, and the
    // wrong one silently re-enables captions for every project that opted
    // out — the bug this assertion exists to catch.
    expect(captionStyleFrom({ captions_enabled: false }).captions_enabled).toBe(false);
  });
});

describe("isLowContrast", () => {
  it("flags white text on a white box", () => {
    expect(isLowContrast("#FFFFFF", "#FFFFFF")).toBe(true);
  });

  it("does not flag the shipped default pairing", () => {
    // If the defaults themselves tripped the warning, every operator would
    // see it on a project they never touched and learn to ignore it.
    expect(
      isLowContrast(
        DEFAULT_CAPTION_STYLE.caption_text_color,
        DEFAULT_CAPTION_STYLE.caption_box_color,
      ),
    ).toBe(false);
  });

  it("is symmetric — which colour is lighter must not change the verdict", () => {
    expect(isLowContrast("#000000", "#FFFFFF")).toBe(isLowContrast("#FFFFFF", "#000000"));
  });

  it("stays silent on a malformed colour rather than reporting a contrast failure", () => {
    // The regex has already rejected it and said so; a second, vaguer
    // complaint about contrast on the same field would be noise.
    expect(isLowContrast("nonsense", "#FFFFFF")).toBe(false);
  });
});
