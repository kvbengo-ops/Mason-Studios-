import { describe, expect, it } from "vitest";
import {
  auditProductCoverage,
  isProductShot,
  refImageUrlsForScene,
  type ConditioningRefs,
} from "./reference-selection";

const NO_REFS: ConditioningRefs = { characterUrl: null, productUrl: null, compositeUrl: null };

describe("isProductShot", () => {
  it("is true for a non-talking-head scene", () => {
    expect(isProductShot({ is_talking_head: false })).toBe(true);
  });

  it("is false for a talking-head scene", () => {
    expect(isProductShot({ is_talking_head: true })).toBe(false);
  });
});

describe("refImageUrlsForScene", () => {
  it("conditions a talking-head scene on the composite, so the presenter holds the product while she speaks", () => {
    const refs: ConditioningRefs = {
      characterUrl: "https://example.com/character.png",
      productUrl: "https://example.com/product.png",
      compositeUrl: "https://example.com/composite.png",
    };
    expect(refImageUrlsForScene(refs, { is_talking_head: true })).toEqual([
      "https://example.com/composite.png",
    ]);
  });

  it("falls a talking-head scene back to the character alone — never character+product as two loose images", () => {
    const refs: ConditioningRefs = {
      characterUrl: "https://example.com/character.png",
      productUrl: "https://example.com/product.png",
      compositeUrl: null,
    };
    // The asymmetry with a product shot's fallback (below) is the point,
    // not an oversight: a product shot's prompt tells the model where the
    // product goes, a monologue's does not, so a loose product reference
    // there gets pasted in as a floating object. Asserting the exact array
    // rather than just "contains the character" is what catches a future
    // edit that quietly makes this branch match the product-shot one.
    expect(refImageUrlsForScene(refs, { is_talking_head: true })).toEqual([
      "https://example.com/character.png",
    ]);
  });

  it("returns nothing for a talking-head scene with no references at all yet", () => {
    expect(refImageUrlsForScene(NO_REFS, { is_talking_head: true })).toEqual([]);
  });

  it("prefers the composite for a product-shot scene when one exists", () => {
    const refs: ConditioningRefs = {
      characterUrl: "https://example.com/character.png",
      productUrl: "https://example.com/product.png",
      compositeUrl: "https://example.com/composite.png",
    };
    expect(refImageUrlsForScene(refs, { is_talking_head: false })).toEqual([
      "https://example.com/composite.png",
    ]);
  });

  it("falls back to the separate character and product refs when there is no composite yet", () => {
    const refs: ConditioningRefs = {
      characterUrl: "https://example.com/character.png",
      productUrl: "https://example.com/product.png",
      compositeUrl: null,
    };
    expect(refImageUrlsForScene(refs, { is_talking_head: false })).toEqual([
      "https://example.com/character.png",
      "https://example.com/product.png",
    ]);
  });

  it("drops whichever of character/product is missing in the no-composite fallback", () => {
    const refs: ConditioningRefs = {
      characterUrl: "https://example.com/character.png",
      productUrl: null,
      compositeUrl: null,
    };
    expect(refImageUrlsForScene(refs, { is_talking_head: false })).toEqual([
      "https://example.com/character.png",
    ]);
  });

  it("returns nothing for a product-shot scene with no references at all", () => {
    expect(refImageUrlsForScene(NO_REFS, { is_talking_head: false })).toEqual([]);
  });
});

describe("auditProductCoverage", () => {
  // The exact incident this function exists to catch: a coffee ad with a
  // product reference compiled to three scenes, all talking-head.
  it("warns when the project has a product but every scene is talking-head", () => {
    const scenes = [
      { is_talking_head: true },
      { is_talking_head: true },
      { is_talking_head: true },
    ];
    const warning = auditProductCoverage(scenes, true);
    expect(warning).toMatch(/product/i);
    expect(warning).toMatch(/3/);
  });

  it("stays silent when the project has a product and at least one scene shows it", () => {
    expect(
      auditProductCoverage([{ is_talking_head: true }, { is_talking_head: false }], true),
    ).toBeNull();
  });

  // hasProduct false means no product asset was ever uploaded — an
  // all-talking-head brief is completely normal there and must never warn.
  it("stays silent when the project has no product at all", () => {
    expect(
      auditProductCoverage([{ is_talking_head: true }, { is_talking_head: true }], false),
    ).toBeNull();
  });

  it("stays silent on an empty scene list regardless of hasProduct", () => {
    expect(auditProductCoverage([], true)).toBeNull();
    expect(auditProductCoverage([], false)).toBeNull();
  });
});
