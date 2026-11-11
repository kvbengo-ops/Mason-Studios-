// `.in("id", ids)` puts every id in the request URL, and past roughly 575
// UUIDs that URL is too long for Supabase's gateway: the request fails
// (HTTP 400 or a dropped connection, measured 2026-11-11). A user's element
// library grows without bound — image jobs file their outputs as elements —
// so every lookup of "all my elements' assets" broke for one account at once:
// API /quote and /elements returned 500 while everyone else's worked.
//
// selectInChunks runs the same query over slices of the ids and concatenates
// the rows. The first error wins and is returned like a single query's.

/** Ids per request: ~7.5 KB of URL, far under the gateway's limit. */
export const IN_CHUNK_SIZE = 200;

export async function selectInChunks<T>(
  ids: readonly string[],
  run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  size: number = IN_CHUNK_SIZE,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const chunks: string[][] = [];
  for (let from = 0; from < ids.length; from += size) chunks.push(ids.slice(from, from + size));
  const results = await Promise.all(chunks.map((chunk) => run(chunk)));
  const failed = results.find((result) => result.error);
  if (failed) return { data: [], error: failed.error };
  return { data: results.flatMap((result) => result.data ?? []), error: null };
}
