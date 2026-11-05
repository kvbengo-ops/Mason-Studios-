import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { startOfManilaDayIso, startOfManilaWeekIso, TRUSTED_WEEKLY_CAP_USD } from "./spend";
import { getDecidableRequestCount } from "./sidebar-budget";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BudgetMeter } from "@/components/sidebar-budget";

describe("passed allowance breakdown", () => {
  it("shows received headroom and passed-out headroom separately for a net sender", () => {
    const html = renderToStaticMarkup(
      createElement(BudgetMeter, {
        window: {
          period: "this week",
          remainingUsd: 7,
          capUsd: 7,
          allowanceUsd: 10,
          usedUsd: 0,
          grantUsd: -3,
        },
        displayUnit: "credits",
        grantBreakdown: { grantedInUsd: 0, receivedUsd: 1, passedOutUsd: 4 },
      }),
    );
    expect(html).toContain("+200 cr");
    expect(html).toContain("grant (received)");
    expect(html).toContain("−800 cr passed");
    expect(html).not.toMatch(/\+[−-]/);
  });

  it("keeps the explanation when the whole allowance has been passed", () => {
    const html = renderToStaticMarkup(
      createElement(BudgetMeter, {
        window: {
          period: "this week",
          remainingUsd: 0,
          capUsd: 0,
          allowanceUsd: 10,
          usedUsd: 0,
          grantUsd: -10,
        },
        displayUnit: "credits",
        grantBreakdown: { grantedInUsd: 0, receivedUsd: 0, passedOutUsd: 10 },
      }),
    );
    expect(html).toContain("−2,000 cr passed");
    expect(html).not.toContain("No allowance yet");
  });
});

// This is TASK #25's non-negotiable deliverable: proof that the sidebar's
// new ONE-round-trip read (getSidebarBudget, via db-aggregates.ts's
// getSidebarBudgetSnapshot -> the single `sidebar_budget_snapshot` RPC,
// 0044_sidebar_budget_snapshot.sql) returns the SAME numbers as the OLD
// six-read path for the same underlying data. spend.ts's
// getAccountBudgetSnapshot is left completely unchanged by this task (it
// still backs render/page.tsx and profile/page.tsx, and assertWithinSpendCaps
// enforces against the same three RPCs it calls) — so it is used here as the
// ORACLE: both paths are driven off ONE mocked createAdminClient whose
// `.rpc`/`.from` responses encode a single, consistent set of underlying
// numbers, and the two computed snapshots are asserted to agree field by
// field. If a future edit makes the new single-RPC path disagree with the
// old multi-read one, this test — not a human staring at a sidebar screenshot
// — is what catches it.
//
// This is also, incidentally, the only reason getAccountBudgetSnapshot
// remains part of the sidebar's own test surface even though
// lib/sidebar-budget.ts no longer calls it: it is the ground truth this
// change must not silently diverge from.
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
  createClient: vi.fn(),
}));

const editorProfile = {
  role: "editor" as const,
  daily_cap_override_usd: null,
  weekly_cap_override_usd: null,
};

const adminProfile = {
  role: "admin" as const,
  daily_cap_override_usd: null,
  weekly_cap_override_usd: null,
};

const trustedProfile = {
  role: "trusted_editor" as const,
  daily_cap_override_usd: null,
  weekly_cap_override_usd: null,
};

// Pinned to a Wednesday, and the clock is frozen to match in beforeEach
// below. Both matter.
//
// This test tells the daily window apart from the weekly one by the `from_ts`
// each RPC call carries — deliberately, rather than by call order, since order
// is an implementation detail of the code under test. But weeks here start on
// Monday, so ON A MONDAY the two boundaries are the SAME instant: the daily
// branch matches first and the weekly window silently receives the daily
// figure. The suite went red every Monday and green again on Tuesday, which
// reads exactly like a flake and is not one. (Caught 2026-08-24, a Monday,
// after it failed CI on main and on an unrelated PR in the same hour.)
//
// There is no product bug behind it: on the first day of the week, spend today
// genuinely IS spend this week, and the two identical calls are both correct.
// It is the discrimination trick that needs a day where the two differ.
const FIXED_NOW = new Date("2026-08-26T04:00:00.000Z"); // Wednesday noon in Manila
const dailyFromTs = startOfManilaDayIso(FIXED_NOW);
const weeklyFromTs = startOfManilaWeekIso(FIXED_NOW);

/**
 * One mocked admin client backing BOTH paths under test:
 *   - the OLD path (getAccountBudgetSnapshot) drives it via `.rpc("user_spend_usd", ...)`
 *     (called twice, once per window — distinguished by from_ts, same as
 *     spend.test.ts's own getAccountBudgetSnapshot block does),
 *     `.rpc("spend_total_usd", ...)`, `.rpc("user_active_grants_usd", ...)`,
 *     and `.from("allowance_grants")...` for the per-grant detail read.
 *   - the NEW path (getSidebarBudget) drives it via the single
 *     `.rpc("sidebar_budget_snapshot", ...)` call.
 *
 * `underlying` is the ONE set of numbers both mocked surfaces are built
 * from, so a passing test proves the two paths agree on the SAME data, not
 * on two independently-chosen canned values that merely happen to match.
 */
async function mockAdminClientWith(underlying: {
  dailySpentUsd: number;
  weeklySpentUsd: number;
  globalSpentTodayUsd: number;
  activeGrantsUsd: number;
  grantRows: { amount_usd: number; expires_at: string; transfer_peer_id?: string | null }[];
  pendingRequestId: string | null;
  pendingRequestUsd: number | null;
}): Promise<void> {
  const rpc = vi.fn((fnName: string, args: Record<string, unknown>) => {
    if (fnName === "user_spend_usd") {
      if (args.from_ts === dailyFromTs) {
        return Promise.resolve({ data: underlying.dailySpentUsd, error: null });
      }
      if (args.from_ts === weeklyFromTs) {
        return Promise.resolve({ data: underlying.weeklySpentUsd, error: null });
      }
      throw new Error(`unexpected user_spend_usd from_ts: ${String(args.from_ts)}`);
    }
    if (fnName === "spend_total_usd") {
      return Promise.resolve({ data: underlying.globalSpentTodayUsd, error: null });
    }
    if (fnName === "user_active_grants_usd") {
      return Promise.resolve({ data: underlying.activeGrantsUsd, error: null });
    }
    if (fnName === "sidebar_budget_snapshot") {
      const sorted = [...underlying.grantRows].sort((a, b) =>
        a.expires_at < b.expires_at ? -1 : 1,
      );
      return Promise.resolve({
        data: [
          {
            daily_spent_usd: underlying.dailySpentUsd,
            weekly_spent_usd: underlying.weeklySpentUsd,
            global_spent_today_usd: underlying.globalSpentTodayUsd,
            active_grants_usd: underlying.activeGrantsUsd,
            grant_count: underlying.grantRows.length,
            grant_earliest_expires_at: sorted[0]?.expires_at ?? null,
            pending_request_id: underlying.pendingRequestId,
            pending_request_usd: underlying.pendingRequestUsd,
          },
        ],
        error: null,
      });
    }
    throw new Error(`unexpected rpc call: ${fnName}`);
  });

  // getActiveGrantsSummary's own read (used only by the OLD path, via
  // getAccountBudgetSnapshot) — a plain filtered select over
  // allowance_grants, not an rpc. See spend.test.ts's identical fake for
  // why this shape (chainable select/eq/gt, terminal order) is enough.
  const grantsBuilder = {
    select: vi.fn(function (this: unknown) {
      return this;
    }),
    eq: vi.fn(function (this: unknown) {
      return this;
    }),
    gt: vi.fn(function (this: unknown) {
      return this;
    }),
    is: vi.fn(function (this: unknown) {
      return this;
    }),
    order: vi.fn(() =>
      Promise.resolve({
        data: underlying.grantRows
          .map((row) => ({ transfer_peer_id: null, ...row }))
          .sort((a, b) => (a.expires_at < b.expires_at ? -1 : 1)),
        error: null,
      }),
    ),
  };
  // app_settings holds the installation's daily-guard default (0077). Routed
  // separately because its chain is limit/maybeSingle, not the grants read's
  // select/eq/gt/is/order — one builder serving both would answer one of them
  // wrongly and quietly.
  const settingsBuilder = {
    select: vi.fn(() => settingsBuilder),
    limit: vi.fn(() => settingsBuilder),
    maybeSingle: vi.fn(() =>
      Promise.resolve({ data: { user_daily_cap_enabled: false }, error: null }),
    ),
  };
  // getInFlightSpend's read — `scenes` joined to `projects` — which BOTH
  // paths now make, and which is the whole reason it is served here rather
  // than left to fail: getInFlightSpendSafe swallows a failed read and
  // returns zero, so an unmocked `scenes` table would make both paths agree
  // on a hold of 0 by accident and prove nothing about the figure. One
  // queued 5s scene for u1 gives every window a non-zero hold to disagree
  // about if the two derivations ever drift.
  const scenesBuilder = {
    select: vi.fn(() => scenesBuilder),
    in: vi.fn(() => scenesBuilder),
    eq: vi.fn(() => scenesBuilder),
    order: vi.fn(() => scenesBuilder),
    range: vi.fn(() =>
      Promise.resolve({
        data: [
          {
            duration_s: 5,
            is_talking_head: false,
            render_settings_override: null,
            projects: { user_id: "u1", render_settings: {} },
          },
        ],
        error: null,
      }),
    ),
  };
  const from = vi.fn((table: string) => {
    if (table === "app_settings") return settingsBuilder;
    if (table === "scenes") return scenesBuilder;
    return grantsBuilder;
  });

  const { createAdminClient } = await import("@/lib/supabase/server");
  vi.mocked(createAdminClient).mockReturnValue({
    rpc,
    from,
  } as unknown as SupabaseClient<Database>);
  vi.mocked(createClient).mockResolvedValue({
    rpc: vi.fn().mockResolvedValue({
      data: [{ id: "peer", username: "Ana", email: "ana@example.com", role: "trusted_editor" }],
      error: null,
    }),
  } as unknown as SupabaseClient<Database>);
}

describe("getSidebarBudget matches getAccountBudgetSnapshot (old six-read path) for the same data", () => {
  it("maps all three grant components and the session recipient list for a net sender", async () => {
    await mockAdminClientWith({
      dailySpentUsd: 0,
      weeklySpentUsd: 0,
      globalSpentTodayUsd: 0,
      activeGrantsUsd: -3,
      grantRows: [
        { amount_usd: 2, expires_at: "2026-08-30T16:00:00.000Z" },
        { amount_usd: 1, expires_at: "2026-08-30T16:00:00.000Z", transfer_peer_id: "peer" },
        { amount_usd: -6, expires_at: "2026-08-30T16:00:00.000Z", transfer_peer_id: "peer" },
      ],
      pendingRequestId: null,
      pendingRequestUsd: null,
    });
    const { getSidebarBudget } = await import("./sidebar-budget");
    const budget = await getSidebarBudget("sender", editorProfile);
    expect(budget).toMatchObject({
      userId: "sender",
      role: "editor",
      weeklyGrantUsd: -3,
      grantedInUsd: 2,
      receivedUsd: 1,
      passedOutUsd: 6,
      transferRecipients: [
        { id: "peer", username: "Ana", email: "ana@example.com", role: "trusted_editor" },
      ],
    });
    expect(createClient).toHaveBeenCalled();
  });
  // `toFake: ["Date"]` only — faking timers wholesale would stall the awaits
  // in these tests. The code under test calls startOfManilaDayIso()/
  // startOfManilaWeekIso() with no argument, so it has to see the same
  // instant FIXED_NOW was derived from or its from_ts values miss both
  // branches of the mock.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("editor, with an active grant and a pending request: every shared field agrees exactly", async () => {
    await mockAdminClientWith({
      dailySpentUsd: 2,
      weeklySpentUsd: 8,
      globalSpentTodayUsd: 3,
      activeGrantsUsd: 5,
      grantRows: [{ amount_usd: 5, expires_at: "2026-08-23T00:00:00.000Z" }],
      pendingRequestId: "req-1",
      pendingRequestUsd: 4,
    });

    const { getAccountBudgetSnapshot } = await import("./spend");
    const { getSidebarBudget } = await import("./sidebar-budget");

    const oracle = await getAccountBudgetSnapshot("u1", editorProfile);
    const fast = await getSidebarBudget("u1", editorProfile);

    expect(fast).not.toBeNull();
    // Daily burst guard.
    expect(fast?.remainingUsd).toBe(oracle.dailyRemainingUsd);
    expect(fast?.capUsd).toBe(oracle.dailyCapUsd);
    expect(fast?.dailyUsedUsd).toBe(oracle.dailyUsedUsd);
    // Weekly allowance, including the grant breakdown.
    expect(fast?.remainingWeeklyUsd).toBe(oracle.weeklyRemainingUsd);
    expect(fast?.weeklyCapUsd).toBe(oracle.weeklyCapUsd);
    expect(fast?.weeklyUsedUsd).toBe(oracle.weeklyUsedUsd);
    expect(fast?.weeklyBaseCapUsd).toBe(oracle.weeklyBaseCapUsd);
    expect(fast?.weeklyGrantUsd).toBe(oracle.weeklyGrantUsd);
    expect(fast?.weeklyGrantCount).toBe(oracle.weeklyGrantCount);
    expect(fast?.weeklyGrantEarliestExpiresAt).toBe(oracle.weeklyGrantEarliestExpiresAt);
    // Renders in flight: held out of BOTH remaining figures above by both
    // paths. Non-zero here (one queued scene of u1's, see the mock) — a 0
    // would mean the scenes read failed and the agreement above is vacuous.
    expect(fast?.heldUsd).toBe(oracle.heldUsd);
    expect(oracle.heldUsd).toBeGreaterThan(0);
    // The pending-request fields the OLD sidebar path fetched with a
    // seventh read of its own, now folded into the single RPC row.
    expect(fast?.pendingRequestId).toBe("req-1");
    expect(fast?.pendingRequestUsd).toBe(4);
  });

  it("admin: the team-wide global figure agrees too (only populated for admins)", async () => {
    await mockAdminClientWith({
      dailySpentUsd: 1,
      weeklySpentUsd: 4,
      globalSpentTodayUsd: 9,
      activeGrantsUsd: 0,
      grantRows: [],
      pendingRequestId: null,
      pendingRequestUsd: null,
    });

    const { getAccountBudgetSnapshot } = await import("./spend");
    const { getSidebarBudget } = await import("./sidebar-budget");

    const oracle = await getAccountBudgetSnapshot("u2", adminProfile);
    const fast = await getSidebarBudget("u2", adminProfile);

    expect(fast).not.toBeNull();
    expect(fast?.globalRemainingUsd).toBe(oracle.globalRemainingUsd);
    expect(fast?.globalCapUsd).toBe(oracle.globalCapUsd);
    // No active grants: both paths agree there is no grant line.
    expect(fast?.weeklyGrantUsd).toBe(0);
    expect(fast?.weeklyGrantCount).toBe(0);
    expect(fast?.weeklyGrantEarliestExpiresAt).toBeNull();
    expect(fast?.pendingRequestId).toBeNull();
    expect(fast?.pendingRequestUsd).toBeNull();
    expect(fast?.weeklyGrantUsd).toBe(oracle.weeklyGrantUsd);
  });

  it("editor: globalRemainingUsd/globalCapUsd are null even though they were computed (admin-only display)", async () => {
    await mockAdminClientWith({
      dailySpentUsd: 0,
      weeklySpentUsd: 0,
      globalSpentTodayUsd: 0,
      activeGrantsUsd: 0,
      grantRows: [],
      pendingRequestId: null,
      pendingRequestUsd: null,
    });

    const { getSidebarBudget } = await import("./sidebar-budget");
    const fast = await getSidebarBudget("u3", editorProfile);

    expect(fast).not.toBeNull();
    expect(fast?.globalRemainingUsd).toBeNull();
    expect(fast?.globalCapUsd).toBeNull();
  });
});

describe("getSidebarBudget — fail-soft contract is preserved", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns null (not a thrown error) when the RPC read fails", async () => {
    const { createAdminClient } = await import("@/lib/supabase/server");
    vi.mocked(createAdminClient).mockReturnValue({
      rpc: vi.fn(() => Promise.resolve({ data: null, error: { message: "boom" } })),
      from: vi.fn(),
    } as unknown as SupabaseClient<Database>);

    const { getSidebarBudget } = await import("./sidebar-budget");
    const result = await getSidebarBudget("u4", editorProfile);

    expect(result).toBeNull();
  });
});

// getDecidableRequestCount backs the sidebar badge. The number it returns is
// the count of requests this viewer can ACT on, not the count of pending
// rows — the two differ by exactly the rules the badge would otherwise lie
// about, so those are what these pin.
describe("getDecidableRequestCount", () => {
  const ME = "me-1";

  function mockPending(rows: { user_id: string; requested_usd: number }[]): void {
    vi.mocked(createAdminClient).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: async () => ({ data: rows, error: null }),
        }),
      }),
    } as unknown as SupabaseClient<Database>);
  }

  it("excludes the viewer's own request — nobody decides their own (D3)", async () => {
    mockPending([
      { user_id: ME, requested_usd: 5 },
      { user_id: "other-1", requested_usd: 5 },
    ]);
    // The admin path: no ceiling applies, so the ONLY thing removed is self.
    expect(await getDecidableRequestCount(ME, adminProfile)).toBe(1);
  });

  it("excludes over-ceiling requests for a peer, but not for an admin (D4)", async () => {
    // TRUSTED_WEEKLY_CAP_USD is the peer approval ceiling — see
    // actions/allowance.test.ts's OVER_CEILING_USD for why it is no longer
    // the regular editor's figure.
    const over = TRUSTED_WEEKLY_CAP_USD + 1;
    const rows = [
      { user_id: "other-1", requested_usd: 1 },
      { user_id: "other-2", requested_usd: over },
    ];

    mockPending(rows);
    // A peer may approve one of these two. A badge saying "2" would send
    // them to a page where the second row reads "Over your approval limit".
    expect(await getDecidableRequestCount(ME, trustedProfile)).toBe(1);

    mockPending(rows);
    expect(await getDecidableRequestCount(ME, adminProfile)).toBe(2);
  });

  it("returns 0 for an account that may not decide anything", async () => {
    mockPending([{ user_id: "other-1", requested_usd: 1 }]);
    // A plain editor never reaches the badge (the nav link is hidden), but
    // the count must not claim otherwise if it ever does.
    expect(await getDecidableRequestCount(ME, editorProfile)).toBe(0);
  });

  it("returns null on a failed read rather than a wrong number", async () => {
    vi.mocked(createAdminClient).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: async () => ({ data: null, error: { message: "boom" } }),
        }),
      }),
    } as unknown as SupabaseClient<Database>);
    // null and 0 both render nothing — see the badge tests in
    // components/sidebar-shell.test.tsx — so a broken read is quiet, not a
    // zero that reads as "you are all caught up".
    expect(await getDecidableRequestCount(ME, adminProfile)).toBeNull();
  });
});
