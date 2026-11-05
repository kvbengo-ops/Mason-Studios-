// Pure helpers for scene `idx` re-packing (see docs/architecture.md § "Schema" —
// `scenes.idx` must stay a gapless, 0-based ordering within a project).
//
// Kept free of any DB/Supabase dependency so the ordering logic used by
// deleteScene/addScene/reorderScenes (actions/brief.ts) can be unit tested
// without a database. actions/brief.ts is the only caller; it fetches the
// current `id`s ordered by `idx`, runs them through these functions, then
// persists the resulting order.

/** A scene's new position, ready to be written back as `idx`. */
export interface RepackedScene {
  id: string;
  idx: number;
}

/**
 * Assigns contiguous, gapless indices (0..n-1) to an ordered list of scene
 * ids, preserving their relative order.
 */
export function repackIds(ids: readonly string[]): RepackedScene[] {
  return ids.map((id, idx) => ({ id, idx }));
}

/**
 * Removes a scene id from an ordered id list. The caller then re-packs the
 * result with `repackIds`.
 */
export function removeSceneId(ids: readonly string[], removeId: string): string[] {
  return ids.filter((id) => id !== removeId);
}

/**
 * Inserts `newId` into an ordered id list immediately after the scene
 * currently at position `afterIdx` (0-based, matching that scene's current
 * `idx` since the list is always kept gapless). Pass `null` to insert at
 * the very start. Out-of-range values clamp into range rather than
 * throwing, since a stale `afterIdx` from a concurrent edit should degrade
 * to "insert somewhere sane", not fail the whole action.
 */
export function insertAfter(
  ids: readonly string[],
  afterIdx: number | null,
  newId: string,
): string[] {
  const insertAt = afterIdx === null ? 0 : afterIdx + 1;
  const clamped = Math.max(0, Math.min(insertAt, ids.length));
  return [...ids.slice(0, clamped), newId, ...ids.slice(clamped)];
}
