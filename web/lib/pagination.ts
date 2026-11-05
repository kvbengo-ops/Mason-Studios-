// Shared page-size/offset math for the list pages that got real pagination
// in this pass (the projects list, the Character Library grid, and
// /spend's runs table) — one place so "what does ?page=0 mean" and "how do
// I turn a 1-indexed page into a .range() offset" can't drift between them.
// Deliberately just arithmetic: nothing here talks to Supabase, so every
// case (negative page, non-numeric page, a count of exactly one page) is
// testable without a database.

/**
 * Parses a `?page=` search-param value into a 1-indexed page number.
 * Anything that isn't a positive integer — missing, `"0"`, `"-3"`,
 * `"abc"`, or the array Next.js hands back for a repeated query key —
 * falls back to page 1 rather than surfacing a 400 for a hand-edited or
 * stale URL (an old "page 6" link into a list that's since shrunk to two
 * pages is exactly the case `pageRange` below clamps against the other
 * end).
 */
export function parsePage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

// The only page sizes a `?size=` value is allowed to select. Allowlisted
// the same way parseSort's columns are (lib/sort-params.ts) — a hand-edited
// `?size=100000` must never reach `.range()` and pull the whole table.
export const PAGE_SIZES = [10, 20, 50] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

// 10, not the previous hardcoded 20 — the smaller default costs an extra
// click for the common "browse everything" case but is cheaper on first
// paint for the far more common case of an admin checking the newest few
// rows, and it makes the three-way selector's own default legible: 10 sits
// first in PAGE_SIZES, not buried as the middle option.
export const DEFAULT_PAGE_SIZE: PageSize = 10;

/**
 * Parses a `?size=` search-param value into a validated page size.
 * Anything that isn't exactly one of PAGE_SIZES — missing, `"100000"`,
 * `"15"`, `"abc"`, or the array Next.js hands back for a repeated query
 * key — falls back to DEFAULT_PAGE_SIZE, the same "unrecognized input
 * degrades to the default" contract parsePage and parseSort already use.
 */
export function parsePageSize(raw: string | string[] | undefined): PageSize {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  return (PAGE_SIZES as readonly number[]).includes(parsed)
    ? (parsed as PageSize)
    : DEFAULT_PAGE_SIZE;
}

export interface PageRange {
  /** 1-indexed, clamped to >= 1. */
  page: number;
  /** Inclusive start offset for `.range(from, to)`. */
  from: number;
  /** Inclusive end offset for `.range(from, to)`. */
  to: number;
}

/** Turns a (possibly out-of-range) page number + fixed page size into a `.range()` pair. */
export function pageRange(page: number, pageSize: number): PageRange {
  const clampedPage = Number.isInteger(page) && page > 0 ? page : 1;
  const from = (clampedPage - 1) * pageSize;
  return { page: clampedPage, from, to: from + pageSize - 1 };
}

/** Total number of pages for `totalCount` rows at `pageSize` per page. Never less than 1 — an empty list still has "page 1 of 1", not "page 1 of 0". */
export function totalPageCount(totalCount: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalCount / pageSize));
}
