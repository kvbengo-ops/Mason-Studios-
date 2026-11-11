import { afterEach, describe, expect, it, vi } from "vitest";
import { requestAllowance, cancelAllowanceRequest, decideAllowanceRequest } from "./allowance";
import { requireUser, requireApprover } from "@/actions/guard";
import { TRUSTED_WEEKLY_CAP_USD, endOfManilaDayIso } from "@/lib/spend";
import { createClient, createAdminClient } from "@/lib/supabase/server";

// Same fakes-over-the-two-boundaries approach as actions/project.test.ts:
// the ownership/role guards (actions/guard.ts) and the two Supabase client
// factories are mocked; next/cache's revalidatePath is a no-op outside a
// real request.
vi.mock("@/actions/guard", () => ({
  requireUser: vi.fn(),
  requireApprover: vi.fn(),
  AuthorizationError: class AuthorizationError extends Error {},
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

interface FakeQueryResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

interface FakeQueryBuilder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
  then: (
    onFulfilled: (result: FakeQueryResult) => unknown,
    onRejected?: (error: unknown) => unknown,
  ) => Promise<unknown>;
}

/** Minimal chainable Supabase query builder stand-in — every intermediate call returns itself; `.maybeSingle()` and a bare `await` both resolve to the fixed result. */
function fakeBuilder(result: FakeQueryResult): FakeQueryBuilder {
  const builder: FakeQueryBuilder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    update: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
    rpc: vi.fn(),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

function fakeClient(
  tables: Record<string, FakeQueryBuilder>,
  rpc?: ReturnType<typeof vi.fn>,
): { from: ReturnType<typeof vi.fn>; rpc: ReturnType<typeof vi.fn> } {
  return {
    from: vi.fn((table: string) => {
      const builder = tables[table];
      if (!builder) {
        throw new Error(`Unexpected table in test: ${table}`);
      }
      return builder;
    }),
    rpc: rpc ?? vi.fn(),
  };
}

const USER = { id: "user-1", email: "editor@example.com" };
const ADMIN = { id: "admin-1", email: "admin@example.com" };
const TRUSTED = { id: "trusted-1", email: "trusted@example.com" };

// decideAllowanceRequest reads profile.role now (0074_peer_allowance_
// approval.sql gave trusted editors the right to decide, with a ceiling and
// a forced expiry an admin does not have), so the guard's return value can no
// longer be an empty object.
const ADMIN_PROFILE = { role: "admin" } as never;
const TRUSTED_PROFILE = { role: "trusted_editor" } as never;

// The peer ceiling is TRUSTED_WEEKLY_CAP_USD, read from lib/spend.ts rather
// than hard-coded: these assertions must keep meaning "at / over the real
// ceiling" if the cap default ever moves.
//
// It was WEEKLY_CAP_USD — the REGULAR editor's weekly allowance — until that
// default became 0 (a new account spends nothing until an admin acts).
// decisionBlockReason treats a ceiling of 0 as unreadable and blocks, so a
// zero-based peer ceiling would have refused every peer approval with "your
// approval limit couldn't be read". A trusted editor's approval limit is now
// their own tier's weekly allowance, which is also what it should have been:
// tying it to a different role's number was a coincidence of both tiers
// having one.
const OVER_CEILING_USD = TRUSTED_WEEKLY_CAP_USD + 1;

afterEach(() => {
  vi.resetAllMocks();
});

describe("requestAllowance", () => {
  it("refuses a non-positive amount without touching the database", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });

    const result = await requestAllowance(0, null);

    expect(result).toEqual({ error: expect.stringMatching(/positive allowance amount/i) });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("inserts a pending request for the caller's own user_id", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });
    const insertBuilder = fakeBuilder({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue(
      fakeClient({ allowance_requests: insertBuilder }) as never,
    );

    const result = await requestAllowance(10, "  need it for a campaign  ");

    expect(result).toBeUndefined();
    expect(insertBuilder.insert).toHaveBeenCalledWith({
      user_id: USER.id,
      requested_usd: 10,
      reason: "need it for a campaign",
    });
  });

  it("turns a unique-violation (one-pending-request-per-user, 0032_allowance_requests.sql) into an actionable returned error, not a throw", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });
    const insertBuilder = fakeBuilder({
      data: null,
      error: { message: "duplicate", code: "23505" },
    });
    vi.mocked(createAdminClient).mockReturnValue(
      fakeClient({ allowance_requests: insertBuilder }) as never,
    );

    const result = await requestAllowance(10, null);

    expect(result).toEqual({ error: expect.stringMatching(/already have a pending/i) });
  });

  it("throws (does not return) on any other database error", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });
    const insertBuilder = fakeBuilder({ data: null, error: { message: "connection reset" } });
    vi.mocked(createAdminClient).mockReturnValue(
      fakeClient({ allowance_requests: insertBuilder }) as never,
    );

    await expect(requestAllowance(10, null)).rejects.toThrow(/connection reset/);
  });
});

describe("cancelAllowanceRequest", () => {
  it("refuses when the request belongs to someone else", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });
    const selectBuilder = fakeBuilder({
      data: { id: "r1", user_id: "someone-else", status: "pending" },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }) as never,
    );

    const result = await cancelAllowanceRequest("r1");

    expect(result).toEqual({ error: expect.stringMatching(/could not be found/i) });
  });

  it("refuses when the request is no longer pending", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });
    const selectBuilder = fakeBuilder({
      data: { id: "r1", user_id: USER.id, status: "approved" },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }) as never,
    );

    const result = await cancelAllowanceRequest("r1");

    expect(result).toEqual({ error: expect.stringMatching(/already approved/i) });
  });

  it("cancels the caller's own pending request", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: USER, profile: {} as never });
    const selectBuilder = fakeBuilder({
      data: { id: "r1", user_id: USER.id, status: "pending" },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }) as never,
    );
    const updateBuilder = fakeBuilder({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue(
      fakeClient({ allowance_requests: updateBuilder }) as never,
    );

    const result = await cancelAllowanceRequest("r1");

    expect(result).toBeUndefined();
    expect(updateBuilder.update).toHaveBeenCalledWith({ status: "cancelled" });
  });
});

describe("decideAllowanceRequest", () => {
  it("refuses when the request could not be found", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: ADMIN, profile: ADMIN_PROFILE });
    const selectBuilder = fakeBuilder({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve");

    expect(result).toEqual({ error: expect.stringMatching(/could not be found/i) });
  });

  it("refuses when the request has already been decided", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: ADMIN, profile: ADMIN_PROFILE });
    const selectBuilder = fakeBuilder({
      data: { id: "r1", user_id: USER.id, requested_usd: 10, status: "denied" },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve");

    expect(result).toEqual({ error: expect.stringMatching(/already denied/i) });
  });

  it("denies with approve: false and a $0 placeholder grant amount that decide_allowance_request never inserts on a denial", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: ADMIN, profile: ADMIN_PROFILE });
    const selectBuilder = fakeBuilder({
      data: { id: "r1", user_id: USER.id, requested_usd: 10, status: "pending" },
      error: null,
    });
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    const result = await decideAllowanceRequest("r1", "deny", { note: "not this time" });

    expect(result).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith(
      "decide_allowance_request",
      expect.objectContaining({
        request_id: "r1",
        approve: false,
        grant_amount_usd: 0,
        note: "not this time",
      }),
    );
  });

  it("approves for EXACTLY what was requested when no amount is given — a $7 ask grants $7, not a rounded-up $10", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: ADMIN, profile: ADMIN_PROFILE });
    const selectBuilder = fakeBuilder({
      data: { id: "r1", user_id: USER.id, requested_usd: 7, status: "pending" },
      error: null,
    });
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve");

    expect(result).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith(
      "decide_allowance_request",
      expect.objectContaining({ request_id: "r1", approve: true, grant_amount_usd: 7 }),
    );
  });

  // The report this replaced a $5 round-up to fix: ceil(1/5)*5 was $5, so the
  // dialog opened at $5 on a $1 ask, and an approver clicking through the
  // queue granted five times what was asked for.
  it("a $1 ask grants $1, not the $5 the old grid rounded it to", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: ADMIN, profile: ADMIN_PROFILE });
    const selectBuilder = fakeBuilder({
      data: { id: "r1", user_id: USER.id, requested_usd: 1, status: "pending" },
      error: null,
    });
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve");

    expect(result).toBeUndefined();
    const [, args] = rpc.mock.calls[0] as unknown as [string, { grant_amount_usd: number }];
    expect(args.grant_amount_usd).toBe(1);
  });

  it("lets the admin grant a smaller amount than what was requested", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: ADMIN, profile: ADMIN_PROFILE });
    const selectBuilder = fakeBuilder({
      data: { id: "r1", user_id: USER.id, requested_usd: 20, status: "pending" },
      error: null,
    });
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve", { grantAmountUsd: 5 });

    expect(result).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith(
      "decide_allowance_request",
      expect.objectContaining({ grant_amount_usd: 5 }),
    );
  });

  it("refuses a non-positive grant amount without calling the RPC", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: ADMIN, profile: ADMIN_PROFILE });
    const selectBuilder = fakeBuilder({
      data: { id: "r1", user_id: USER.id, requested_usd: 10, status: "pending" },
      error: null,
    });
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve", { grantAmountUsd: -1 });

    expect(result).toEqual({ error: expect.stringMatching(/positive dollar amount/i) });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a past grant expiry without calling the RPC — the fat-fingered-year case", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: ADMIN, profile: ADMIN_PROFILE });
    const selectBuilder = fakeBuilder({
      data: { id: "r1", user_id: USER.id, requested_usd: 10, status: "pending" },
      error: null,
    });
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve", {
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    expect(result).toEqual({ error: expect.stringMatching(/future/i) });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a grant expiry too far in the future without calling the RPC — the 2099 case", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: ADMIN, profile: ADMIN_PROFILE });
    const selectBuilder = fakeBuilder({
      data: { id: "r1", user_id: USER.id, requested_usd: 10, status: "pending" },
      error: null,
    });
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve", {
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    expect(result).toEqual({ error: expect.stringMatching(/days out/i) });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("turns decide_allowance_request's 'not pending' raise (a concurrent-decision race) into a returned, actionable error, not a throw", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: ADMIN, profile: ADMIN_PROFILE });
    const selectBuilder = fakeBuilder({
      data: { id: "r1", user_id: USER.id, requested_usd: 10, status: "pending" },
      error: null,
    });
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: null,
        error: {
          message: "decide_allowance_request: request r1 is not pending (or does not exist)",
        },
      }),
    );
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve");

    expect(result).toEqual({ error: expect.stringMatching(/someone else already decided/i) });
  });

  it("still throws (does not return) on any other RPC error", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: ADMIN, profile: ADMIN_PROFILE });
    const selectBuilder = fakeBuilder({
      data: { id: "r1", user_id: USER.id, requested_usd: 10, status: "pending" },
      error: null,
    });
    const rpc = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: "connection reset" } }),
    );
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    await expect(decideAllowanceRequest("r1", "approve")).rejects.toThrow(/connection reset/);
  });
});

// Peer approval (0074_peer_allowance_approval.sql, docs/credit-display-plan.md
// § P6). requireApprover has already let the caller in by the time any of
// these run — what is under test here is the second, per-request question it
// deliberately does NOT answer: may THIS approver decide THIS request, and on
// what terms. Every refusal below must reach the RPC never having been called;
// asserting only the returned message would pass on an implementation that
// refuses AFTER writing the decision.
describe("decideAllowanceRequest — peer approval", () => {
  function pendingRequest(userId: string, requestedUsd: number): FakeQueryResult {
    return {
      data: { id: "r1", user_id: userId, requested_usd: requestedUsd, status: "pending" },
      error: null,
    };
  }

  it("lets a trusted editor decide a colleague's request under the ceiling", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: TRUSTED, profile: TRUSTED_PROFILE });
    const selectBuilder = fakeBuilder(pendingRequest(USER.id, 5));
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve");

    expect(result).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith(
      "decide_allowance_request",
      expect.objectContaining({ request_id: "r1", approve: true }),
    );
  });

  it("refuses a trusted editor their own request without calling the RPC", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: TRUSTED, profile: TRUSTED_PROFILE });
    const selectBuilder = fakeBuilder(pendingRequest(TRUSTED.id, 5));
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve");

    expect(result).toEqual({ error: expect.stringMatching(/your own/i) });
    expect(rpc).not.toHaveBeenCalled();
  });

  // The rule has no admin carve-out — this is the assertion that pins it.
  it("refuses an ADMIN their own request too", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: ADMIN, profile: ADMIN_PROFILE });
    const selectBuilder = fakeBuilder(pendingRequest(ADMIN.id, 5));
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve");

    expect(result).toEqual({ error: expect.stringMatching(/your own/i) });
    expect(rpc).not.toHaveBeenCalled();
  });

  // Escalation covers BOTH decisions: a peer who cannot approve a large ask
  // must not be able to deny it either, or "an admin decides this one" is
  // false in the direction that quietly loses the editor their allowance.
  it.each(["approve", "deny"] as const)(
    "refuses a trusted editor a request over the ceiling — %s included",
    async (decision) => {
      vi.mocked(requireApprover).mockResolvedValue({ user: TRUSTED, profile: TRUSTED_PROFILE });
      const selectBuilder = fakeBuilder(pendingRequest(USER.id, OVER_CEILING_USD));
      const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
      vi.mocked(createClient).mockResolvedValue(
        fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
      );

      const result = await decideAllowanceRequest("r1", decision);

      expect(result).toEqual({ error: expect.stringMatching(/admin has to decide/i) });
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  // The hole decisionBlockReason alone does not close: the REQUEST is under
  // the ceiling, so the dialog opens, and the approver types a bigger number.
  it("refuses a trusted editor an over-ceiling AMOUNT on an under-ceiling request", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: TRUSTED, profile: TRUSTED_PROFILE });
    const selectBuilder = fakeBuilder(pendingRequest(USER.id, 5));
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve", {
      grantAmountUsd: OVER_CEILING_USD,
    });

    expect(result).toEqual({ error: expect.stringMatching(/approve up to/i) });
    expect(rpc).not.toHaveBeenCalled();
  });

  // A peer does not choose the expiry — a sent value is IGNORED, not
  // validated. The 2099 date below would have been REFUSED on the admin path
  // (grantExpiryError); asserting it is silently replaced rather than rejected
  // is what proves the peer branch is not just running the admin one.
  it("ignores a peer's expiry entirely and forces the end of the current Manila week", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: TRUSTED, profile: TRUSTED_PROFILE });
    const selectBuilder = fakeBuilder(pendingRequest(USER.id, 5));
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve", {
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    expect(result).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith(
      "decide_allowance_request",
      expect.objectContaining({ grant_expires_at: endOfManilaDayIso() }),
    );
  });

  // The default used to round UP to the nearest $5 and was clamped to the
  // peer ceiling to stop it overshooting. Both are gone — the default is the
  // request, and decisionBlockReason already refuses a peer whose request is
  // over the ceiling. The PROPERTY those two mechanisms existed to guarantee
  // is what this still asserts: a peer's default grant never exceeds what
  // they are allowed to grant. An amount they actually TYPED is a separate
  // question, answered by the test above.
  it("a peer's default grant never exceeds their ceiling, with the clamp gone", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: TRUSTED, profile: TRUSTED_PROFILE });
    const selectBuilder = fakeBuilder(pendingRequest(USER.id, TRUSTED_WEEKLY_CAP_USD));
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );

    const result = await decideAllowanceRequest("r1", "approve");

    expect(result).toBeUndefined();
    const [, args] = rpc.mock.calls[0] as unknown as [string, { grant_amount_usd: number }];
    expect(args.grant_amount_usd).toBeLessThanOrEqual(TRUSTED_WEEKLY_CAP_USD);
  });

  // The admin path must not have been narrowed by any of the above: a
  // far-future-but-legal expiry is still admin territory and still passes
  // through untouched.
  it("leaves the admin path alone — a far-future-but-legal expiry still passes through", async () => {
    vi.mocked(requireApprover).mockResolvedValue({ user: ADMIN, profile: ADMIN_PROFILE });
    const selectBuilder = fakeBuilder(pendingRequest(USER.id, 10));
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(
      fakeClient({ allowance_requests: selectBuilder }, rpc) as never,
    );
    const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const result = await decideAllowanceRequest("r1", "approve", { expiresAt: in30Days });

    expect(result).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith(
      "decide_allowance_request",
      expect.objectContaining({ grant_expires_at: in30Days }),
    );
  });
});
