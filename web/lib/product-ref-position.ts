// Pure position/primary math for assets.kind = 'product_ref' — factored out
// of actions/character.ts because a "use server" file may only export async
// Server Actions, so a synchronous helper has to live somewhere else to be
// unit-testable at all. Same split as lib/editable-guard.ts,
// lib/recompile-guard.ts, and lib/reference-selection.ts; this codebase has
// no precedent for mocking the Supabase client, so anything that stays
// inside an actions/*.ts file effectively never gets a test.
//
// position 0 IS primary, by construction — see 0023_asset_position.sql for
// why an ordinal column was chosen over a boolean is_primary flag, and for
// the database's own enforcement of "at most one row per project can hold
// position 0" (a partial unique index, not application code). Every
// function here just computes numbers; nothing here talks to the database,
// and nothing here is the actual invariant.

export interface PositionedAsset {
  id: string;
  position: number;
}

/**
 * Where a newly uploaded product photo should land: position 0 (and
 * therefore primary — see 0023_asset_position.sql) if it's the very first
 * one, otherwise one past whatever the highest existing position is —
 * appended to the end of the grid, never inserted in the middle and never
 * reassigning an existing photo's spot.
 *
 * Doubles as the transient pivot setPrimaryProductRef (actions/character.ts)
 * parks a photo at mid-swap: any value strictly greater than every existing
 * position is guaranteed collision-free against the partial unique index
 * `(project_id, position) where kind = 'product_ref'`, and "one past the
 * current max" is exactly that — no separate sentinel/pivot function
 * needed.
 */
export function nextProductRefPosition(existing: readonly PositionedAsset[]): number {
  if (existing.length === 0) {
    return 0;
  }
  return existing.reduce((max, asset) => Math.max(max, asset.position), 0) + 1;
}

/**
 * Which photo should become the new primary after the current one
 * (position 0) is removed: whichever remaining photo has the lowest
 * position, so the grid's visual order — not insertion order, not id order
 * — decides who's next in line. Returns null when no photos remain, which
 * is the ordinary "no product photo at all" state, not an error.
 */
export function promotedPrimaryId(remaining: readonly PositionedAsset[]): string | null {
  if (remaining.length === 0) {
    return null;
  }
  return remaining.reduce((lowest, asset) => (asset.position < lowest.position ? asset : lowest))
    .id;
}
