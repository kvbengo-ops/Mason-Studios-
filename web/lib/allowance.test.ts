import { describe, expect, it } from "vitest";
import {
  BULK_ALLOWANCE_SCOPE_ROLES,
  MAX_GRANT_EXPIRY_DAYS,
  decisionBlockReason,
  defaultGrantAmountUsd,
  grantExpiryError,
  weeklyCapOverrideError,
  peerGrantAmountError,
} from "./allowance";

describe("defaultGrantAmountUsd", () => {
  it("pre-fills exactly what was asked for", () => {
    expect(defaultGrantAmountUsd(10)).toBe(10);
    expect(defaultGrantAmountUsd(7)).toBe(7);
    expect(defaultGrantAmountUsd(0.5)).toBe(0.5);
  });

  // The bug this replaced a $5 round-up to fix: every request under $5
  // pre-filled the approve dialog at $5 no matter what was asked, five times
  // over on a $1 ask.
  it("a small request does not balloon to the old $5 floor", () => {
    expect(defaultGrantAmountUsd(1)).toBe(1);
    // The whole range that used to collapse onto $5.
    for (const usd of [1, 2, 3, 4, 4.99]) {
      expect(defaultGrantAmountUsd(usd)).toBe(usd);
    }
  });

  it("returns 0 for a non-positive or non-finite input — the callers reject it with a message", () => {
    expect(defaultGrantAmountUsd(0)).toBe(0);
    expect(defaultGrantAmountUsd(-5)).toBe(0);
    expect(defaultGrantAmountUsd(NaN)).toBe(0);
    expect(defaultGrantAmountUsd(Infinity)).toBe(0);
  });

  // peerDefaultGrantAmountUsd used to clamp this default to a peer's
  // ceiling, because the round-up could overshoot one that was not a
  // multiple of $5. With the default equal to the request, and
  // decisionBlockReason already refusing a peer whose REQUEST is over the
  // ceiling, the clamp cannot bind — this is the property that made it
  // deletable rather than a claim to take on faith.
  it("never pre-fills something peerGrantAmountError would refuse, for any request a peer may decide", () => {
    for (const ceiling of [3, 7, 12, 17.5, 30]) {
      for (const requested of [0.5, 1, 4, 6, 11, 12, 29, 40]) {
        const decidable = decisionBlockReason({
          approverRole: "trusted_editor",
          approverId: "approver",
          requesterId: "requester",
          requestedUsd: requested,
          peerMaxGrantUsd: ceiling,
        });
        if (decidable) continue;
        expect(peerGrantAmountError(defaultGrantAmountUsd(requested), ceiling)).toBeNull();
      }
    }
  });
});

// Guards the two concrete failures an unbounded "does this parse" check let
// through: a fat-fingered PAST date (a grant that's dead on arrival) and an
// absurdly FAR-FUTURE date (a grant that never expires in practice). A fixed
// `nowMs` in every test here, not `Date.now()`, so these assertions don't
// depend on wall-clock time at test-run time.
describe("grantExpiryError", () => {
  const NOW_MS = new Date("2026-08-14T00:00:00.000Z").getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("returns null (valid) for an expiry a few days out", () => {
    expect(grantExpiryError(NOW_MS + 7 * DAY_MS, NOW_MS)).toBeNull();
  });

  it("rejects an expiry in the past — the fat-fingered-year case", () => {
    expect(grantExpiryError(NOW_MS - DAY_MS, NOW_MS)).toMatch(/future/i);
  });

  it("rejects an expiry exactly at now — landing on the instant is not 'in the future'", () => {
    expect(grantExpiryError(NOW_MS, NOW_MS)).toMatch(/future/i);
  });

  it("accepts an expiry exactly at the MAX_GRANT_EXPIRY_DAYS boundary", () => {
    expect(grantExpiryError(NOW_MS + MAX_GRANT_EXPIRY_DAYS * DAY_MS, NOW_MS)).toBeNull();
  });

  it("rejects an expiry just past the MAX_GRANT_EXPIRY_DAYS boundary", () => {
    expect(grantExpiryError(NOW_MS + (MAX_GRANT_EXPIRY_DAYS + 1) * DAY_MS, NOW_MS)).toMatch(
      /days out/i,
    );
  });

  it("rejects an absurdly far expiry — the 2099-01-01 case", () => {
    expect(grantExpiryError(new Date("2099-01-01").getTime(), NOW_MS)).toMatch(/days out/i);
  });
});

// Peer approval (0074_peer_allowance_approval.sql, docs/credit-display-plan.md
// § P6). These two functions are the ONLY place the "who may decide what"
// rules exist — three callers (the Server Action, /allowances, the approve
// dialog) read them rather than each re-deriving the predicate — so the
// table below is the specification, not a sample of it. Ceilings are passed
// explicitly, never read from WEEKLY_CAP_USD, so nothing here depends on
// which cap env vars happen to be set when the suite runs.
describe("decisionBlockReason", () => {
  const ADMIN = "admin-1";
  const PEER = "trusted-1";
  const REQUESTER = "editor-1";
  const CEILING = 30;

  it("lets an admin decide someone else's request, at any size", () => {
    expect(
      decisionBlockReason({
        approverRole: "admin",
        approverId: ADMIN,
        requesterId: REQUESTER,
        requestedUsd: 500,
        peerMaxGrantUsd: CEILING,
      }),
    ).toBeNull();
  });

  it("lets a trusted editor decide a request at or under their ceiling", () => {
    for (const requestedUsd of [1, CEILING - 0.01, CEILING]) {
      expect(
        decisionBlockReason({
          approverRole: "trusted_editor",
          approverId: PEER,
          requesterId: REQUESTER,
          requestedUsd,
          peerMaxGrantUsd: CEILING,
        }),
      ).toBeNull();
    }
  });

  // The rule with no carve-out: an approver of ANY role is refused their own
  // request. 0074 raises on the same condition independently — this is what
  // turns that raise into a sentence instead of a 500.
  it("refuses an admin their own request — the rule has no admin exception", () => {
    expect(
      decisionBlockReason({
        approverRole: "admin",
        approverId: ADMIN,
        requesterId: ADMIN,
        requestedUsd: 5,
        peerMaxGrantUsd: CEILING,
      }),
    ).toMatch(/your own/i);
  });

  it("refuses a trusted editor their own request", () => {
    expect(
      decisionBlockReason({
        approverRole: "trusted_editor",
        approverId: PEER,
        requesterId: PEER,
        requestedUsd: 5,
        peerMaxGrantUsd: CEILING,
      }),
    ).toMatch(/your own/i);
  });

  // Over the ceiling blocks BOTH decisions, not just approval: "escalates to
  // an admin" is only true if a peer cannot deny it either.
  it("refuses a trusted editor a request just over their ceiling, and says an admin must decide it", () => {
    expect(
      decisionBlockReason({
        approverRole: "trusted_editor",
        approverId: PEER,
        requesterId: REQUESTER,
        requestedUsd: CEILING + 0.01,
        peerMaxGrantUsd: CEILING,
      }),
    ).toMatch(/admin has to decide/i);
  });

  it("refuses a plain editor outright — the UI never offers this, but the answer must not depend on a guard having run elsewhere", () => {
    expect(
      decisionBlockReason({
        approverRole: "editor",
        approverId: "editor-2",
        requesterId: REQUESTER,
        requestedUsd: 1,
        peerMaxGrantUsd: CEILING,
      }),
    ).toMatch(/admin or a trusted editor/i);
  });

  // Fails CLOSED. /allowances leaves peerMaxGrantUsd null when lib/spend.ts
  // fails to load (a malformed cap env var); a peer must be blocked then, not
  // waved through against some number nobody chose.
  it("blocks a trusted editor when the ceiling is unreadable, and does not block an admin", () => {
    for (const peerMaxGrantUsd of [null, 0, -1, Number.NaN]) {
      expect(
        decisionBlockReason({
          approverRole: "trusted_editor",
          approverId: PEER,
          requesterId: REQUESTER,
          requestedUsd: 1,
          peerMaxGrantUsd,
        }),
      ).toMatch(/approval limit/i);
      expect(
        decisionBlockReason({
          approverRole: "admin",
          approverId: ADMIN,
          requesterId: REQUESTER,
          requestedUsd: 1,
          peerMaxGrantUsd,
        }),
      ).toBeNull();
    }
  });
});

// The separate, later question decisionBlockReason does not answer: a peer
// entitled to OPEN the dialog can still type a bigger number into it than the
// request asked for.
describe("peerGrantAmountError", () => {
  it("allows an amount at or under the ceiling", () => {
    expect(peerGrantAmountError(29.99, 30)).toBeNull();
    expect(peerGrantAmountError(30, 30)).toBeNull();
  });

  it("refuses an amount over the ceiling — the over-grant a request under the ceiling would otherwise allow", () => {
    expect(peerGrantAmountError(30.01, 30)).toMatch(/approve up to/i);
    expect(peerGrantAmountError(500, 30)).toMatch(/approve up to/i);
  });

  it("fails closed on an unusable ceiling rather than treating it as no ceiling", () => {
    for (const ceiling of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(peerGrantAmountError(5, ceiling)).not.toBeNull();
    }
  });
});

// weeklyCapOverrideError guards a number an admin types that becomes a
// standing weekly spend limit. The bound is not security — an admin can
// raise the env vars — it is the typo guard on the one input here that
// costs real money and has no undo once a render is submitted.
describe("BULK_ALLOWANCE_SCOPE_ROLES", () => {
  // The whole admin protection for the bulk write is that no scope names
  // 'admin' — actions/account.ts feeds these straight into `.in("role", …)`,
  // so a scope that included it would let one admin rewrite every admin's
  // allowance, their own included.
  it("never names admin, in any scope", () => {
    for (const roles of Object.values(BULK_ALLOWANCE_SCOPE_ROLES)) {
      expect(roles).not.toContain("admin");
    }
  });

  it("keeps each tier separable, and 'all' the union of them", () => {
    expect(BULK_ALLOWANCE_SCOPE_ROLES.editor).toEqual(["editor"]);
    expect(BULK_ALLOWANCE_SCOPE_ROLES.trusted_editor).toEqual(["trusted_editor"]);
    expect(BULK_ALLOWANCE_SCOPE_ROLES.hybrid_editor).toEqual(["hybrid_editor"]);
    expect(BULK_ALLOWANCE_SCOPE_ROLES.ai_animator).toEqual(["ai_animator"]);
    expect([...BULK_ALLOWANCE_SCOPE_ROLES.all].sort()).toEqual([
      "ai_animator",
      "editor",
      "hybrid_editor",
      "trusted_editor",
    ]);
  });
});

describe("weeklyCapOverrideError", () => {
  const MAX = 700;

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("refuses %s", (amount) => {
    expect(weeklyCapOverrideError(amount, MAX)).toMatch(/non-negative weekly allowance/i);
  });

  it("accepts zero so an admin can pause an editor's paid renders", () => {
    expect(weeklyCapOverrideError(0, MAX)).toBeNull();
  });

  it("accepts a value at the ceiling but not one over it", () => {
    expect(weeklyCapOverrideError(MAX, MAX)).toBeNull();
    // 5000 for 50 is the mistake this exists for.
    expect(weeklyCapOverrideError(MAX + 0.01, MAX)).toMatch(/highest allowance any role gets/i);
  });

  it("accepts an ordinary value", () => {
    expect(weeklyCapOverrideError(25, MAX)).toBeNull();
  });

  it.each([0, -1, Number.NaN])("blocks everything when the ceiling is unusable (%s)", (max) => {
    // Fail closed: an unreadable ceiling means lib/spend did not load, and
    // guessing a limit is worse than refusing to set one.
    expect(weeklyCapOverrideError(25, max)).not.toBeNull();
  });
});
