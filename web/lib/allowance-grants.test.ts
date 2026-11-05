import { describe, expect, it } from "vitest";
import { grantAmountAlreadyDrawnUsd, revokeActiveGrantsFor } from "@/lib/allowance-grants";

// The arithmetic behind "End grant" landing an account at ZERO remaining
// rather than in deficit. See actions/allowance.ts's endActiveGrants for why
// that is the behaviour, and lib/allowance-grants.ts for why the overshoot
// above the base cap is a sound stand-in for "how much of the grant was
// spent" without a grant_id on runs.
describe("grantAmountAlreadyDrawnUsd", () => {
  it("is the overshoot above the base cap", () => {
    // $10 base, $10 granted, $15 spent — $5 of the grant is gone.
    expect(grantAmountAlreadyDrawnUsd(15, 10, 10)).toBe(5);
  });

  it("is zero when they never spent past their own allowance", () => {
    // The grant was never drawn on, so ending it costs them nothing and no
    // replacement is written at all.
    expect(grantAmountAlreadyDrawnUsd(8, 10, 10)).toBe(0);
  });

  it("is zero at exactly the base cap, not a rounding artefact", () => {
    expect(grantAmountAlreadyDrawnUsd(10, 10, 10)).toBe(0);
  });

  it("returns the whole grant when every dollar of it was spent", () => {
    expect(grantAmountAlreadyDrawnUsd(20, 10, 10)).toBe(10);
  });

  // The clamp that stops this manufacturing headroom. Spend can exceed base
  // + grants — in-flight estimates are counted at enqueue while `runs` lands
  // at completion, and the caps are documented as a point-in-time snapshot
  // with a real concurrency hole. Without the clamp, an account $30 past its
  // base with only $10 of grants would be re-granted $20: MORE than was
  // ended, which would leave it able to spend again.
  it("never hands back more than was actually ended", () => {
    expect(grantAmountAlreadyDrawnUsd(40, 10, 10)).toBe(10);
  });

  it("treats a zeroed base cap as everything spent being drawn", () => {
    // A suspended account (weekly override 0) that still holds a grant.
    expect(grantAmountAlreadyDrawnUsd(4, 0, 10)).toBe(4);
  });

  it("is zero when nothing was ended, whatever the spend", () => {
    expect(grantAmountAlreadyDrawnUsd(99, 10, 0)).toBe(0);
  });
});

// The mint an admin revoke could cause once passes exist
// (0087_pass_allowance.sql). A pass is two rows summing to zero, and only
// the sender's negative half sits on the revoked account: end that alone and
// the recipient's positive half survives, so the team pool GAINS the amount
// out of nothing. The filter is the whole fix, so the filter is what this
// pins — a fake that only honours the four calls the helper makes, and fails
// loudly on any it does not.
describe("revokeActiveGrantsFor", () => {
  function fakeAdmin(rows: { id: string; amount_usd: number; transfer_peer_id: string | null }[]) {
    const filters: [string, unknown][] = [];
    const builder = {
      update: () => builder,
      in: (col: string, v: unknown) => (filters.push([`in:${col}`, v]), builder),
      gt: (col: string, v: unknown) => (filters.push([`gt:${col}`, v]), builder),
      is: (col: string, v: unknown) => (filters.push([`is:${col}`, v]), builder),
      // The awaited terminal call. Only rows the recorded filters admit come
      // back, which is what makes the returned totalUsd meaningful below.
      select: async () => ({
        data: filters.some(([f]) => f === "is:transfer_peer_id")
          ? rows.filter((r) => r.transfer_peer_id === null)
          : rows,
        error: null,
      }),
    };
    return { from: () => builder, filters } as never as Parameters<
      typeof revokeActiveGrantsFor
    >[0] & { filters: [string, unknown][] };
  }

  const NOW = "2026-09-09T00:00:00.000Z";

  it("skips both halves of a pass", async () => {
    const admin = fakeAdmin([
      { id: "grant", amount_usd: 20, transfer_peer_id: null },
      { id: "sent", amount_usd: -30, transfer_peer_id: "peer" },
      { id: "received", amount_usd: 30, transfer_peer_id: "peer" },
    ]);

    const ended = await revokeActiveGrantsFor(admin, ["a"], "admin", NOW);

    expect(admin.filters).toContainEqual(["is:transfer_peer_id", null]);
    // Without the filter this is 3 rows and $20 — the -30 and +30 cancelling
    // to a total that looks right while the ledger has been torn in half.
    expect(ended).toEqual({ count: 1, totalUsd: 20 });
  });

  it("still scopes to unexpired, unrevoked rows on the named accounts", async () => {
    const admin = fakeAdmin([]);

    await revokeActiveGrantsFor(admin, ["a", "b"], "admin", NOW);

    expect(admin.filters).toEqual([
      ["in:user_id", ["a", "b"]],
      ["gt:expires_at", NOW],
      ["is:revoked_at", null],
      ["is:transfer_peer_id", null],
    ]);
  });

  it("makes no round trip at all for an empty account list", async () => {
    const admin = fakeAdmin([{ id: "grant", amount_usd: 5, transfer_peer_id: null }]);

    expect(await revokeActiveGrantsFor(admin, [], "admin", NOW)).toEqual({
      count: 0,
      totalUsd: 0,
    });
    expect(admin.filters).toEqual([]);
  });
});
