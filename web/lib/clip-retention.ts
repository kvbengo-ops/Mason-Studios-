// Clip expiry (owner, 2026-11-15): a finished clip in the personal Create
// project moves to the bin 14 days after it was made, unless its scene is
// marked Keep; a clip in a real project never does (owner, 2026-11-17). The
// worker does the moving (worker/internal/loop/purge_bin.go's ClipRetention —
// keep the two equal); this file is what the web warns from. Client-safe.

export const CLIP_RETENTION_DAYS = 14;
/** A Create clip this old is "stale": /create asks to clean it up or keep it. */
export const STALE_CLIP_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until a clip made at `createdAt` moves to the bin; 0 = due now. */
export function daysUntilClipExpiry(createdAt: string, now: number = Date.now()): number {
  const left = new Date(createdAt).getTime() + CLIP_RETENTION_DAYS * DAY_MS - now;
  return Math.max(0, Math.ceil(left / DAY_MS));
}

/** The ISO instant before which a clip is stale. */
export function staleClipCutoff(now: number = Date.now()): string {
  return new Date(now - STALE_CLIP_DAYS * DAY_MS).toISOString();
}

/** "Kept", or when the clip goes: what the details card and menus print. */
export function clipExpiryLabel(
  keep: boolean,
  createdAt: string,
  now: number = Date.now(),
): string {
  if (keep) return "Kept";
  const days = daysUntilClipExpiry(createdAt, now);
  return days === 0 ? "Moves to the bin today" : `Moves to the bin in ${days}d`;
}
