import { afterEach, describe, expect, it, vi } from "vitest";
import { passAllowance } from "./transfer";
import { requireUser } from "@/actions/guard";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getAccountBudgetSnapshot } from "@/lib/spend";
import { revalidatePath } from "next/cache";
import { NOT_A_PASSER } from "@/lib/transfer";
import type * as SpendModule from "@/lib/spend";

// Same fakes-over-the-boundaries approach as actions/allowance.test.ts: the
// guard, the two Supabase client factories and next/cache are mocked.
//
// lib/spend.ts is mocked too, so the two client factories can be told apart:
// getAccountBudgetSnapshot reaches for createAdminClient internally (it is a
// cross-user aggregate read with no RLS policy behind it), and leaving it real
// would make createAdminClient called-by-definition, which would sink the
// assertions below about WHICH client each RPC goes through.
//
// THIS FILE WAS REWRITTEN BY A SECURITY FIX, and the shape of the change is
// worth knowing before reading the assertions. It used to pin the opposite
// contract: pass_allowance through the SESSION client, the sender left implicit
// in auth.uid(), and the sender's spendable headroom sent as an argument. That
// was the vulnerability — the function was callable by `authenticated`, so an
// editor could skip this action entirely and state their own balance to
// PostgREST. 0087 now revokes it from `authenticated` and computes the headroom
// itself, which makes the service-role client the only way in and the sender a
// required parameter. The tests below pin the new contract in the same places
// the old ones pinned the old one.
vi.mock("@/actions/guard", () => ({
  requireUser: vi.fn(),
  AuthorizationError: class AuthorizationError extends Error {},
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof SpendModule>("@/lib/spend");
  return { ...actual, getAccountBudgetSnapshot: vi.fn() };
});

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const SENDER = { id: "sender-1", email: "editor@example.com" };
const EDITOR_PROFILE = { role: "editor" } as never;
const ADMIN_PROFILE = { role: "admin" } as never;

const RECIPIENT = {
  id: "recipient-1",
  username: "kate",
  email: "kate@example.com",
  role: "trusted_editor",
};

/**
 * The SESSION client, which serves transfer_recipients() and nothing else.
 *
 * It throws on pass_allowance rather than answering it, because that call
 * arriving here would be the regression this whole file now exists to catch:
 * the session client is `authenticated`, and 0087 revoked that role's execute
 * privilege. In production such a call fails with a permission error; here it
 * fails loudly and immediately.
 */
function sessionClient(
  options: { recipients?: unknown[]; recipientsError?: { message: string } | null } = {},
) {
  // Two parameters, not one: `.mock.calls` is typed off this signature, and
  // the payload assertions below read the second element of each call.
  const rpc = vi.fn((fnName: string, _args?: Record<string, unknown>) => {
    if (fnName === "transfer_recipients") {
      return Promise.resolve({
        data: options.recipients ?? [RECIPIENT],
        error: options.recipientsError ?? null,
      });
    }
    if (fnName === "pass_allowance") {
      throw new Error(
        "pass_allowance went through the session client; it is service-role only (0087 section 2b)",
      );
    }
    throw new Error(`Unexpected rpc in test: ${fnName}`);
  });
  return { rpc, from: vi.fn() };
}

/** The SERVICE-ROLE client, which serves pass_allowance and nothing else. */
function adminClient(options: { passError?: { message: string } | null } = {}) {
  const rpc = vi.fn((fnName: string, _args?: Record<string, unknown>) => {
    if (fnName === "pass_allowance") {
      return Promise.resolve({
        data: "2026-09-14T16:00:00.000Z",
        error: options.passError ?? null,
      });
    }
    throw new Error(`Unexpected admin rpc in test: ${fnName}`);
  });
  return { rpc, from: vi.fn() };
}

/** Wires both clients up for a test that expects the pass to reach the RPC. */
function bothClients(options: { passError?: { message: string } | null } = {}) {
  const session = sessionClient();
  const admin = adminClient(options);
  vi.mocked(createClient).mockResolvedValue(session as never);
  vi.mocked(createAdminClient).mockReturnValue(admin as never);
  return { session, admin };
}

/** A sender with $20 of base headroom and nothing spent or held. */
function snapshot(overrides: Record<string, number> = {}) {
  return {
    weeklyBaseCapUsd: 20,
    weeklyUsedUsd: 0,
    heldUsd: 0,
    // The true remaining figure — base cap plus active grants, minus spend and
    // held. This is what the client-side MESSAGE compares against now; the
    // database no longer takes any headroom figure at all, so there is nothing
    // for a wrong value here to inflate.
    weeklyRemainingUsd: 20,
    ...overrides,
  } as never;
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("passAllowance", () => {
  it("refuses an admin caller with a sentence, before any database call", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: SENDER, profile: ADMIN_PROFILE });

    const result = await passAllowance("recipient-1", 5);

    expect(result).toEqual({ error: NOT_A_PASSER });
    expect(createClient).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // TWO CLIENTS, and which call goes through which one is now a security
  // property rather than a style choice. The session client is `authenticated`,
  // the role 0087 revoked pass_allowance from; the admin client is
  // service_role, the only role that may execute it.
  it("reads recipients on the session client and passes on the service-role client", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: SENDER, profile: EDITOR_PROFILE });
    vi.mocked(getAccountBudgetSnapshot).mockResolvedValue(snapshot());
    const { session, admin } = bothClients();

    const result = await passAllowance("recipient-1", 5);

    expect(result).toBeUndefined();
    // transfer_recipients resolves the caller from auth.uid(), which the
    // service role does not have — it would get an empty list, and every pass
    // would be refused as "that account can't receive credits".
    expect(session.rpc).toHaveBeenCalledWith("transfer_recipients");
    expect(admin.rpc).toHaveBeenCalledWith("pass_allowance", expect.anything());
  });

  // THE FIX, stated as a payload. The sender is carried explicitly because the
  // service-role session has no auth.uid() to derive it from, and it is
  // requireUser()'s answer — never the id the browser sent, which is only ever
  // used as the recipient.
  it("sends the authenticated sender's own id, never the caller-supplied one", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: SENDER, profile: EDITOR_PROFILE });
    vi.mocked(getAccountBudgetSnapshot).mockResolvedValue(
      snapshot({ weeklyBaseCapUsd: 20, weeklyUsedUsd: 6, heldUsd: 1.5, weeklyRemainingUsd: 12.5 }),
    );
    const { admin } = bothClients();

    await passAllowance("recipient-1", 5, "  for the reshoot  ");

    expect(admin.rpc).toHaveBeenCalledWith("pass_allowance", {
      p_from_user_id: SENDER.id,
      p_to_user_id: "recipient-1",
      p_amount_usd: 5,
      // The two figures SQL cannot derive, sent RAW rather than pre-combined
      // into a headroom the database would have to trust.
      p_weekly_base_cap_usd: 20,
      p_held_usd: 1.5,
      p_note: "for the reshoot",
    });
  });

  // The single most important assertion in this file, and it is now an
  // assertion about ABSENCE. A headroom argument is what let a direct RPC
  // caller name their own balance, and an expiry argument is what let a pass
  // outlive the weekly reset. Neither may come back.
  it("sends no headroom figure and no expiry — the database owns both", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: SENDER, profile: EDITOR_PROFILE });
    vi.mocked(getAccountBudgetSnapshot).mockResolvedValue(snapshot());
    const { admin } = bothClients();

    await passAllowance("recipient-1", 5);

    const [, args] = admin.rpc.mock.calls.find(([name]) => name === "pass_allowance") ?? [];
    expect(args).not.toHaveProperty("p_sender_headroom_usd");
    expect(args).not.toHaveProperty("p_expires_at");
  });

  it("refuses a recipient who is not in transfer_recipients(), without calling the RPC", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: SENDER, profile: EDITOR_PROFILE });
    vi.mocked(getAccountBudgetSnapshot).mockResolvedValue(snapshot());
    // What an unapproved account, an admin, or a deleted id all look like from
    // here: absent from the eligible set.
    vi.mocked(createClient).mockResolvedValue(sessionClient({ recipients: [] }) as never);
    const admin = adminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const result = await passAllowance("recipient-1", 5);

    expect(result).toEqual({ error: expect.stringMatching(/active editor or trusted editor/i) });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  // A message, not a gate. The database re-derives this under its lock and is
  // the thing that actually refuses; this only saves a round trip and says
  // something readable.
  it("refuses an amount over the remaining allowance before the RPC is reached", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: SENDER, profile: EDITOR_PROFILE });
    vi.mocked(getAccountBudgetSnapshot).mockResolvedValue(
      snapshot({ weeklyBaseCapUsd: 4, weeklyRemainingUsd: 4 }),
    );
    const { admin } = bothClients();

    const result = await passAllowance("recipient-1", 5);

    expect(result).toEqual({ error: expect.stringMatching(/left this week/i) });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  // Grants are part of the sender's real headroom, and the RPC counts them.
  // The message must agree, or an editor holding a grant is told they cannot
  // pass money the database would have let them pass.
  it("quotes the remaining allowance including active grants", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: SENDER, profile: EDITOR_PROFILE });
    // $0 base cap — the production default for a new editor — plus a $6 grant.
    vi.mocked(getAccountBudgetSnapshot).mockResolvedValue(
      snapshot({ weeklyBaseCapUsd: 0, weeklyRemainingUsd: 6 }),
    );
    const { admin } = bothClients();

    const result = await passAllowance("recipient-1", 5);

    expect(result).toBeUndefined();
    expect(admin.rpc).toHaveBeenCalledWith("pass_allowance", expect.anything());
  });

  // The one RPC raise that is an ordinary outcome rather than a fault: the
  // client-side check passed against a snapshot, and a render or a second
  // tab moved the answer in between. lib/action-result.ts's rule is that
  // this gets RETURNED — a thrown Server Action error is redacted to #441
  // in production and the sender would never read it.
  it("returns a readable message when the RPC refuses on headroom", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: SENDER, profile: EDITOR_PROFILE });
    vi.mocked(getAccountBudgetSnapshot).mockResolvedValue(snapshot());
    bothClients({
      passError: { message: "pass_allowance: 5 is more than sender-1's remaining allowance of 2" },
    });

    const result = await passAllowance("recipient-1", 5);

    expect(result).toEqual({ error: expect.stringMatching(/reload the page/i) });
  });

  it("throws on any other RPC failure rather than phrasing it politely", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: SENDER, profile: EDITOR_PROFILE });
    vi.mocked(getAccountBudgetSnapshot).mockResolvedValue(snapshot());
    bothClients({ passError: { message: "connection reset" } });

    await expect(passAllowance("recipient-1", 5)).rejects.toThrow(/connection reset/);
  });

  it("revalidates both the sidebar layout and /allowances on success", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: SENDER, profile: EDITOR_PROFILE });
    vi.mocked(getAccountBudgetSnapshot).mockResolvedValue(snapshot());
    bothClients();

    await passAllowance("recipient-1", 5);

    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/allowances");
  });

  it("writes no cache invalidation when the pass was refused", async () => {
    vi.mocked(requireUser).mockResolvedValue({ user: SENDER, profile: ADMIN_PROFILE });

    await passAllowance("recipient-1", 5);

    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
