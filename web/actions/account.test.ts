import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decideAccountApproval,
  promoteToAdmin,
  setTrustedEditor,
  setWeeklyCapOverride,
  setDailyCapOverride,
  setAllEditorsDailyCap,
  setAllEditorsHourlyCap,
  setAllEditorsWeeklyCap,
} from "./account";
import { requireAdmin } from "@/actions/guard";
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
    select: vi.fn(async () => result),
  };
  return builder;
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

  it("clears the override with null, so the role default applies again", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "user-1" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    await setWeeklyCapOverride("user-1", null);

    expect(builder.update).toHaveBeenCalledWith({ weekly_cap_override_usd: null });
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

    expect(builder.in).toHaveBeenCalledWith("role", ["editor"]);
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

    expect(builder.update).toHaveBeenCalledTimes(1);
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

describe("setAllEditorsWeeklyCap", () => {
  it("targets every editor tier by name and reports how many it changed", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ user: ADMIN, profile: {} as never });
    const builder = fakeBuilder({ data: [{ id: "a" }, { id: "b" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    const result = await setAllEditorsWeeklyCap(25);

    // Named explicitly rather than "not admin": this writes to many rows at
    // once, so adding a future role must be a deliberate edit here.
    expect(builder.in).toHaveBeenCalledWith("role", ["editor", "trusted_editor", "hybrid_editor", "ai_animator"]);
    expect(builder.update).toHaveBeenCalledWith({ weekly_cap_override_usd: 25 });
    expect(result).toEqual({ updated: 2 });
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

    expect(builder.in).toHaveBeenCalledWith("role", roles);
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
