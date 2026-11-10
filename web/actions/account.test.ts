import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decideAccountApproval,
  setAccountRole,
  promoteToAdmin,
  setTrustedEditor,
  setWeeklyCapOverride,
  setDailyCapOverride,
  setAllEditorsDailyCap,
  setAllEditorsHourlyCap,
  setAllEditorsWeeklyCap,
  getBulkSpendingLimits,
} from "./account";
import { requireAdmin } from "@/actions/guard";
import { weeklyCapForRole } from "@/lib/spend";
import { createAdminClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

// Same fakes-over-the-two-boundaries approach as actions/profile.test.ts:
// the admin guard and the admin Supabase client factory are mocked, and
// next/cache's revalidatePath is a no-op outside a real request.
vi.mock("@/actions/guard", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

interface FakeQueryResult {
  data: unknown;
  error: { message: string } | null;
}

interface FakeQueryBuilder {
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  neq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  // Both added for the grant revocation a ZERO allowance triggers
  // (lib/allowance-grants.ts, via setWeeklyCapOverride/setAllEditorsWeeklyCap):
  // that second UPDATE filters on `expires_at >` and `revoked_at is null`,
  // so a builder without them makes a legitimate code path look like a
  // TypeError instead of exercising it.
  gt: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
}

/**
 * Chainable stand-in ending at `.select()`, which is where
 * decideAccountApproval's UPDATE resolves — it asks for the updated rows
 * back precisely so it can tell "decided it" from "matched nothing".
 */
function fakeBuilder(result: FakeQueryResult): FakeQueryBuilder {
  const builder: FakeQueryBuilder = {
    update: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    neq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    gt: vi.fn(() => builder),
    is: vi.fn(() => builder),
    select: vi.fn(() => {
      const read = {
        eq: vi.fn(() => read),
        // The account as stampStartingCaps/roleOf read it: already has its own
        // caps, so no stamp write muddies the assertions on the main write.
        maybeSingle: vi.fn(async () => ({ data: SAVED_PROFILE, error: null })),
        then: (
          onFulfilled: (value: FakeQueryResult) => unknown,
          onRejected?: (e: unknown) => unknown,
        ) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return read;
    }),
  };
  return builder;
}

const SAVED_PROFILE = { role: "editor", weekly_cap_override_usd: 5, daily_cap_override_usd: 5 };

/** The roles a bulk write targeted, in order — one `.eq("role", r)` per role now. */
function rolesWritten(builder: FakeQueryBuilder): unknown[] {
  return builder.eq.mock.calls.filter(([column]) => column === "role").map(([, role]) => role);
}

const ADMIN = { id: "admin-1", email: "admin@example.com" };

afterEach(() => {
  vi.resetAllMocks();
});

describe("decideAccountApproval", () => {
  it("approves by writing status='active', scoped to that id AND to a decidable status", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    const result = await decideAccountApproval("user-1", "approve");

    expect(result).toBeUndefined();
    // The payload is the one column and nothing else: an approval must not
    // be a back door to changing a role (0002_rls.sql grants an admin read
    // over every project of every user — see actions/auth.ts's signUp on why
    // role is never client-influenced).
    expect(builder.update).toHaveBeenCalledWith({ status: "active" });
    expect(builder.eq).toHaveBeenCalledWith("id", "user-1");
    expect(builder.neq).toHaveBeenCalledWith("role", "admin");
    // The concurrency guard, and the reason this is an assertion rather
    // than an implementation detail: without it, a second admin (or one
    // stale tab) could flip an account that has already been approved and
    // started working straight to 'rejected'. 'rejected' is in the list
    // because rejecting the wrong row has to be undoable from /users;
    // 'active' is not, so an already-decided account still loses the race.
    expect(builder.in).toHaveBeenCalledWith("status", ["pending", "rejected"]);
  });

  it("rejects by writing status='rejected', and only ever from 'pending'", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await decideAccountApproval("user-1", "reject");

    expect(builder.update).toHaveBeenCalledWith({ status: "rejected" });
    // Reject is NOT the mirror of approve: cutting off an account that is
    // already active and working is a bigger decision than this page makes.
    expect(builder.in).toHaveBeenCalledWith("status", ["pending"]);
  });

  it("deactivates by writing status='deactivated', and only ever from 'active'", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await decideAccountApproval("user-1", "deactivate");

    expect(builder.update).toHaveBeenCalledWith({ status: "deactivated" });
    // 'active' alone. Deactivate answers "should this colleague still have
    // access", which is only a question about someone who has it — it must
    // not be able to reach a pending application or a refused one, because
    // those are approve's and reject's rows to decide.
    expect(builder.in).toHaveBeenCalledWith("status", ["active"]);
    // Admin rows stay out of reach, which is also what stops an admin
    // deactivating themselves and locking the last admin out of /users.
    expect(builder.neq).toHaveBeenCalledWith("role", "admin");
  });

  it("reactivates by writing status='active', and only ever from 'deactivated'", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await decideAccountApproval("user-1", "reactivate");

    expect(builder.update).toHaveBeenCalledWith({ status: "active" });
    // The mirror of deactivate, and deliberately not a second approve: it
    // must not be able to wave through a pending account or un-reject a
    // refused one from a row that shows neither of those decisions.
    expect(builder.in).toHaveBeenCalledWith("status", ["deactivated"]);
  });

  it("returns (does not throw) when the account was already decided, so the admin can read why", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => fakeBuilder({ data: [], error: null })),
    } as never);

    const result = await decideAccountApproval("user-1", "approve");

    // Returned, not thrown — a thrown Server Action error is redacted to
    // React error #441 in production, so this message would never reach the
    // admin who needs to act on it. See lib/action-result.ts.
    expect(result).toEqual({ error: expect.any(String) });
    // ...and the stale page gets refreshed anyway. The loser of the race is
    // still looking at Approve/Reject on a row that has already been
    // decided; without this the message would have to ask them to reload.
    expect(revalidatePath).toHaveBeenCalledWith("/users");
  });

  it("never reaches the admin client when the caller is not an admin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("User editor-1 is not an admin."));

    await expect(decideAccountApproval("user-1", "approve")).rejects.toThrow("is not an admin");
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("setTrustedEditor", () => {
  it("promotes by writing role='trusted_editor', and only ever from 'editor'", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setTrustedEditor("user-1", "trust");

    expect(builder.update).toHaveBeenCalledWith({ role: "trusted_editor" });
    expect(builder.in).toHaveBeenCalledWith("role", ["editor"]);
  });

  it("demotes back to 'editor', and only ever from 'trusted_editor'", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setTrustedEditor("user-1", "untrust");

    expect(builder.update).toHaveBeenCalledWith({ role: "editor" });
    expect(builder.in).toHaveBeenCalledWith("role", ["trusted_editor"]);
  });

  // The admin protection, asserted as the property it actually is rather
  // than by driving one admin id through: 'admin' must appear in NEITHER
  // direction's source list, so no userId — however it is obtained — can
  // make this action write to an admin row. A future edit that adds 'admin'
  // to either list to "let admins be demoted too" fails here, which is the
  // point; that change needs a last-admin guard this action does not have.
  it.each([
    ["trust", "editor"],
    ["untrust", "trusted_editor"],
  ] as const)("cannot touch an admin row (%s)", async (decision, from) => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setTrustedEditor("user-1", decision);

    expect(builder.in).toHaveBeenCalledWith("role", [from]);
    expect(builder.in).not.toHaveBeenCalledWith("role", expect.arrayContaining(["admin"]));
    expect(builder.update).not.toHaveBeenCalledWith({ role: "admin" });
  });

  // Status is deliberately unconstrained — 0062's can_approve_allowance()
  // and canUseApp both require status = 'active' for the trusted_editor
  // branch, so the role alone grants nothing early. Pinned because adding a
  // status filter here would look like a safety improvement while actually
  // duplicating a rule that already has one home.
  it("does not filter on status", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setTrustedEditor("user-1", "trust");

    expect(builder.in).not.toHaveBeenCalledWith("status", expect.anything());
    expect(builder.neq).not.toHaveBeenCalled();
  });

  it("returns (does not throw) when the role already changed under the admin", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => fakeBuilder({ data: [], error: null })),
    } as never);

    const result = await setTrustedEditor("user-1", "trust");

    expect(result).toEqual({ error: expect.any(String) });
    expect(revalidatePath).toHaveBeenCalledWith("/users");
  });

  it("never reaches the admin client when the caller is not an admin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("User editor-1 is not an admin."));

    await expect(setTrustedEditor("user-1", "trust")).rejects.toThrow("is not an admin");
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("promoteToAdmin", () => {
  it("promotes only an active editor-tier account", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await promoteToAdmin("user-1");

    expect(builder.update).toHaveBeenCalledWith({ role: "admin" });
    expect(builder.eq).toHaveBeenCalledWith("id", "user-1");
    expect(builder.eq).toHaveBeenCalledWith("status", "active");
    expect(builder.in).toHaveBeenCalledWith("role", [
      "editor",
      "trusted_editor",
      "hybrid_editor",
      "ai_animator",
    ]);
  });

  it("returns an error and refreshes the list when the account no longer qualifies", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => fakeBuilder({ data: [], error: null })),
    } as never);

    await expect(promoteToAdmin("user-1")).resolves.toEqual({ error: expect.any(String) });
    expect(revalidatePath).toHaveBeenCalledWith("/users");
  });

  it("never reaches the admin client when the caller is not an admin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("User editor-1 is not an admin."));

    await expect(promoteToAdmin("user-1")).rejects.toThrow("is not an admin");
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("setWeeklyCapOverride", () => {
  it("writes the override in USD for admin rows too", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setWeeklyCapOverride("user-1", 25);

    // USD reaches the column. Credits are a display/input unit only — if
    // this ever asserts 5000, the conversion has leaked past the dialog.
    expect(builder.update).toHaveBeenCalledWith({ weekly_cap_override_usd: 25 });
    expect(builder.eq).toHaveBeenCalledWith("id", "user-1");
    expect(builder.neq).not.toHaveBeenCalled();
  });

  it("writes a zero override so an editor can be paused", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setWeeklyCapOverride("user-1", 0);

    expect(builder.update).toHaveBeenCalledWith({ weekly_cap_override_usd: 0 });
  });

  // ZERO MEANS ZERO (see the action's own note): getEffectiveWeeklyCapUsd
  // ADDS active grants to this figure, so a zero written while a grant is
  // live leaves the account rendering against the grant. Asserting the
  // second UPDATE, not just the first, is the only thing that catches a
  // future edit that drops the revocation and still passes the test above.
  it("revokes active grants when the override is zero, so the zero actually binds", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setWeeklyCapOverride("user-1", 0);

    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ revoked_by: ADMIN.id, revoked_at: expect.any(String) }),
    );
    expect(builder.is).toHaveBeenCalledWith("revoked_at", null);
  });

  // The other half of the same rule: every NON-zero value leaves grants
  // alone. A $25 base cap topped up by an approved $10 grant is the
  // workflow working, and an implementation that revoked on every write
  // would silently cancel grants whenever an admin adjusted a cap.
  it("leaves grants alone for any non-zero override", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setWeeklyCapOverride("user-1", 25);

    expect(builder.update).toHaveBeenCalledTimes(1);
    expect(builder.update).toHaveBeenCalledWith({ weekly_cap_override_usd: 25 });
  });

  it("resets with null to the role's starting value, written as a number", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setWeeklyCapOverride("user-1", null);

    // Never null: a null override would read the env live, and the env is only
    // a starting value (owner, 2026-11-10).
    expect(builder.update).toHaveBeenCalledWith({
      weekly_cap_override_usd: weeklyCapForRole("editor"),
    });
    expect(builder.update).not.toHaveBeenCalledWith({ weekly_cap_override_usd: null });
  });

  it("refuses a negative amount without reaching the database", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });

    const result = await setWeeklyCapOverride("user-1", -5);

    // Asserting the client was never built, not merely that a message came
    // back: an implementation that wrote first and complained after would
    // pass a message-only assertion.
    expect(result).toEqual({ error: expect.any(String) });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("refuses an amount over the highest role allowance without writing", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });

    const result = await setWeeklyCapOverride("user-1", 1_000_000);

    expect(result).toEqual({ error: expect.any(String) });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("never reaches the admin client when the caller is not an admin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("User editor-1 is not an admin."));

    await expect(setWeeklyCapOverride("user-1", 25)).rejects.toThrow("is not an admin");
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("setDailyCapOverride", () => {
  it("writes the daily override for admin rows too", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "admin-2" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setDailyCapOverride("admin-2", 10);

    expect(builder.update).toHaveBeenCalledWith({ daily_cap_override_usd: 10 });
    expect(builder.eq).toHaveBeenCalledWith("id", "admin-2");
    expect(builder.neq).not.toHaveBeenCalled();
  });
});

describe("setAllEditorsDailyCap", () => {
  it("writes the daily override to the scoped roles and reports the count", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "a" }, { id: "b" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    const result = await setAllEditorsDailyCap(2, "editor");

    expect(rolesWritten(builder)).toEqual(["editor"]);
    expect(builder.update).toHaveBeenCalledWith({ daily_cap_override_usd: 2 });
    expect(result).toEqual({ updated: 2 });
  });

  // The asymmetry with the weekly twin, which DOES revoke on zero. A grant
  // only ever raises the weekly ceiling, so a zero daily already refuses
  // every render on its own — revoking here would take back allowance this
  // action never claimed to touch.
  it("does not revoke grants when the daily figure is zero", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "a" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setAllEditorsDailyCap(0, "all");

    // One write per role, and none of them a grant revocation.
    expect(builder.update).toHaveBeenCalledTimes(4);
    expect(builder.update.mock.calls.every(([patch]) => "daily_cap_override_usd" in patch)).toBe(
      true,
    );
    expect(builder.update).toHaveBeenCalledWith({ daily_cap_override_usd: 0 });
  });

  it("refuses an unknown scope without touching the database", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });

    const result = await setAllEditorsDailyCap(2, "admin" as never);

    expect(result).toEqual({ error: expect.stringMatching(/which accounts/i) });
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("setAllEditorsHourlyCap", () => {
  it("writes the hourly override to the scoped roles and reports the count", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "a" }, { id: "b" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    const result = await setAllEditorsHourlyCap(1.5, "trusted_editor");

    expect(builder.in).toHaveBeenCalledWith("role", ["trusted_editor"]);
    expect(builder.update).toHaveBeenCalledWith({ hourly_cap_override_usd: 1.5 });
    expect(result).toEqual({ updated: 2 });
  });

  it("refuses a negative amount or an unknown scope without touching the database", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });

    expect(await setAllEditorsHourlyCap(-1, "all")).toEqual({ error: expect.any(String) });
    expect(await setAllEditorsHourlyCap(1, "admin" as never)).toEqual({
      error: expect.stringMatching(/which accounts/i),
    });
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("starting allowance", () => {
  it("copies the role's starting caps onto a newly approved account that has none", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    builder.select.mockImplementation(() => {
      const read = {
        eq: vi.fn(() => read),
        maybeSingle: vi.fn(async () => ({
          data: {
            role: "ai_animator",
            weekly_cap_override_usd: null,
            daily_cap_override_usd: null,
          },
          error: null,
        })),
        then: (onFulfilled: (value: FakeQueryResult) => unknown) =>
          Promise.resolve({ data: [{ id: "user-1" }], error: null }).then(onFulfilled),
      };
      return read;
    });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await decideAccountApproval("user-1", "approve");

    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ weekly_cap_override_usd: weeklyCapForRole("ai_animator") }),
    );
  });

  it("never overwrites an account that already has its own caps", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setAccountRole("user-1", "ai_animator");

    expect(builder.update).toHaveBeenCalledTimes(1);
    expect(builder.update).toHaveBeenCalledWith({ role: "ai_animator" });
  });
});

describe("bulk limits skip archived accounts", () => {
  it("never writes a bulk weekly limit to a deactivated account", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "ed-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setAllEditorsWeeklyCap(25);

    expect(builder.neq).toHaveBeenCalledWith("status", "deactivated");
  });
});

describe("setAllEditorsWeeklyCap", () => {
  it("targets every editor tier by name and reports how many it changed", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "a" }, { id: "b" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    const result = await setAllEditorsWeeklyCap(25);

    // Named explicitly rather than "not admin": this writes to many rows at
    // once, so adding a future role must be a deliberate edit here.
    expect(rolesWritten(builder)).toEqual([
      "editor",
      "trusted_editor",
      "hybrid_editor",
      "ai_animator",
    ]);
    expect(builder.update).toHaveBeenCalledWith({ weekly_cap_override_usd: 25 });
    // The fake answers two rows for each of the four role writes.
    expect(result).toEqual({ updated: 8 });
  });

  it.each([
    ["editor", ["editor"]],
    ["trusted_editor", ["trusted_editor"]],
    ["hybrid_editor", ["hybrid_editor"]],
    ["ai_animator", ["ai_animator"]],
    ["all", ["editor", "trusted_editor", "hybrid_editor", "ai_animator"]],
  ] as const)("scope %s writes to exactly %j", async (scope, roles) => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "a" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setAllEditorsWeeklyCap(25, scope);

    expect(rolesWritten(builder)).toEqual(roles);
  });

  // Admins are protected by their absence from every scope, not by a
  // separate filter — so an unknown scope must refuse rather than fall
  // through to `.in("role", undefined)`, which matches every profile there
  // is. Reachable because a Server Action is callable without the dialog.
  it("refuses an unknown scope without touching the database", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });

    const result = await setAllEditorsWeeklyCap(25, "admin" as never);

    expect(result).toEqual({ error: expect.stringMatching(/which accounts/i) });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("reports zero rather than erroring when there are no editors", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => fakeBuilder({ data: [], error: null })),
    } as never);

    // A team with no editor-tier accounts is legitimate, not a failure.
    expect(await setAllEditorsWeeklyCap(25)).toEqual({ updated: 0 });
  });

  it("refuses an over-ceiling amount without writing to every editor", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });

    const result = await setAllEditorsWeeklyCap(1_000_000);

    expect(result).toEqual({ error: expect.any(String) });
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("getBulkSpendingLimits", () => {
  const profile = {
    role: "editor" as const,
    weekly_cap_override_usd: 47,
    daily_cap_override_usd: 60,
    hourly_cap_override_usd: 0,
  };

  function fakeRead(
    pages: Array<{ data: unknown; error: { message: string } | null }>,
    settingsError = false,
  ): {
    range: ReturnType<typeof vi.fn>;
    in: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
  } {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const range = vi.fn();
    for (const page of pages) range.mockResolvedValueOnce(page);
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      neq: vi.fn(() => query),
      in: vi.fn(() => query),
      order: vi.fn(() => query),
      range,
      single: vi.fn(async () => ({
        data: settingsError ? null : { user_daily_cap_enabled: true },
        error: settingsError ? { message: "unavailable" } : null,
      })),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => query) } as never);
    return query;
  }

  it("reads saved amounts, including zero and a daily amount above the current weekly cap", async () => {
    const query = fakeRead([{ data: [profile], error: null }]);
    expect(await getBulkSpendingLimits("editor")).toEqual({
      count: 1,
      weeklyCapUsd: 47,
      dailyCapUsd: 60,
      hourlyCapUsd: 0,
      dailyCapEnabled: true,
    });
    expect(query.in).toHaveBeenCalledWith("role", ["editor"]);
  });

  it("reads beyond the first page before deciding whether limits are mixed", async () => {
    const query = fakeRead([
      { data: Array.from({ length: 500 }, () => profile), error: null },
      {
        data: [{ ...profile, weekly_cap_override_usd: 12, hourly_cap_override_usd: null }],
        error: null,
      },
    ]);
    expect(await getBulkSpendingLimits("all")).toEqual({
      count: 501,
      weeklyCapUsd: "mixed",
      dailyCapUsd: 60,
      hourlyCapUsd: "mixed",
      dailyCapEnabled: true,
    });
    expect(query.range.mock.calls).toEqual([
      [0, 499],
      [500, 999],
    ]);
    expect(query.order).toHaveBeenCalledWith("id");
    expect(query.in).toHaveBeenCalledWith("role", [
      "editor",
      "trusted_editor",
      "hybrid_editor",
      "ai_animator",
    ]);
  });

  it("resolves role defaults after overrides are cleared", async () => {
    fakeRead([
      {
        data: [
          {
            ...profile,
            role: "trusted_editor",
            weekly_cap_override_usd: null,
            daily_cap_override_usd: null,
            hourly_cap_override_usd: null,
          },
        ],
        error: null,
      },
    ]);
    const { resolveAccountCaps } = await import("@/lib/spend");
    const defaults = resolveAccountCaps({
      role: "trusted_editor",
      weekly_cap_override_usd: null,
      daily_cap_override_usd: null,
    });
    expect(await getBulkSpendingLimits("trusted_editor")).toEqual({
      count: 1,
      weeklyCapUsd: defaults.weeklyCapUsd,
      dailyCapUsd: defaults.dailyCapUsd,
      hourlyCapUsd: null,
      dailyCapEnabled: true,
    });
  });

  it("returns empty amounts for an empty scope", async () => {
    fakeRead([{ data: [], error: null }]);
    expect(await getBulkSpendingLimits("all")).toEqual({
      count: 0,
      weeklyCapUsd: null,
      dailyCapUsd: null,
      hourlyCapUsd: null,
      dailyCapEnabled: true,
    });
  });

  it("does not turn a read failure into made-up defaults", async () => {
    fakeRead([{ data: null, error: { message: "unavailable" } }]);
    await expect(getBulkSpendingLimits("all")).rejects.toThrow(
      "Could not load saved spending limits",
    );
    fakeRead([], true);
    await expect(getBulkSpendingLimits("all")).rejects.toThrow(
      "Could not load the daily cap setting",
    );
  });

  it("requires admin access before reading settings", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("Forbidden"));
    await expect(getBulkSpendingLimits("all")).rejects.toThrow("Forbidden");
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each(["admin", "toString"])(
    "rejects the forged scope %s before accessing the database",
    async (scope) => {
      vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
      await expect(getBulkSpendingLimits(scope as never)).rejects.toThrow("Choose which accounts");
      expect(createAdminClient).not.toHaveBeenCalled();
    },
  );
});
