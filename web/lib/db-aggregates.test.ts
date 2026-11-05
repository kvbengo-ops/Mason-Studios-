import { describe, expect, it, vi } from "vitest";
import {
  getOutstandingAllowanceUsd,
  getProjectCostTotals,
  getProjectSpend,
  getSpendCategoryTotals,
  getSpendCategoryTotalsByUser,
  getSpendTotalUsd,
  getSpendTotalsByUser,
  getUserActiveGrantsTotals,
  getUserActiveGrantsUsd,
  getUserProjectCounts,
  getUserSpendUsd,
} from "./db-aggregates";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

// These three functions take a client as an argument rather than
// constructing their own (see actions/project.ts and the rest of this
// codebase's convention), so — unlike lib/storage.test.ts or spend/page.tsx
// itself — there's no module to vi.mock() here. A minimal fake standing in
// for the two Supabase call shapes these functions use
// (`.from(...).select(...).in(...)` and `.rpc(fn, args)`, both now plain
// `Database["public"]` members — see types/db.ts) is enough to exercise the
// mapping/error logic in isolation.
interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

function fakeFromBuilder(result: FakeResult): {
  select: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
} {
  const builder = {
    select: vi.fn(() => builder),
    in: vi.fn(() => Promise.resolve(result)),
  };
  return builder;
}

// getProjectSpend's shape: `.from(...).select(...).eq(...).range(...)`.
// `results` is one entry per expected page — pass a single entry for the
// ordinary case (one short page, so the loop breaks immediately).
function fakeEqBuilder(...results: FakeResult[]): {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  range: ReturnType<typeof vi.fn>;
} {
  let page = 0;
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    // Repeating the last page past the end would spin forever if the
    // function under test ever stopped breaking on a short page; running
    // off the array surfaces that as a failure instead of a hung suite.
    range: vi.fn(() => Promise.resolve(results[page++] ?? { data: [], error: null })),
  };
  return builder;
}

function fakeClient(args: {
  from?: ReturnType<typeof vi.fn>;
  rpc?: ReturnType<typeof vi.fn>;
}): SupabaseClient<Database> {
  return {
    from: args.from ?? vi.fn(),
    rpc: args.rpc ?? vi.fn(),
  } as unknown as SupabaseClient<Database>;
}

describe("getProjectCostTotals", () => {
  it("maps project_cost_totals rows into a Map keyed by project_id", async () => {
    const fromBuilder = fakeFromBuilder({
      data: [
        { project_id: "p1", total_cost_usd: 12.5 },
        { project_id: "p2", total_cost_usd: 0.75 },
      ],
      error: null,
    });
    const from = vi.fn(() => fromBuilder);
    const supabase = fakeClient({ from });

    const result = await getProjectCostTotals(supabase, ["p1", "p2"]);

    expect(from).toHaveBeenCalledWith("project_cost_totals");
    expect(fromBuilder.in).toHaveBeenCalledWith("project_id", ["p1", "p2"]);
    expect(result.get("p1")).toBe(12.5);
    expect(result.get("p2")).toBe(0.75);
  });

  it("leaves a project with no runs (and so no row in the view) absent from the Map", async () => {
    const fromBuilder = fakeFromBuilder({
      data: [{ project_id: "p1", total_cost_usd: 3 }],
      error: null,
    });
    const from = vi.fn(() => fromBuilder);
    const supabase = fakeClient({ from });

    const result = await getProjectCostTotals(supabase, ["p1", "p2"]);

    expect(result.get("p1")).toBe(3);
    expect(result.has("p2")).toBe(false);
    expect(result.get("p2") ?? 0).toBe(0);
  });

  it("returns an empty Map without querying at all for an empty id list", async () => {
    const from = vi.fn();
    const supabase = fakeClient({ from });

    const result = await getProjectCostTotals(supabase, []);

    expect(result.size).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });

  it("throws when the query errors", async () => {
    const fromBuilder = fakeFromBuilder({ data: null, error: { message: "boom" } });
    const supabase = fakeClient({ from: vi.fn(() => fromBuilder) });

    await expect(getProjectCostTotals(supabase, ["p1"])).rejects.toThrow(/boom/);
  });
});

describe("getProjectSpend", () => {
  // The regression this function exists for: a freshly created project's
  // "Spend to date" (Deliver page) must equal prompt + image + video. The
  // compile run carries scene_id NULL — the old query reached `runs`
  // through `scenes!inner(project_id)`, and that join drops exactly this
  // row, so the page showed $0.54 for a $0.55 project while the account was
  // charged all $0.55.
  const freshProjectRuns = [
    { scene_id: null, cost_usd: 0.01 }, // claude-haiku-4-5 script compile
    { scene_id: "s1", cost_usd: 0.04 }, // fal reference frame
    { scene_id: "s1", cost_usd: 0.5 }, // fal video render
  ];

  it("counts the scene-less compile run in the project total", async () => {
    const fromBuilder = fakeEqBuilder({ data: freshProjectRuns, error: null });
    const from = vi.fn(() => fromBuilder);

    const spend = await getProjectSpend(fakeClient({ from }), "p1");

    expect(spend.totalUsd).toBeCloseTo(0.55, 10);
    // The assertion that fails if anyone reintroduces the scenes hop:
    // filtered on runs.project_id, with no scenes embed in the select.
    expect(from).toHaveBeenCalledWith("runs");
    expect(fromBuilder.select).toHaveBeenCalledWith("scene_id, cost_usd");
    expect(fromBuilder.eq).toHaveBeenCalledWith("project_id", "p1");
    // A project this small is still exactly one round trip — paging must
    // not cost a second request in the ordinary case.
    expect(fromBuilder.range).toHaveBeenCalledTimes(1);
    expect(fromBuilder.range).toHaveBeenCalledWith(0, 999);
  });

  it("leaves the scene-less run out of the per-scene breakdown", async () => {
    const fromBuilder = fakeEqBuilder({ data: freshProjectRuns, error: null });

    const spend = await getProjectSpend(fakeClient({ from: vi.fn(() => fromBuilder) }), "p1");

    expect(spend.bySceneId).toEqual({ s1: 0.54 });
    // totalUsd - sum(bySceneId) is the project-level spend, by construction.
    const sceneTotal = Object.values(spend.bySceneId).reduce((a, b) => a + b, 0);
    expect(spend.totalUsd - sceneTotal).toBeCloseTo(0.01, 10);
  });

  it("treats a null cost_usd (a failure this codebase won't claim was billed) as 0", async () => {
    const fromBuilder = fakeEqBuilder({
      data: [
        { scene_id: null, cost_usd: null },
        { scene_id: "s1", cost_usd: 0.5 },
      ],
      error: null,
    });

    const spend = await getProjectSpend(fakeClient({ from: vi.fn(() => fromBuilder) }), "p1");

    expect(spend.totalUsd).toBe(0.5);
    expect(spend.bySceneId).toEqual({ s1: 0.5 });
  });

  it("reads a project with no runs at all as $0, not as an error", async () => {
    const fromBuilder = fakeEqBuilder({ data: [], error: null });

    const spend = await getProjectSpend(fakeClient({ from: vi.fn(() => fromBuilder) }), "p1");

    expect(spend).toEqual({ totalUsd: 0, bySceneId: {} });
  });

  // PostgREST returns max_rows (1000) and no error when a select overruns
  // it, so an unpaged read reports a smaller bill than the account was
  // charged — the same silent under-report 0026_cost_aggregates.sql's
  // header records, and the same class of bug the scenes hop above caused.
  it("keeps reading past the 1000-row PostgREST cap", async () => {
    const fullPage = Array.from({ length: 1000 }, (_unused, i) => ({
      scene_id: `s${i}`,
      cost_usd: 0.5,
    }));
    const fromBuilder = fakeEqBuilder(
      { data: fullPage, error: null },
      { data: [{ scene_id: "s1000", cost_usd: 0.25 }], error: null },
    );

    const spend = await getProjectSpend(fakeClient({ from: vi.fn(() => fromBuilder) }), "p1");

    // 1000 * 0.5 + 0.25 — the second page's run is the one an unpaged read
    // drops on the floor.
    expect(spend.totalUsd).toBeCloseTo(500.25, 10);
    expect(spend.bySceneId.s1000).toBeCloseTo(0.25, 10);
    expect(fromBuilder.range).toHaveBeenCalledTimes(2);
    expect(fromBuilder.range).toHaveBeenNthCalledWith(2, 1000, 1999);
  });

  it("throws when the query errors", async () => {
    const fromBuilder = fakeEqBuilder({ data: null, error: { message: "boom" } });

    await expect(
      getProjectSpend(fakeClient({ from: vi.fn(() => fromBuilder) }), "p1"),
    ).rejects.toThrow(/boom/);
  });
});

describe("getUserProjectCounts", () => {
  it("maps user_project_counts rows into a Map keyed by user_id", async () => {
    const fromBuilder = fakeFromBuilder({
      data: [
        { user_id: "u1", project_count: 3 },
        { user_id: "u2", project_count: 1 },
      ],
      error: null,
    });
    const from = vi.fn(() => fromBuilder);
    const supabase = fakeClient({ from });

    const result = await getUserProjectCounts(supabase, ["u1", "u2"]);

    expect(from).toHaveBeenCalledWith("user_project_counts");
    expect(fromBuilder.in).toHaveBeenCalledWith("user_id", ["u1", "u2"]);
    expect(result.get("u1")).toBe(3);
    expect(result.get("u2")).toBe(1);
  });

  it("leaves a user with no projects (and so no row in the view) absent from the Map", async () => {
    const fromBuilder = fakeFromBuilder({
      data: [{ user_id: "u1", project_count: 2 }],
      error: null,
    });
    const from = vi.fn(() => fromBuilder);
    const supabase = fakeClient({ from });

    const result = await getUserProjectCounts(supabase, ["u1", "u2"]);

    expect(result.get("u1")).toBe(2);
    expect(result.has("u2")).toBe(false);
    expect(result.get("u2") ?? 0).toBe(0);
  });

  it("returns an empty Map without querying at all for an empty id list", async () => {
    const from = vi.fn();
    const supabase = fakeClient({ from });

    const result = await getUserProjectCounts(supabase, []);

    expect(result.size).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });

  it("throws when the query errors", async () => {
    const fromBuilder = fakeFromBuilder({ data: null, error: { message: "boom" } });
    const supabase = fakeClient({ from: vi.fn(() => fromBuilder) });

    await expect(getUserProjectCounts(supabase, ["u1"])).rejects.toThrow(/boom/);
  });
});

describe("getSpendTotalUsd", () => {
  it("calls spend_total_usd with the given range and returns its total", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: 42.5, error: null }));
    const supabase = fakeClient({ rpc });

    const result = await getSpendTotalUsd(
      supabase,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(rpc).toHaveBeenCalledWith("spend_total_usd", {
      from_ts: "2026-08-01T00:00:00.000Z",
      to_ts: "2026-08-02T00:00:00.000Z",
    });
    expect(result).toBe(42.5);
  });

  it("defaults to 0 when the function returns null", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    const supabase = fakeClient({ rpc });

    const result = await getSpendTotalUsd(
      supabase,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(result).toBe(0);
  });

  it("throws when the RPC errors", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: { message: "boom" } }));
    const supabase = fakeClient({ rpc });

    await expect(
      getSpendTotalUsd(supabase, "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"),
    ).rejects.toThrow(/boom/);
  });

  // Regression for 0040_include_archived_cost_in_spend_reads.sql: spend_total_usd's SQL body now
  // UNION ALLs deleted_project_cost_history into the sum (a deleted project's spend must still
  // count), but the RPC shape returned to this function is unchanged -- still a single number. This
  // function is a plain passthrough with no client-side filtering, so a total that is LARGER than
  // what live `runs` alone would produce (because it includes an archived, deleted project's cost)
  // must come through exactly as returned, with no special-casing needed here.
  it("passes through a total that includes archived (deleted-project) spend unchanged", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: 137.42, error: null }));
    const supabase = fakeClient({ rpc });

    const result = await getSpendTotalUsd(
      supabase,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(result).toBe(137.42);
  });
});

describe("getUserSpendUsd", () => {
  it("calls user_spend_usd with the target user and range and returns its total", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: 12.34, error: null }));
    const supabase = fakeClient({ rpc });

    const result = await getUserSpendUsd(
      supabase,
      "u1",
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(rpc).toHaveBeenCalledWith("user_spend_usd", {
      target_user_id: "u1",
      from_ts: "2026-08-01T00:00:00.000Z",
      to_ts: "2026-08-02T00:00:00.000Z",
    });
    expect(result).toBe(12.34);
  });

  it("defaults to 0 when the function returns null", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    const supabase = fakeClient({ rpc });

    const result = await getUserSpendUsd(
      supabase,
      "u1",
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(result).toBe(0);
  });

  // Regression for 0040_include_archived_cost_in_spend_reads.sql: user_spend_usd's SQL body now
  // unions in this user's rows from deleted_project_cost_history (matched on the archive's own
  // user_id column, not email) so that deleting a project no longer refunds the daily/weekly cap.
  // Same passthrough contract as spend_total_usd above -- nothing here needs to change for that.
  it("passes through a total that includes this user's archived (deleted-project) spend", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: 58.1, error: null }));
    const supabase = fakeClient({ rpc });

    const result = await getUserSpendUsd(
      supabase,
      "u1",
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(result).toBe(58.1);
  });

  it("throws when the RPC errors", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: { message: "boom" } }));
    const supabase = fakeClient({ rpc });

    await expect(
      getUserSpendUsd(supabase, "u1", "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"),
    ).rejects.toThrow(/boom/);
  });
});

describe("getSpendTotalsByUser", () => {
  it("maps rows into UserSpendTotal, camelCasing the field names", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: [{ user_id: "u1", email: "a@b.com", total_usd: 10 }],
        error: null,
      }),
    );
    const supabase = fakeClient({ rpc });

    const result = await getSpendTotalsByUser(
      supabase,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(rpc).toHaveBeenCalledWith("spend_totals_by_user", {
      from_ts: "2026-08-01T00:00:00.000Z",
      to_ts: "2026-08-02T00:00:00.000Z",
    });
    expect(result).toEqual([{ userId: "u1", email: "a@b.com", totalUsd: 10 }]);
  });

  it("falls back email to the user id when the profile row is missing (LEFT JOIN)", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({ data: [{ user_id: "u1", email: null, total_usd: 5 }], error: null }),
    );
    const supabase = fakeClient({ rpc });

    const result = await getSpendTotalsByUser(
      supabase,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(result).toEqual([{ userId: "u1", email: "u1", totalUsd: 5 }]);
  });

  // Regression for 0040_include_archived_cost_in_spend_reads.sql: spend_totals_by_user's SQL body
  // now unions in each user's rows from deleted_project_cost_history (matched on user_id, so a
  // deleted project's spend still lands under its owner). The RPC's row shape is unchanged --
  // every row still has a non-null user_id, since the SQL excludes archived rows whose user_id
  // couldn't be resolved (pre-0040 history with no matching profiles email) from this per-user
  // grouping entirely rather than surfacing a partial/null-keyed row here.
  it("passes through per-user totals that include archived (deleted-project) spend", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: [{ user_id: "u1", email: "a@b.com", total_usd: 91.2 }],
        error: null,
      }),
    );
    const supabase = fakeClient({ rpc });

    const result = await getSpendTotalsByUser(
      supabase,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(result).toEqual([{ userId: "u1", email: "a@b.com", totalUsd: 91.2 }]);
  });

  it("throws when the RPC errors", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: { message: "boom" } }));
    const supabase = fakeClient({ rpc });

    await expect(
      getSpendTotalsByUser(supabase, "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"),
    ).rejects.toThrow(/boom/);
  });
});

describe("getUserActiveGrantsUsd", () => {
  it("calls user_active_grants_usd with the given user and instant, and returns the total", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: 15, error: null }));
    const supabase = fakeClient({ rpc });

    const result = await getUserActiveGrantsUsd(supabase, "u1", "2026-08-14T00:00:00.000Z");

    expect(rpc).toHaveBeenCalledWith("user_active_grants_usd", {
      target_user_id: "u1",
      at_ts: "2026-08-14T00:00:00.000Z",
    });
    expect(result).toBe(15);
  });

  it("defaults to 0 when the function returns null (no active grants)", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    const supabase = fakeClient({ rpc });

    const result = await getUserActiveGrantsUsd(supabase, "u1", "2026-08-14T00:00:00.000Z");

    expect(result).toBe(0);
  });

  it("throws when the RPC errors", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: { message: "boom" } }));
    const supabase = fakeClient({ rpc });

    await expect(
      getUserActiveGrantsUsd(supabase, "u1", "2026-08-14T00:00:00.000Z"),
    ).rejects.toThrow(/boom/);
  });
});

// getUserActiveGrantsUsd's batched twin — /users' Active grants column,
// replacing an unbounded `.from("allowance_grants")...` fetch-and-reduce
// that silently truncated past PostgREST's max_rows = 1000. See
// 0033_allowance_requests_rls_fix.sql for the SQL side.
describe("getUserActiveGrantsTotals", () => {
  it("maps rows into a Map keyed by user_id, camelCasing the field names", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: [
          { user_id: "u1", total_usd: 15, grant_count: 2, approver_grant_count: 1, latest_transfer_amount_usd: null },
          { user_id: "u2", total_usd: 5, grant_count: 2, approver_grant_count: 0, latest_transfer_amount_usd: -0.5 },
        ],
        error: null,
      }),
    );
    const supabase = fakeClient({ rpc });

    const result = await getUserActiveGrantsTotals(
      supabase,
      ["u1", "u2"],
      "2026-08-14T00:00:00.000Z",
    );

    expect(rpc).toHaveBeenCalledWith("user_active_grants_usd_by_user", {
      target_user_ids: ["u1", "u2"],
      at_ts: "2026-08-14T00:00:00.000Z",
    });
    expect(result.get("u1")).toEqual({ totalUsd: 15, count: 2, endableCount: 1, latestTransferAmountUsd: null });
    // Latest direction stays outgoing even when the net transfer total is positive.
    expect(result.get("u2")).toEqual({ totalUsd: 5, count: 2, endableCount: 0, latestTransferAmountUsd: -0.5 });
  });

  it("leaves a user with no active grants (no row in the result) absent from the Map", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: [{ user_id: "u1", total_usd: 5, grant_count: 1, approver_grant_count: 1 }],
        error: null,
      }),
    );
    const supabase = fakeClient({ rpc });

    const result = await getUserActiveGrantsTotals(
      supabase,
      ["u1", "u2"],
      "2026-08-14T00:00:00.000Z",
    );

    expect(result.has("u1")).toBe(true);
    expect(result.has("u2")).toBe(false);
  });

  it("returns an empty Map without calling the RPC at all for an empty id list", async () => {
    const rpc = vi.fn();
    const supabase = fakeClient({ rpc });

    const result = await getUserActiveGrantsTotals(supabase, [], "2026-08-14T00:00:00.000Z");

    expect(result.size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("throws when the RPC errors", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: { message: "boom" } }));
    const supabase = fakeClient({ rpc });

    await expect(
      getUserActiveGrantsTotals(supabase, ["u1"], "2026-08-14T00:00:00.000Z"),
    ).rejects.toThrow(/boom/);
  });
});

// getOutstandingAllowanceUsd — the wrapper around outstanding_allowance_usd
// (0035_outstanding_allowance.sql), the Part 3 "number nobody has today"
// (20 editors x $10/week vs. ~$31 funded) computed as one bounded SQL
// aggregate rather than fetched-and-reduced — see that migration's header
// for the max_rows = 1000 risk this shape avoids. This file can't exercise
// the SQL itself (no live database in vitest — same limitation every other
// RPC wrapper here has), so this pins the contract this function promises
// its callers: the right args reach the RPC, and its result/null/error
// handling matches every other thin `.rpc(...)` wrapper in this file.
describe("getOutstandingAllowanceUsd", () => {
  it("calls outstanding_allowance_usd with the two role-default weekly figures and returns the total", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: 169, error: null }));
    const supabase = fakeClient({ rpc });

    const result = await getOutstandingAllowanceUsd(supabase, 10, 25);

    expect(rpc).toHaveBeenCalledWith("outstanding_allowance_usd", {
      editor_weekly_default: 10,
      trusted_weekly_default: 25,
    });
    expect(result).toBe(169);
  });

  it("defaults to 0 when the function returns null", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    const supabase = fakeClient({ rpc });

    const result = await getOutstandingAllowanceUsd(supabase, 10, 25);

    expect(result).toBe(0);
  });

  it("throws when the RPC errors", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: { message: "boom" } }));
    const supabase = fakeClient({ rpc });

    await expect(getOutstandingAllowanceUsd(supabase, 10, 25)).rejects.toThrow(/boom/);
  });
});

// getSpendCategoryTotals — the Part 1 team-wide iterate-vs-render split
// (0037_spend_category_totals.sql). Same "can't exercise the SQL itself"
// limitation as every other RPC wrapper above (see getOutstandingAllowance
// Usd's own header) — what IS tested here is the wrapper's own contract:
// the right args reach the RPC, the single returned row unwraps correctly,
// and — the meaningful part, not a tautology — that iterateUsd + renderUsd
// equals the SEPARATELY-returned total_usd field from the fixture, proving
// this wrapper reads and sums the three columns the SQL function returns
// without transposing or dropping one of them.
describe("getSpendCategoryTotals", () => {
  it("calls spend_category_totals with the given range and unwraps the single row", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: [{ iterate_usd: 3.5, render_usd: 12.75, total_usd: 16.25 }],
        error: null,
      }),
    );
    const supabase = fakeClient({ rpc });

    const result = await getSpendCategoryTotals(
      supabase,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(rpc).toHaveBeenCalledWith("spend_category_totals", {
      from_ts: "2026-08-01T00:00:00.000Z",
      to_ts: "2026-08-02T00:00:00.000Z",
    });
    expect(result).toEqual({ iterateUsd: 3.5, renderUsd: 12.75, totalUsd: 16.25 });
    // The identity the task requires: the split sums to the same total the
    // fixture (standing in for spend_total_usd's own figure — both are
    // computed from the same unconditional sum(cost_usd) in SQL, see
    // 0037_spend_category_totals.sql's header) reports.
    expect(result.iterateUsd + result.renderUsd).toBeCloseTo(result.totalUsd, 10);
  });

  it("defaults every field to 0 when the function returns no row", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: [], error: null }));
    const supabase = fakeClient({ rpc });

    const result = await getSpendCategoryTotals(
      supabase,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(result).toEqual({ iterateUsd: 0, renderUsd: 0, totalUsd: 0 });
  });

  // Regression for 0040_include_archived_cost_in_spend_reads.sql: spend_category_totals's SQL body
  // now unions in deleted_project_cost_history (categorized by the same vendor/model predicate,
  // since the archive carries both columns verbatim from runs) before splitting into iterate/render.
  // The invariant above must still hold once archived rows are part of the sum, not just for live
  // runs alone.
  it("still sums iterateUsd + renderUsd to totalUsd once archived spend is included", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: [{ iterate_usd: 8.25, render_usd: 40.0, total_usd: 48.25 }],
        error: null,
      }),
    );
    const supabase = fakeClient({ rpc });

    const result = await getSpendCategoryTotals(
      supabase,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(result).toEqual({ iterateUsd: 8.25, renderUsd: 40.0, totalUsd: 48.25 });
    expect(result.iterateUsd + result.renderUsd).toBeCloseTo(result.totalUsd, 10);
  });

  it("throws when the RPC errors", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: { message: "boom" } }));
    const supabase = fakeClient({ rpc });

    await expect(
      getSpendCategoryTotals(supabase, "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"),
    ).rejects.toThrow(/boom/);
  });
});

describe("getSpendCategoryTotalsByUser", () => {
  it("maps rows into UserSpendCategoryTotal, camelCasing the field names", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: [{ user_id: "u1", email: "a@b.com", iterate_usd: 1, render_usd: 9, total_usd: 10 }],
        error: null,
      }),
    );
    const supabase = fakeClient({ rpc });

    const result = await getSpendCategoryTotalsByUser(
      supabase,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(rpc).toHaveBeenCalledWith("spend_category_totals_by_user", {
      from_ts: "2026-08-01T00:00:00.000Z",
      to_ts: "2026-08-02T00:00:00.000Z",
    });
    expect(result).toEqual([
      { userId: "u1", email: "a@b.com", iterateUsd: 1, renderUsd: 9, totalUsd: 10 },
    ]);
  });

  it("falls back email to the user id when the profile row is missing (LEFT JOIN)", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: [{ user_id: "u1", email: null, iterate_usd: 2, render_usd: 0, total_usd: 2 }],
        error: null,
      }),
    );
    const supabase = fakeClient({ rpc });

    const result = await getSpendCategoryTotalsByUser(
      supabase,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(result[0]?.email).toBe("u1");
  });

  it("throws when the RPC errors", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: { message: "boom" } }));
    const supabase = fakeClient({ rpc });

    await expect(
      getSpendCategoryTotalsByUser(
        supabase,
        "2026-08-01T00:00:00.000Z",
        "2026-08-02T00:00:00.000Z",
      ),
    ).rejects.toThrow(/boom/);
  });
});
