// Pure comparison behind the Character/Product screens' staleness banners
// (character/page.tsx, product/page.tsx) — pulled out of those Server
// Components so the rule
// itself ("a generated image is stale once the text it was built from has
// changed since") is unit-testable without rendering the page. See
// 0057_description_edit_tracking.sql for why these two timestamps exist at
// all.

/**
 * True when `editedAt` (projects.character_desc_edited_at or
 * product_appearance_edited_at) is strictly AFTER `assetCreatedAt` (the
 * generated portrait/composite's own created_at) — i.e. the text changed
 * since the image was made from it.
 *
 * `editedAt === null` (never edited through actions/setup.ts's saveCharacter/
 * saveProduct — see that migration's header) always returns false: there is
 * nothing to compare
 * against, and the safe default is "not stale," not "stale by default."
 * Landing exactly on the same instant is NOT stale (`>`, not `>=`) — an
 * edit and a generation that happen to share a timestamp did not happen in
 * the wrong order.
 */
export function isDescriptionStale(
  editedAt: string | null,
  assetCreatedAt: string | null,
): boolean {
  if (!editedAt || !assetCreatedAt) return false;
  return new Date(editedAt).getTime() > new Date(assetCreatedAt).getTime();
}
