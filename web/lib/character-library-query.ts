// The `characters` query shared by /library's own grid and every project's
// Character-step picker (character/page.tsx's "Character Library" card) —
// both render the same table under the same peek/browse split, and having
// two independent copies of "how does ?page= turn into a range" and "what
// counts as browsing" is exactly the kind of drift that let this table's
// signing logic diverge in the first place (see signCharacterThumbnails's
// doc comment, lib/character-thumbnails.ts, for the sibling half of that
// fix). Each caller still owns its OWN `q`/`page` search params — this only
// turns already-resolved values into the query.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { pageRange, totalPageCount } from "@/lib/pagination";
import { buildIlikeOrFilter } from "@/lib/search-term";

export interface CharacterLibraryRow {
  id: string;
  name: string;
  description: string | null;
  storage_key: string;
}

export interface CharacterLibraryPage {
  rows: CharacterLibraryRow[];
  /**
   * Full table count matching `q` (or the whole table when `q` is empty) —
   * the SAME value whether this particular request was a peek or a browse
   * page, since Supabase's `count: "exact"` is computed independently of
   * `.range()`/`.limit()`. That's what lets a "Show all (N)" link built from
   * a peek response and a "Page X of Y" pager built from a browse response
   * agree on the same N.
   */
  totalCount: number;
  totalPages: number;
}

export interface CharacterLibraryPageParams {
  /** Already sanitized — see lib/search-term.ts's sanitizeSearchTerm. */
  q: string;
  /** Peek (`false`): a fixed `.limit(peekCount)`. Browse (`true`): a real `.range()` page. */
  browsing: boolean;
  requestedPage: number;
  peekCount: number;
  pageSize: number;
}

/**
 * Throws on a Supabase error rather than returning one — same contract the
 * two pre-existing call sites this replaces already had (an admin/editor
 * can't do anything useful with "the library failed to load" other than see
 * that it failed), and this is a read of the shared library table, not a
 * per-row signing failure, so there's no partial-degrade story the way
 * signCharacterThumbnails has one for a single bad row.
 */
export async function fetchCharacterLibraryPage(
  supabase: SupabaseClient<Database>,
  { q, browsing, requestedPage, peekCount, pageSize }: CharacterLibraryPageParams,
): Promise<CharacterLibraryPage> {
  const baseQuery = supabase
    .from("characters")
    .select("id, name, description, storage_key", { count: "exact" });
  const orFilter = buildIlikeOrFilter(["name", "description"], q);
  const filteredQuery = orFilter ? baseQuery.or(orFilter) : baseQuery;
  const orderedQuery = filteredQuery.order("created_at", { ascending: false });

  const { from, to } = pageRange(requestedPage, pageSize);
  const { data, error, count } = browsing
    ? await orderedQuery.range(from, to)
    : await orderedQuery.limit(peekCount);

  if (error) {
    throw new Error(`Failed to load the character library: ${error.message}`);
  }

  const totalCount = count ?? 0;
  return { rows: data ?? [], totalCount, totalPages: totalPageCount(totalCount, pageSize) };
}
