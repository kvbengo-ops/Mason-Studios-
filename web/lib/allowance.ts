// Pure helpers for the allowance request -> grant workflow
// (0032_allowance_requests.sql, web/actions/allowance.ts). Kept separate
// from lib/spend.ts on purpose: spend.ts is about CAP ARITHMETIC (what an
// account may spend, and against which ceiling), while this file is about
// the GRANT WORKFLOW itself (what amount a decision defaults to, and since
// P6, WHO may decide it) — the two meet only at spend.ts's
// getEffectiveWeeklyCapUsd, which reads allowance_grants rows this workflow
// writes, and at the peer ceiling below, which the SERVER reads out of
// spend.ts and passes in as a plain number.
//
// Deliberately NOT `server-only`, and it must stay that way:
// components/decide-allowance-request-dialog.tsx is a Client Component and
// imports grantExpiryError, decisionBlockReason and peerGrantAmountError
// from here. Both imports below are safe on that boundary — ProfileRole is
// type-only (erased at compile time) and lib/format-usd.ts documents its own
// client-safety at its line 20.

import type { ProfileRole } from "@/types/db";
import { formatUsd } from "@/lib/format-usd";

/**
 * The amount an approver's dialog pre-fills: WHAT WAS ASKED FOR.
 *
 * It used to be the request rounded UP to the nearest $5, on the reasoning
 * that a default "must never fall short of what was actually asked for."
 * That reasoning was sound and the implementation still got it wrong, for a
 * reason only visible in the unit an editor actually reads. Credits, not
 * dollars, are the editor-facing unit (USD_PER_CREDIT = 0.005, so $5 is
 * 1,000 cr). Every request under $5 therefore pre-filled at 1,000 cr:
 *
 *     ask 200 cr ($1)  -> ceil(1/5)*5 = $5  -> dialog shows 1,000 cr
 *     ask 800 cr ($4)  -> ceil(4/5)*5 = $5  -> dialog shows 1,000 cr
 *     ask 1,200 cr ($6) -> ceil(6/5)*5 = $10 -> dialog shows 2,000 cr
 *
 * A five-fold over-grant on the common case, silently, with the request
 * itself sitting on screen right next to it. An approver skimming a queue
 * approves the number in the box; the grid decided what they granted.
 *
 * "Never falls short" was never the hard part — the requested amount cannot
 * fall short of itself. The $5 quantum was solving for tidy dollar figures
 * in a UI that stopped showing dollars to the people who use it most, and a
 * pre-fill's whole job is to be the answer the approver almost always wants.
 * For a request/approve flow that answer is the request. The approver can
 * still type any positive number, up or down.
 *
 * Non-finite or non-positive (a corrupt row — `allowance_requests_requested_
 * usd_check` makes it > 0 in SQL, so this is defensive only) returns 0,
 * which both decideAllowanceRequest and the dialog already reject with
 * "Enter a positive dollar amount to grant." Better an honest empty box the
 * approver must fill than a number nobody chose.
 */
export function defaultGrantAmountUsd(requestedUsd: number): number {
  if (!Number.isFinite(requestedUsd) || requestedUsd <= 0) {
    return 0;
  }
  return requestedUsd;
}

/**
 * How far out an admin may set a grant's expiry. Chosen as a generous
 * multiple of the 7-day weekly window a grant is meant to top up — long
 * enough that a genuinely long-running exception (an editor covering a
 * multi-week campaign) doesn't need re-granting weekly, short enough that a
 * fat-fingered year (2099 instead of 2026) still gets caught instead of
 * silently inflating the weekly cap indefinitely, which is the failure mode
 * this bound exists to close off — see grantExpiryError's own doc comment.
 */
export const MAX_GRANT_EXPIRY_DAYS = 90;

/**
 * Validates a grant's expiry, in both directions: 0032_allowance_
 * requests.sql's decide_allowance_request only ever checked that
 * `grant_expires_at` PARSES (Number.isNaN(new Date(...).getTime())) — not
 * that it's actually usable. Two concrete failures that check let through:
 *
 *   - A PAST expiry (an admin fat-fingers the year to 2025) writes a grant
 *     that user_active_grants_usd (expires_at > at_ts) excludes from the
 *     moment it's created — the request reads "Approved" in /allowances, the
 *     editor's weekly allowance never actually moves, and nothing reports
 *     the mismatch. The admin believes they fixed the problem; they didn't.
 *   - An absurdly FAR expiry (2099-01-01) writes a grant that inflates the
 *     account's effective weekly cap indefinitely — meeting the letter of
 *     "a grant raises the weekly allowance, never the daily guard" while
 *     defeating its purpose (a ledger entry that never expires is no longer
 *     a temporary top-up, it's a silent permanent cap override nobody
 *     decided to make).
 *
 * Shared between the server-side authoritative check
 * (web/actions/allowance.ts's decideAllowanceRequest — the one that actually
 * matters, since a client can send anything) and the client-side fast-fail
 * mirror (web/components/decide-allowance-request-dialog.tsx), so the two
 * bounds can't drift apart the way a hand-copied duplicate eventually would.
 * `nowMs` is a parameter, not `Date.now()` inlined, for the same testability
 * reason lib/spend.ts's startOfManilaDayIso/startOfManilaWeekIso take `now`.
 *
 * Returns the user-facing message to show, or null when the expiry is fine
 * — callers wrap this in an ActionResult (server) or setErrorMessage
 * (client), never let it throw, since a bad expiry is exactly the kind of
 * operator-actionable input lib/action-result.ts's rule is about.
 */
export function grantExpiryError(expiresAtMs: number, nowMs: number = Date.now()): string | null {
  if (expiresAtMs <= nowMs) {
    return "Grant expiry must be in the future.";
  }
  const maxExpiryMs = nowMs + MAX_GRANT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  if (expiresAtMs > maxExpiryMs) {
    return `Grant expiry can't be more than ${MAX_GRANT_EXPIRY_DAYS} days out.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Peer approval (docs/credit-display-plan.md § P6, PEER_APPROVAL_TODO.md).
//
// A trusted editor may decide another editor's request, so an admin is no
// longer the queue's single bottleneck. Three bounds keep a peer's yes
// smaller than an admin's, and TWO of them live here rather than in SQL:
// 0074_peer_allowance_approval.sql owns the IDENTITY questions (is this
// account an approver at all; is this their own request), because those are
// answerable from auth.uid() alone, while the NUMERIC ceiling depends on
// WEEKLY_CAP_USD — a render.yaml env var a Postgres function has no access
// to. That is the same split grantExpiryError above already lives on, for
// the same reason.
//
// Neither function below reads WEEKLY_CAP_USD itself. lib/spend.ts throws at
// module load on a malformed cap env var and must never be reachable from a
// Client Component, so the ceiling arrives as a plain number the SERVER
// resolved — from the action directly, and from /allowances down into the
// dialog as a prop.
// ---------------------------------------------------------------------------

/**
 * Shown when a peer's ceiling could not be resolved at all (lib/spend.ts
 * failed to load — see /allowances' own dynamic-import block). Deliberately
 * fails CLOSED: an unreadable ceiling blocks the decision rather than
 * defaulting to some number nobody chose. One constant because both
 * functions below can reach this state and must say the same thing.
 */
const CEILING_UNREADABLE =
  "Your approval limit couldn't be read just now — ask an admin to decide this one.";

/** The `profiles.role` values that may decide an allowance request. Mirrors actions/guard.ts's isApprover and 0074's can_approve_allowance(). */
const APPROVER_ROLES: readonly ProfileRole[] = ["admin", "trusted_editor"];

export interface DecisionEligibility {
  /** The would-be decider's role. */
  approverRole: ProfileRole;
  /** The would-be decider's user id. */
  approverId: string;
  /** allowance_requests.user_id — who filed it. */
  requesterId: string;
  /** allowance_requests.requested_usd — what they asked for, NOT what is about to be granted. */
  requestedUsd: number;
  /** lib/spend.ts's WEEKLY_CAP_USD, resolved server-side. Ignored for an admin; a null/unusable value blocks a non-admin. */
  peerMaxGrantUsd: number | null;
}

/**
 * Why this account may not decide this request, or null when it may.
 *
 * Same `string | null` shape as grantExpiryError, and for the same reason:
 * THREE callers have to agree on this answer and must not each re-derive it
 * — decideAllowanceRequest (web/actions/allowance.ts), which is the
 * authoritative one; /allowances, which decides whether to render the
 * Approve/Deny triggers at all; and DecideAllowanceRequestDialog, which
 * fast-fails. A hand-copied predicate in three places is exactly the drift
 * this codebase already refuses to accept for expiry bounds.
 *
 * The rules, in the order they are checked:
 *
 *   1. NOBODY decides their own request — admins included. There is no
 *      carve-out, because one uniform rule is smaller than a rule plus an
 *      exception, and an admin who needs more allowance can be granted it
 *      by another admin or simply given a cap override (/users, P5).
 *      0074 re-raises on this independently; this check is what turns it
 *      into a sentence a person reads instead of a 500.
 *   2. An admin may decide anything else.
 *   3. A non-approver may decide nothing. Unreachable through the app
 *      (requireApprover is the door), kept because this function is also
 *      what the UI asks before rendering a control, and "can this editor
 *      see Approve" must have an answer that does not depend on a guard
 *      having already run somewhere else.
 *   4. A trusted editor may decide a request AT OR UNDER their ceiling.
 *      Over it, the request is read-only for them — deny included, not just
 *      approve. Denying a large ask an admin would have approved is as
 *      damaging as approving one they would have refused, and "escalates to
 *      an admin" is only true if BOTH decisions escalate.
 */
export function decisionBlockReason({
  approverRole,
  approverId,
  requesterId,
  requestedUsd,
  peerMaxGrantUsd,
}: DecisionEligibility): string | null {
  if (approverId === requesterId) {
    return "You can't decide your own allowance request — someone else has to.";
  }

  if (approverRole === "admin") {
    return null;
  }

  if (!APPROVER_ROLES.includes(approverRole)) {
    return "Only an admin or a trusted editor can decide an allowance request.";
  }

  if (peerMaxGrantUsd === null || !Number.isFinite(peerMaxGrantUsd) || peerMaxGrantUsd <= 0) {
    return CEILING_UNREADABLE;
  }

  if (requestedUsd > peerMaxGrantUsd) {
    return (
      `This request is over your ${formatUsd(peerMaxGrantUsd)} approval limit — ` +
      "an admin has to decide it."
    );
  }

  return null;
}

/**
 * Why a NON-ADMIN approver may not grant this amount, or null when they may.
 * Admins have no ceiling and never call this.
 *
 * Separate from decisionBlockReason because it answers a question asked at a
 * different moment: that one gates whether the dialog opens at all (on the
 * amount REQUESTED), this one gates the amount actually typed into it, which
 * the approver may have edited upward. A request under the ceiling can still
 * be over-granted, and that is the hole this closes.
 *
 * Does not re-check positivity — decideAllowanceRequest already rejects a
 * non-positive or non-finite grant before this runs, and duplicating that
 * would mean two messages for one condition. It does re-check the CEILING,
 * because failing closed on an unreadable limit is worth one branch in a
 * money path.
 */
export function peerGrantAmountError(amountUsd: number, peerMaxGrantUsd: number): string | null {
  if (!Number.isFinite(peerMaxGrantUsd) || peerMaxGrantUsd <= 0) {
    return CEILING_UNREADABLE;
  }
  if (amountUsd > peerMaxGrantUsd) {
    return (
      `You can approve up to ${formatUsd(peerMaxGrantUsd)} — ` +
      "an admin has to decide anything larger."
    );
  }
  return null;
}

/**
 * Why this per-account weekly cap override is refused, or null when it is
 * usable. Pure and client-safe, same shape as grantExpiryError and
 * peerGrantAmountError above, so /users' dialog can fast-fail on it and the
 * Server Action can enforce the identical rule without a second copy.
 *
 * `null` as the amount means "clear the override and fall back to the role
 * default" — always legal, so it is not this function's business.
 *
 * The upper bound is ADMIN_WEEKLY_CAP_USD rather than an arbitrary number:
 * it is the largest weekly allowance the system already hands anyone by
 * role, so an override above it is far more likely a typo (5000 for 50)
 * than an intent. It is not a security boundary — an admin who genuinely
 * needs more raises the env var — it is a guard against the one mistake
 * that costs real money and has no undo once a render is submitted.
 */
export function weeklyCapOverrideError(amountUsd: number, maxUsd: number): string | null {
  // Zero is deliberate: it lets an admin pause new paid renders for one
  // account without changing that account's role or disabling its access to
  // the rest of the app. The database constraint is non-negative for the same
  // reason.
  //
  // Zero is also the one value that does NOT coexist with active grants:
  // setWeeklyCapOverride revokes them (0075_revoke_allowance_grants.sql)
  // when it writes a zero, because getEffectiveWeeklyCapUsd adds grants to
  // this figure and an account zeroed while holding one would keep
  // rendering against the grant. Grant HISTORY survives — revoking appends
  // revoked_at, it does not delete the row — but the headroom does not.
  // Every other value leaves grants alone, which is the workflow working.
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    return "Enter a non-negative weekly allowance, or clear it to use the role default.";
  }
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    return CEILING_UNREADABLE;
  }
  if (amountUsd > maxUsd) {
    return (
      `${formatUsd(maxUsd)} is the highest allowance any role gets — ` +
      "raise the cap env vars if someone genuinely needs more than that."
    );
  }
  return null;
}

/**
 * weeklyCapOverrideError's daily twin, for profiles.daily_cap_override_usd.
 *
 * Bounded by ADMIN_DAILY_CAP_USD rather than the weekly ceiling, and NOT
 * cross-checked against this account's weekly figure — deliberately. The
 * "a daily guard must not exceed the weekly allowance" rule is enforced by
 * resolveAccountCaps (lib/spend.ts) clamping on READ, which holds for
 * values written by hand-SQL and for two admins editing the two columns in
 * separate tabs; a check here could do neither and would only duplicate the
 * rule badly enough to disagree with it later. So this answers the one
 * question the read-side clamp cannot: "is this a number at all, and is it
 * within what any role gets".
 *
 * Zero is accepted for the same reason it is on the weekly: an admin
 * pausing one account. A zero DAILY figure is the narrower pause of the two
 * — it stops today's renders without touching the week's allowance or
 * revoking a grant, which is the right tool for "stop, we'll talk tomorrow"
 * as against the weekly zero's "stop until I say otherwise".
 */
// ---------------------------------------------------------------------------
// Bulk allowance scope, for /users' "Set allowance for all editors" control
// (actions/account.ts's setAllEditorsWeeklyCap).
//
// One value for editors and trusted editors together was fine while they
// were the same decision. They are not: a trusted editor may approve a
// colleague's request up to WEEKLY_CAP_USD (0074), so their own allowance
// and an editor's are answers to different questions, and an admin raising
// one had no way to leave the other alone.
// ---------------------------------------------------------------------------

export type BulkAllowanceScope = "editor" | "trusted_editor" | "hybrid_editor" | "ai_animator" | "all";

export interface BulkSpendingLimits {
  count: number;
  weeklyCapUsd: number | null | "mixed";
  dailyCapUsd: number | null | "mixed";
  hourlyCapUsd: number | null | "mixed";
  dailyCapEnabled: boolean;
}

/**
 * Which roles each scope writes to.
 *
 * 'admin' appears in NO list, which is the whole admin protection — the same
 * one clause rather than a separate `.neq("role", "admin")` that a later
 * edit could drop independently, exactly as actions/account.ts's
 * CHANGEABLE_FROM does for the trust toggle. A scope that named admin would
 * rewrite the allowance of the role doing the rewriting.
 *
 * Shared with the dialog rather than restated there: the control names the
 * account count it is about to affect, and a UI counting one set while the
 * action writes another is a lie about a money limit.
 */
export const BULK_ALLOWANCE_SCOPE_ROLES: Record<BulkAllowanceScope, readonly ProfileRole[]> = {
  editor: ["editor"],
  trusted_editor: ["trusted_editor"],
  hybrid_editor: ["hybrid_editor"],
  ai_animator: ["ai_animator"],
  all: ["editor", "trusted_editor", "hybrid_editor", "ai_animator"],
};

/** What each scope is called on screen. Singular-agnostic — the dialog adds its own counts. */
export const BULK_ALLOWANCE_SCOPE_LABELS: Record<BulkAllowanceScope, string> = {
  editor: "Editors only",
  trusted_editor: "Trusted editors only",
  hybrid_editor: "Hybrid Editors only",
  ai_animator: "AI Animators only",
  all: "All editor tiers",
};

export function dailyCapOverrideError(amountUsd: number, maxUsd: number): string | null {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    return "Enter zero or a positive daily guard, or clear it to use the role default.";
  }
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    return CEILING_UNREADABLE;
  }
  if (amountUsd > maxUsd) {
    return (
      `${formatUsd(maxUsd)} is the highest daily guard any role gets — ` +
      "raise the cap env vars if someone genuinely needs more than that."
    );
  }
  return null;
}
