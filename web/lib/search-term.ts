// Free-text search for the projects list and the Character Library, built on
// Postgres `ilike` rather than a vector/embedding search. Deliberately so:
// both surfaces are matching a short, mostly-literal string (a title, a
// product name, a character's name) against a few hundred to a couple
// thousand rows, and `ilike '%term%'` gets nearly all the value a real user
// wants — case-insensitive substring match — for a fraction of the
// engineering cost of standing up pgvector, an embeddings pipeline, and a
// re-indexing story. Reach for semantic search only if editors start
// complaining they can find a project by describing it but not by typing
// any word actually in its title — that hasn't happened, and nothing here
// should be swapped out on spec-fidelity grounds alone (the reference
// product's "Search by brief content" was semantic; our own titles and
// product names are short enough that substring match already covers them).

/**
 * Strips the characters that are meaningful to PostgREST's `.or()` filter
 * grammar — `,` separates clauses, `(`/`)` group them — out of a raw search
 * box value. Not a security boundary (every column name an `.or()` call
 * below matches against is a hard-coded literal, never built from user
 * input, so there's no clause to inject *into*); this only keeps a search
 * term containing one of those characters from splitting into a malformed
 * or unintended second clause and either 400ing the request or silently
 * OR-ing in a condition the caller never asked for.
 */
export function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[,()]/g, "").trim();
}

/**
 * Builds a PostgREST `.or()` filter string that ILIKE-substring-matches
 * `term` against every column in `columns`. Returns `null` for an
 * empty/whitespace/punctuation-only term so a call site can skip filtering
 * entirely — `undefined` search param in, no `.or()` call at all, rather
 * than one that matches every row while still paying for an
 * index-defeating scan to prove it.
 */
export function buildIlikeOrFilter(columns: readonly string[], term: string): string | null {
  const cleaned = sanitizeSearchTerm(term);
  if (!cleaned) {
    return null;
  }
  return columns.map((column) => `${column}.ilike.%${cleaned}%`).join(",");
}
