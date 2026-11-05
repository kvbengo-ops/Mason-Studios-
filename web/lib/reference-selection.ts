// Which reference image(s) a scene's frame generation should condition on
// — pulled out of actions/frames.ts (a "use server" file, where every
// export must be an async Server Action) so this stays a plain,
// synchronous, unit-testable function, same split as lib/editable-guard.ts
// and lib/recompile-guard.ts.
//
// Product shots vs talking-head deliveries are the only scene-level split
// this schema records: scenes.is_talking_head (0001_init.sql, and
// lib/claude.ts's Brief schema, which is what actually sets it per scene
// at compile time). Every compiled brief so far writes a non-talking-head
// scene as the cutaway/demo shot that shows the product, and a
// talking-head scene as the presenter speaking to camera (see lib/claude.ts's
// mockBrief fixture) — the same split spec
// §3.5 renders as "Character" vs "Product / With product" first-frame
// buckets. Reusing is_talking_head here, instead of adding a dedicated
// is_product_shot column, means a scene's product-shot status is already
// correct the moment the compiler writes it, with nothing new to keep in
// sync — the smallest change that gets the composite in front of the
// scenes it belongs in front of.

/** Signed URLs for a project's reference assets, one per kind, or null if that kind has none yet. */
export interface ConditioningRefs {
  characterUrl: string | null;
  productUrl: string | null;
  compositeUrl: string | null;
}

/** True when a scene is the kind of shot that should show the product. */
export function isProductShot(scene: { is_talking_head: boolean }): boolean {
  return !scene.is_talking_head;
}

/**
 * The reference image URL(s) `generateImage` (lib/fal.ts) should condition
 * on for one scene.
 *
 * Product shots prefer the character-with-product composite: one image
 * that already shows the right person holding the right product, instead
 * of two separate references fal's /edit model has to reconcile itself
 * (spec §3.2's whole reason for the composite to exist). Falls back to the
 * character and product refs passed separately when no composite exists
 * yet — generation failed, or the operator hasn't clicked "Regenerate
 * Combined" — which is the behaviour every scene had before this feature,
 * not a silent product-less frame.
 *
 * Talking-head scenes take the composite too, when one exists. They used to
 * take the character reference alone, on the reasoning that "nothing about
 * a monologue delivery calls for the product to be on screen, and
 * conditioning on it anyway only creates a chance it carries into a shot it
 * shouldn't be in." Watching a real three-scene compile is what overturned
 * that: the two A-roll scenes had no product anywhere in frame, so a
 * viewer's first and last sight of the ad sold nothing, and the whole
 * product burden fell on a single mid-roll cutaway. For a UGC ad the
 * presenter holding the pouch while she talks about it is the format, not
 * a leak.
 *
 * The fallback is deliberately NOT the same as a product shot's. With no
 * composite, a talking-head scene goes back to the character reference
 * alone rather than character+product-as-two-images: two unreconciled
 * references are what the composite exists to avoid (spec §3.2), and on a
 * monologue the model has no staging cue for where the loose product ref
 * belongs, so it tends to paste it in as a floating object. A product shot
 * has that cue from its own prompt; this one doesn't. So the product
 * reaches an A-roll scene only through the one image that already shows
 * the right person holding it, or not at all.
 *
 * Consequence worth stating: the operator can no longer get a
 * product-less A-roll delivery out of a project that has a composite. If a
 * testimonial-only ad ever needs one (auditProductCoverage's doc comment
 * below calls that a legitimate editorial choice), it needs a real control
 * — not a silent reliance on this function's old default.
 */
export function refImageUrlsForScene(
  refs: ConditioningRefs,
  scene: { is_talking_head: boolean },
): string[] {
  if (!isProductShot(scene)) {
    if (refs.compositeUrl) {
      return [refs.compositeUrl];
    }
    return refs.characterUrl ? [refs.characterUrl] : [];
  }
  if (refs.compositeUrl) {
    return [refs.compositeUrl];
  }
  return [refs.characterUrl, refs.productUrl].filter((url): url is string => url !== null);
}

/**
 * Non-blocking signal that a compile likely reproduced the exact bug that
 * motivated prompt_templates v5's product-shot rule (0019_seed_template_v5.sql):
 * a project with a product reference compiled into a brief where every
 * scene is a talking head, so isProductShot/refImageUrlsForScene never has
 * a scene to route the character-with-product composite to and the product
 * — paid for, verified against the live API — never appears in the ad.
 *
 * Deliberately returns a string to log rather than throwing. hasProduct
 * only means a product asset was uploaded, not that every ad selling it is
 * obligated to show it on screen — a testimonial-only script with the
 * product mentioned but never shown is a legitimate editorial choice, not
 * a bug. The Zod Brief schema (lib/claude.ts) already enforces shape; this
 * is the one check downstream of it that knows about product coverage, and
 * it stays advisory so a compile that made that legitimate choice still
 * lands the operator on the Review Brief gate instead of a dead end.
 */
export function auditProductCoverage(
  scenes: { is_talking_head: boolean }[],
  hasProduct: boolean,
): string | null {
  if (!hasProduct || scenes.length === 0) return null;
  if (scenes.some((scene) => isProductShot(scene))) return null;
  return (
    `compileBrief: project has a product reference but all ${scenes.length} compiled scene(s) ` +
    "are talking-head (is_talking_head: true) — the product will not appear in this ad."
  );
}
