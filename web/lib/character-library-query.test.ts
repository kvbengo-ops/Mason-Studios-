import { describe, expect, it, vi } from "vitest";
import { fetchCharacterLibraryPage } from "./character-library-query";

// fetchCharacterLibraryPage is the single place that turns a peek/browse
// choice into either a fixed .limit() or a real .range() — see this file's
// own header comment on why the two callers must not each reimplement that
// split. These tests pin the arithmetic/branch wiring this function itself
// owns (which Supabase call gets made, with what arguments, and how an
// empty/short/past-the-end result turns into the returned shape) — not
// pageRange/totalPageCount's own arithmetic (lib/pagination.test.ts already
// covers that) or buildIlikeOrFilter's own string-building
// (lib/search-term.test.ts already covers that).

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
  count: number | null;
}

interface FakeQuery {
  select: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  range: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
}

/**
 * Minimal stand-in for the chainable Supabase query builder used here.
 * select/or/order all return the same object so any chain shape keeps
 * working; range()/limit() are the only two calls that actually resolve,
 * each returning `result` — real code never calls both on one query, and a
 * test asserting on call counts would catch it if that changed.
 */
function fakeQuery(result: FakeResult): FakeQuery {
  const query: FakeQuery = {
    select: vi.fn(() => query),
    or: vi.fn(() => query),
    order: vi.fn(() => query),
    range: vi.fn(async () => result),
    limit: vi.fn(async () => result),
  };
  return query;
}

/** Throws if fetchCharacterLibraryPage reaches for any table but "characters". */
function fakeSupabase(query: FakeQuery): { from: ReturnType<typeof vi.fn> } {
  return {
    from: vi.fn((table: string) => {
      if (table !== "characters") throw new Error(`Test did not stub table "${table}"`);
      return query;
    }),
  };
}

describe("fetchCharacterLibraryPage", () => {
  it("peeks with a fixed .limit(peekCount), never .range()", async () => {
    const query = fakeQuery({ data: [{ id: "1" }], error: null, count: 1 });
    const supabase = fakeSupabase(query);

    await fetchCharacterLibraryPage(supabase as never, {
      q: "",
      browsing: false,
      requestedPage: 1,
      peekCount: 6,
      pageSize: 10,
    });

    expect(query.limit).toHaveBeenCalledWith(6);
    expect(query.range).not.toHaveBeenCalled();
  });

  it("browses with .range() computed from requestedPage/pageSize, never .limit()", async () => {
    const query = fakeQuery({ data: [], error: null, count: 0 });
    const supabase = fakeSupabase(query);

    // Page 3 at pageSize 10 -> offsets [20, 29] (lib/pagination.ts's pageRange).
    await fetchCharacterLibraryPage(supabase as never, {
      q: "",
      browsing: true,
      requestedPage: 3,
      peekCount: 6,
      pageSize: 10,
    });

    expect(query.range).toHaveBeenCalledWith(20, 29);
    expect(query.limit).not.toHaveBeenCalled();
  });

  it("orders by created_at descending", async () => {
    const query = fakeQuery({ data: [], error: null, count: 0 });
    const supabase = fakeSupabase(query);

    await fetchCharacterLibraryPage(supabase as never, {
      q: "",
      browsing: true,
      requestedPage: 1,
      peekCount: 6,
      pageSize: 10,
    });

    expect(query.order).toHaveBeenCalledWith("created_at", { ascending: false });
  });

  it("skips .or() entirely for an empty search term", async () => {
    const query = fakeQuery({ data: [], error: null, count: 0 });
    const supabase = fakeSupabase(query);

    await fetchCharacterLibraryPage(supabase as never, {
      q: "",
      browsing: true,
      requestedPage: 1,
      peekCount: 6,
      pageSize: 10,
    });

    expect(query.or).not.toHaveBeenCalled();
  });

  it("filters on name/description via .or() for a non-empty search term", async () => {
    const query = fakeQuery({ data: [], error: null, count: 0 });
    const supabase = fakeSupabase(query);

    await fetchCharacterLibraryPage(supabase as never, {
      q: "robot",
      browsing: true,
      requestedPage: 1,
      peekCount: 6,
      pageSize: 10,
    });

    expect(query.or).toHaveBeenCalledWith("name.ilike.%robot%,description.ilike.%robot%");
  });

  it("returns an empty page (rows: [], totalCount: 0, totalPages: 1) for no matches", async () => {
    const query = fakeQuery({ data: [], error: null, count: 0 });
    const supabase = fakeSupabase(query);

    const page = await fetchCharacterLibraryPage(supabase as never, {
      q: "",
      browsing: true,
      requestedPage: 1,
      peekCount: 6,
      pageSize: 10,
    });

    expect(page).toEqual({ rows: [], totalCount: 0, totalPages: 1 });
  });

  it("still reports the full totalCount/totalPages for a page requested past the end", async () => {
    // Supabase's count:"exact" is independent of .range() — a stale "page 6"
    // link into a table that's shrunk to 12 rows still gets told there are
    // 12 rows / 2 pages, it's just handed back an empty `data` for that range.
    const query = fakeQuery({ data: [], error: null, count: 12 });
    const supabase = fakeSupabase(query);

    const page = await fetchCharacterLibraryPage(supabase as never, {
      q: "",
      browsing: true,
      requestedPage: 6,
      peekCount: 6,
      pageSize: 10,
    });

    expect(page).toEqual({ rows: [], totalCount: 12, totalPages: 2 });
  });

  it("treats a null count (Supabase's shape when count isn't requested/available) as 0 rather than propagating null", async () => {
    const query = fakeQuery({ data: [], error: null, count: null });
    const supabase = fakeSupabase(query);

    const page = await fetchCharacterLibraryPage(supabase as never, {
      q: "",
      browsing: true,
      requestedPage: 1,
      peekCount: 6,
      pageSize: 10,
    });

    expect(page).toEqual({ rows: [], totalCount: 0, totalPages: 1 });
  });

  it("throws on a Supabase error rather than returning it", async () => {
    const query = fakeQuery({ data: null, error: { message: "boom" }, count: null });
    const supabase = fakeSupabase(query);

    await expect(
      fetchCharacterLibraryPage(supabase as never, {
        q: "",
        browsing: true,
        requestedPage: 1,
        peekCount: 6,
        pageSize: 10,
      }),
    ).rejects.toThrow("Failed to load the character library: boom");
  });
});
