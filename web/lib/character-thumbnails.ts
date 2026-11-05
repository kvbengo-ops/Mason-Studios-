// Signs the grid thumbnail for a batch of characters — shared by /library's
// own grid and every project's Character-step picker (character/page.tsx),
// the two surfaces that render the `characters` table as a thumbnail grid.
//
// signedUrl() (lib/storage.ts) THROWS when a storage_key no longer resolves
// to a real object — deleted straight from the bucket, or any other drift
// between the `characters` table and Storage. Signing a batch with
// Promise.all rejects the WHOLE batch the instant any ONE input does, which
// is exactly how a single orphaned library row used to 500 an entire page
// for every operator, admin or editor, on whichever of the two surfaces hit
// it first. Promise.allSettled instead lets every OTHER character's URL
// still resolve; the orphaned one gets `null` here, which
// components/character-thumbnail.tsx renders as a placeholder card instead
// of taking the page down.

import { signedUrl } from "@/lib/storage";

export interface CharacterThumbnailSource {
  id: string;
  storage_key: string;
}

// Both grids render this table at the same visual size (grid-cols-2
// sm:grid-cols-3 inside a max-w-2xl wrapper) — see each call site's own
// comment for the DPR/box-size arithmetic behind these exact numbers.
// width alone (default resize:"cover") does not scale proportionally, it
// silently squashes the image — resize:"contain" has to ride along with
// width every time; see ImageTransform's doc comment in lib/storage.ts.
const CHARACTER_THUMBNAIL_TRANSFORM = { width: 400, resize: "contain", quality: 70 } as const;

/**
 * Signs every character's thumbnail in `rows`, degrading a single bad row
 * to `null` instead of throwing — see this file's header. `context` is
 * folded into the console.warn below only so whoever reads the log knows
 * which of the two surfaces hit the orphaned row; it is never shown to the
 * operator, who already sees a placeholder card in its place.
 */
export async function signCharacterThumbnails(
  rows: readonly CharacterThumbnailSource[],
  context: string,
): Promise<(string | null)[]> {
  const results = await Promise.allSettled(
    rows.map((row) => signedUrl(row.storage_key, undefined, CHARACTER_THUMBNAIL_TRANSFORM)),
  );
  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    console.warn(`${context}: failed to sign a character's storage_key — showing a placeholder`, {
      characterId: rows[index]?.id,
      storageKey: rows[index]?.storage_key,
      error: result.reason,
    });
    return null;
  });
}
