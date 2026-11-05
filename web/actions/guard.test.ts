import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requireAdmin,
  requireApprover,
  requireProject,
  requireProjectReadable,
  requireUser,
} from "./guard";
import { createClient } from "@/lib/supabase/server";

// Unlike project.test.ts and profile.test.ts, guard.ts itself is the unit
// under test here — those files mock it out because they're testing their
// own callers' logic; this file exercises requireProject's own two refusal
// branches (row missing, row present but not owned by the caller) to prove
// they take the notFound() path rather than an unhandled throw. See
// guard.ts's own doc comment on requireProject for why both must render
// identically: RLS's projects_select filters rather than refuses, so a
// stranger's project and a deleted one are indistinguishable by the time
// this function sees the query result.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

// Real Next throws a digest-tagged error from notFound()/redirect() and
// lets the framework's own machinery catch it further up the tree. There is
// no framework here, so these fakes reproduce just the "control flow via
// throw, not return" contract every call site (and this test) depends on —
// same approach project.test.ts's next/navigation mock already uses for
// redirect().
class FakeNotFoundError extends Error {
  digest = "NEXT_NOT_FOUND";
}
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new FakeNotFoundError("NEXT_NOT_FOUND");
  }),
}));

interface FakeQueryResult {
  data: unknown;
  error: { message: string } | null;
}

interface FakeQueryBuilder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
}

function fakeBuilder(result: FakeQueryResult): FakeQueryBuilder {
  const builder: FakeQueryBuilder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    single: vi.fn(async () => result),
  };
  return builder;
}

const OWNER = { id: "owner-1", email: "owner@example.com" };
const STRANGER = { id: "stranger-1", email: "stranger@example.com" };
const ADMIN = { id: "admin-1", email: "admin@example.com" };
const TRUSTED = { id: "trusted-1", email: "trusted@example.com" };

/**
 * Fakes the two tables requireProject/requireUser touch: auth.getUser()
 * (via a `.auth` stub, not `.from`) and the `profiles`/`projects` rows via
 * `.from`. `projectRow` stands in for the *entire* result RLS's
 * projects_select would produce for the caller: pass `null` to simulate a
 * row genuinely missing OR a stranger's row RLS already filtered out —
 * requireProject cannot tell those apart, which is the point.
 *
 * `role` defaults to "editor" — only the admin- and approver-specific tests
 * below pass "admin"/"trusted_editor", so every existing owner/stranger test
 * keeps exercising the ordinary non-admin path unchanged. `status` defaults to "active" for the
 * same reason: every account that predates 0052_account_approval.sql was
 * backfilled to it, so it is what the ordinary path looks like, and only
 * the approval tests pass anything else.
 */
function fakeSupabase(
  user: { id: string; email: string },
  projectRow: Record<string, unknown> | null,
  role: "editor" | "trusted_editor" | "admin" = "editor",
  status: "pending" | "active" | "rejected" = "active",
): { auth: { getUser: ReturnType<typeof vi.fn> }; from: ReturnType<typeof vi.fn> } {
  const profilesBuilder = fakeBuilder({
    data: { id: user.id, role, status },
    error: null,
  });
  const projectsBuilder = fakeBuilder({
    data: projectRow,
    error: projectRow ? null : { message: "no rows" },
  });
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user } })) },
    from: vi.fn((table: string) => {
      if (table === "profiles") return profilesBuilder;
      if (table === "projects") return projectsBuilder;
      throw new Error(`Test did not stub table "${table}"`);
    }),
  };
}

afterEach(() => {
  vi.mocked(createClient).mockReset();
});

describe("requireProject", () => {
  it("takes the notFound() path, not an unhandled throw, when the project id has no row", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase(OWNER, null) as never);

    // Asserting the specific digest-tagged error (not just "rejects"):
    // this is what actually distinguishes "renders the 404 boundary" from
    // "renders Next's default unstyled 500 page", which is the bug this
    // change fixes. A generic AuthorizationError here would still fail
    // this assertion.
    await expect(requireProject("missing-project")).rejects.toThrow(FakeNotFoundError);
  });

  it("still does not hand the project to a caller who does not own it — same notFound() path as a missing row", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase(STRANGER, {
        id: "project-1",
        user_id: OWNER.id,
        title: "Someone else's project",
        scenes: [],
      }) as never,
    );

    // The guard did not weaken: a non-owner still cannot obtain `project`.
    // It fails via notFound() instead of a throw that happened to go
    // uncaught, but the function still never returns for them.
    await expect(requireProject("project-1")).rejects.toThrow(FakeNotFoundError);
  });

  it("returns the project for its actual owner", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase(OWNER, {
        id: "project-1",
        user_id: OWNER.id,
        title: "My project",
        scenes: [],
      }) as never,
    );

    const { project, user } = await requireProject("project-1");

    expect(project.id).toBe("project-1");
    expect(user.id).toBe(OWNER.id);
  });

  // This is the property every write path in the app leans on: no matter
  // what requireProjectReadable is taught to allow, requireProject itself
  // must never move. Pinned explicitly, not just implied by the "stranger"
  // test above, because a stranger and an admin take genuinely different
  // paths through 0002_rls.sql (a stranger's row is filtered out before
  // this function ever sees it; an admin's row comes back precisely
  // because RLS's is_admin() clause let it through) — this test is the one
  // that actually exercises the admin branch.
  it("still 404s an admin who is not the owner — the security boundary every write action depends on", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase(
        ADMIN,
        {
          id: "project-1",
          user_id: OWNER.id,
          title: "Someone else's project",
          scenes: [],
        },
        "admin",
      ) as never,
    );

    await expect(requireProject("project-1")).rejects.toThrow(FakeNotFoundError);
  });
});

describe("requireProjectReadable", () => {
  it("returns isOwner: true for the project's actual owner", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase(OWNER, {
        id: "project-1",
        user_id: OWNER.id,
        title: "My project",
        scenes: [],
      }) as never,
    );

    const { project, isOwner } = await requireProjectReadable("project-1");

    expect(project.id).toBe("project-1");
    expect(isOwner).toBe(true);
  });

  it("returns isOwner: false for an admin viewing another user's project, instead of notFound()", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase(
        ADMIN,
        {
          id: "project-1",
          user_id: OWNER.id,
          title: "Someone else's project",
          scenes: [],
        },
        "admin",
      ) as never,
    );

    const { project, isOwner } = await requireProjectReadable("project-1");

    expect(project.id).toBe("project-1");
    expect(isOwner).toBe(false);
  });

  it("still 404s a non-admin who is not the owner", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase(STRANGER, {
        id: "project-1",
        user_id: OWNER.id,
        title: "Someone else's project",
        scenes: [],
      }) as never,
    );

    await expect(requireProjectReadable("project-1")).rejects.toThrow(FakeNotFoundError);
  });

  it("still 404s when the project id has no row at all", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase(OWNER, null) as never);

    await expect(requireProjectReadable("missing-project")).rejects.toThrow(FakeNotFoundError);
  });
});

// 0052_account_approval.sql's gate. These assert on the redirect TARGET,
// not merely that the call rejected: /pending is load-bearing in a way
// /login is not — lib/supabase/middleware.ts bounces an authenticated
// request off /login straight back to /projects, so a guard that sent a
// pending account there would loop it forever rather than refuse it. A
// test that only checked "did not return" would pass on that bug.
describe("requireUser approval gate", () => {
  it("holds a pending account at /pending instead of letting it into the app", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase(OWNER, null, "editor", "pending") as never,
    );

    await expect(requireUser()).rejects.toThrow("REDIRECT:/pending");
  });

  it("holds a rejected account there too — the decision is terminal, not a retryable failure", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase(OWNER, null, "editor", "rejected") as never,
    );

    await expect(requireUser()).rejects.toThrow("REDIRECT:/pending");
  });

  it("lets an approved account through", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase(OWNER, null) as never);

    const { user } = await requireUser();

    expect(user.id).toBe(OWNER.id);
  });

  // The reason the check lives in requireUser() and nowhere else: every
  // other guard is built on it, so none of them can be left behind when
  // one of them is edited. The two branches below pin both sides of the
  // role rule: admins bypass approval, editor project writes do not.
  it("lets an admin through without approval", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase(ADMIN, null, "admin", "pending") as never,
    );

    const { user } = await requireAdmin();

    expect(user.id).toBe(ADMIN.id);
  });

  it("gates requireProject before ownership is ever consulted", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase(
        OWNER,
        { id: "project-1", user_id: OWNER.id, title: "My project", scenes: [] },
        "editor",
        "pending",
      ) as never,
    );

    await expect(requireProject("project-1")).rejects.toThrow("REDIRECT:/pending");
  });
});

// requireApprover is requireAdmin's wider twin for the one workflow trusted
// editors share (0074_peer_allowance_approval.sql). The pair of assertions
// that matter most are the two ENDS of the range: a trusted editor gets in
// (that is the whole feature) and a plain editor does not (that is the whole
// boundary). The middle — that an admin still gets in — would be the easiest
// thing to break with a `role === "trusted_editor"` typo, so it is pinned too.
describe("requireApprover", () => {
  it("admits an admin", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase(ADMIN, null, "admin") as never);

    const { user } = await requireApprover();

    expect(user.id).toBe(ADMIN.id);
  });

  it("admits a trusted editor — the point of the guard", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase(TRUSTED, null, "trusted_editor") as never,
    );

    const { user } = await requireApprover();

    expect(user.id).toBe(TRUSTED.id);
  });

  it("refuses a plain editor", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase(OWNER, null, "editor") as never);

    await expect(requireApprover()).rejects.toThrow(/not an allowance approver/i);
  });

  // The approval gate is inherited from requireUser, not reimplemented here —
  // so a trusted editor an admin has rejected is bounced to /pending before
  // the role is ever consulted. 0074's can_approve_allowance() carries the
  // same `status = 'active'` condition for the trusted_editor branch, so the
  // database refuses the same account through a direct RPC call.
  it("holds a rejected trusted editor at /pending rather than letting them approve", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase(TRUSTED, null, "trusted_editor", "rejected") as never,
    );

    await expect(requireApprover()).rejects.toThrow("REDIRECT:/pending");
  });
});
