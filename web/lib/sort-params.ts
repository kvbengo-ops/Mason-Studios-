// Shared `?sort=`/`?dir=` parsing for server-sorted list pages — same
// reasoning as lib/pagination.ts's `?page=` helpers: one place so "what
// does a hand-edited or stale sort URL mean" can't drift between pages, and
// so the parsing (an allowlist check, nothing that talks to Supabase) is
// testable without a database.

export type SortDirection = "asc" | "desc";

export interface ParsedSort<Column extends string> {
  column: Column;
  direction: SortDirection;
}

/**
 * Parses `?sort=`/`?dir=` search-param values into a validated
 * column + direction pair. Anything that isn't one of `columns`, or isn't
 * exactly `"asc"`/`"desc"`, falls back to `fallback` — a hand-edited or
 * stale URL (`?sort=drop_table`, `?dir=DESC`) degrades to the default sort
 * instead of reaching a `.order()` call with a column name that was never
 * checked against an allowlist. Same "array from a repeated query key"
 * handling as parsePage (lib/pagination.ts).
 */
export function parseSort<Column extends string>(
  columns: readonly Column[],
  fallback: ParsedSort<Column>,
  rawSort: string | string[] | undefined,
  rawDir: string | string[] | undefined,
): ParsedSort<Column> {
  const sortValue = Array.isArray(rawSort) ? rawSort[0] : rawSort;
  const dirValue = Array.isArray(rawDir) ? rawDir[0] : rawDir;

  const column = (columns as readonly string[]).includes(sortValue ?? "")
    ? (sortValue as Column)
    : fallback.column;
  const direction: SortDirection =
    dirValue === "asc" || dirValue === "desc" ? dirValue : fallback.direction;

  return { column, direction };
}

/** Toggles direction for clicking an already-active sort column: asc -> desc, desc -> asc. */
export function toggleDirection(direction: SortDirection): SortDirection {
  return direction === "asc" ? "desc" : "asc";
}
