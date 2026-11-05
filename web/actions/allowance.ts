"use server";

// The allowance request -> grant workflow (0032_allowance_requests.sql,
// widened by 0074_peer_allowance_approval.sql): an editor who trips the
// WEEKLY cap (assertWeeklyCapNotExceeded, lib/spend.ts) can ask for more
// here; an APPROVER — an admin, or a trusted editor deciding for a peer —
// approves (creating a grant) or denies. A grant raises the account's
// EFFECTIVE WEEKLY allowance only —
// see lib/spend.ts's getEffectiveWeeklyCapUsd — never the daily burst
// guard, so nothing in this file ever touches profiles.daily_cap_override_usd.

import { revalidatePath } from "next/cache";
import { requireUser, requireApprover, requireAdmin } from "@/actions/guard";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import {
  endOfManilaWeekIso,
  getWeeklySpend,
  resolveAccountCaps,
  TRUSTED_WEEKLY_CAP_USD,
} from "@/lib/spend";
import {
  decisionBlockReason,
  defaultGrantAmountUsd,
  grantExpiryError,
  peerGrantAmountError,
} from "@/lib/allowance";
import { grantAmountAlreadyDrawnUsd, revokeActiveGrantsFor } from "@/lib/allowance-grants";
import type { ActionResult } from "@/lib/action-result";

// The sidebar's "Request more" / pending-status readout
// (web/lib/sidebar-budget.ts) lives in the root app layout — every route
// under it needs its cached RSC payload invalidated whenever this file
// changes an account's request/grant state, the same "layout" segment
// revalidatePath's own docs describe for exactly this shape of shared UI.
const SIDEBAR_LAYOUT_PATH = "/";
const ALLOWANCES_PATH = "/allowances";
const USERS_PATH = "/users";

/**
 * An editor's own ask for a higher weekly allowance.
 *
 * At most one PENDING request per user is enforced by
 * allowance_requests_one_pending_per_user (0032_allowance_requests.sql) —
 * a partial unique index, not an application-code "check then insert" —
 * see that migration's header for the double-click/two-tab race a
 * check-then-act guard here would leave open (the same shape as lib/
 * spend.ts's own documented CONCURRENCY HOLE). A second insert while one is
 * already pending fails with Postgres's unique-violation code (23505),
 * which this function turns into the operator-actionable message below
 * instead of a generic "Failed to..." throw — the whole reason lib/
 * action-result.ts exists is that an editor who double-clicked needs to
 * read this, not just see error #441.
 */
export async function requestAllowance(
  amountUsd: number,
  reason: string | null,
): Promise<ActionResult> {
  const { user } = await requireUser();

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { error: "Enter a positive allowance amount to request." };
  }

  const trimmedReason = typeof reason === "string" ? reason.trim() : "";

  const admin = createAdminClient();
  const { error } = await admin.from("allowance_requests").insert({
    user_id: user.id,
    requested_usd: amountUsd,
    reason: trimmedReason.length > 0 ? trimmedReason : null,
  });

  if (error) {
    if (error.code === "23505") {
      return {
        error:
          "You already have a pending allowance request — wait for an admin to decide it, or " +
          "cancel it below before asking again.",
      };
    }
    throw new Error(`Failed to submit allowance request: ${error.message}`);
  }

  revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
  revalidatePath(ALLOWANCES_PATH);
}

/**
 * Withdraws the caller's own pending request. Ownership and the
 * still-pending requirement are both re-checked here in application code —
 * not left to RLS alone (0002_rls.sql's own top-of-file note: RLS is the
 * second line, not the first) — so a stale page (Cancel clicked moments
 * after an admin already decided the same request) gets a clear, returned
 * message instead of a silent 0-row update that looks identical to success.
 */
export async function cancelAllowanceRequest(id: string): Promise<ActionResult> {
  const { user } = await requireUser();

  const supabase = await createClient();
  const { data: existing, error: fetchError } = await supabase
    .from("allowance_requests")
    .select("id, user_id, status")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`Failed to load allowance request ${id}: ${fetchError.message}`);
  }
  if (!existing || existing.user_id !== user.id) {
    return { error: "That allowance request could not be found." };
  }
  if (existing.status !== "pending") {
    return {
      error: `This request is already ${existing.status} — only a pending request can be cancelled.`,
    };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("allowance_requests")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("status", "pending");

  if (error) {
    throw new Error(`Failed to cancel allowance request ${id}: ${error.message}`);
  }

  revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
  revalidatePath(ALLOWANCES_PATH);
}

export interface DecideAllowanceRequestOptions {
  /** Defaults to defaultGrantAmountUsd(request.requested_usd) — see lib/allowance.ts. Ignored for a denial. */
  grantAmountUsd?: number;
  /** ISO timestamp. Defaults to endOfManilaWeekIso() — the end of the CURRENT Manila week, not the week the request was filed in. Ignored for a denial. */
  expiresAt?: string;
  note?: string | null;
}

/**
 * An approver's decision on a pending request. Approving creates the matching
 * allowance_grants row ATOMICALLY with the decision, via
 * decide_allowance_request (0032_allowance_requests.sql) — a single
 * PL/pgSQL function, not two separate statements from here — so a partial
 * failure (decision written, grant insert fails) cannot happen. See that
 * migration's header for the full reasoning.
 *
 * Calls the RPC through the CALLER'S OWN session client (createClient()),
 * not createAdminClient(): decide_allowance_request is `security definer`
 * and checks `can_approve_allowance()` (which reads `auth.uid()`) as its own
 * first statement — the service-role admin client has no `auth.uid()`, so
 * calling it that way would make every decision fail the function's own
 * approver check regardless of who actually triggered it. requireApprover()
 * below is still the first, non-negotiable guard (0002_rls.sql's "RLS is
 * the second line, not the first") — the function's own check is a second,
 * independent enforcement of the same rule, not a substitute for it.
 *
 * TWO authorization questions are asked here, not one, and they are
 * deliberately different shapes. requireApprover() answers "may this account
 * decide anything at all" and THROWS, because every decide control is hidden
 * from a non-approver and reaching it means the UI was bypassed.
 * decisionBlockReason (lib/allowance.ts) answers "may this approver decide
 * THIS request" — not their own, and, for a trusted editor, not one above
 * their ceiling — and RETURNS its message, because /allowances renders those
 * rows read-only with the reason showing, so hitting it here is an ordinary
 * stale-page outcome an operator should read, not a fault.
 */
export async function decideAllowanceRequest(
  requestId: string,
  decision: "approve" | "deny",
  options: DecideAllowanceRequestOptions = {},
): Promise<ActionResult> {
  const { user, profile } = await requireApprover();
  const isAdminApprover = profile.role === "admin";

  const supabase = await createClient();
  // `user_id` is selected for decisionBlockReason's self-decision check —
  // 0074's own raise covers the same case, but only after a round trip and
  // as a thrown 500 rather than a sentence the approver can act on.
  const { data: request, error: fetchError } = await supabase
    .from("allowance_requests")
    .select("id, user_id, requested_usd, status")
    .eq("id", requestId)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`Failed to load allowance request ${requestId}: ${fetchError.message}`);
  }
  if (!request) {
    return { error: "That allowance request could not be found." };
  }
  if (request.status !== "pending") {
    return {
      error: `This request is already ${request.status} — it has already been decided.`,
    };
  }

  // Asked AFTER the status checks so the more specific state ("already
  // denied") wins over the more general one when both are true.
  // TRUSTED_WEEKLY_CAP_USD is passed regardless of role — decisionBlockReason
  // returns early for an admin and never reads it, so there is no branch here
  // to keep in sync with the one inside it.
  //
  // The trusted tier's weekly figure, not the regular editor's, which is what
  // this used to be. Two reasons, and the first is fatal on its own: the
  // regular-editor default is now 0 (see lib/spend.ts), and decisionBlockReason
  // treats a ceiling of 0 as UNREADABLE and blocks — so every peer approval
  // would fail with "your approval limit couldn't be read", a message that is
  // both wrong and unactionable. The second is that it reads better anyway: a
  // trusted editor may approve up to what a trusted editor is trusted to spend
  // in a week. Tying their approval limit to a DIFFERENT role's allowance was
  // always a coincidence of both tiers happening to have a number.
  const blockReason = decisionBlockReason({
    approverRole: profile.role,
    approverId: user.id,
    requesterId: request.user_id,
    requestedUsd: request.requested_usd,
    peerMaxGrantUsd: TRUSTED_WEEKLY_CAP_USD,
  });
  if (blockReason) {
    return { error: blockReason };
  }

  const approve = decision === "approve";

  let grantAmountUsd = 0;
  let grantExpiresAt = new Date().toISOString();
  if (approve) {
    // One default for both roles now. There used to be a peer-specific
    // variant clamping to WEEKLY_CAP_USD, because the default rounded UP to
    // the nearest $5 and could overshoot a ceiling that was not itself a
    // multiple of $5. The default is the REQUESTED amount now, and
    // decisionBlockReason above has already refused any non-admin whose
    // request exceeds that same ceiling — so the clamp could only ever be a
    // no-op by the time it ran. An amount the approver TYPED is still never
    // silently clamped: an explicit over-ceiling figure falls through to
    // peerGrantAmountError below, because granting a different number than
    // the one on screen is worse than refusing it.
    grantAmountUsd = options.grantAmountUsd ?? defaultGrantAmountUsd(request.requested_usd);
    if (!Number.isFinite(grantAmountUsd) || grantAmountUsd <= 0) {
      return { error: "Enter a positive dollar amount to grant." };
    }

    if (isAdminApprover) {
      grantExpiresAt = options.expiresAt ?? endOfManilaWeekIso();
      const grantExpiresAtMs = new Date(grantExpiresAt).getTime();
      if (Number.isNaN(grantExpiresAtMs)) {
        return { error: "Enter a valid expiry date for the grant." };
      }
      // Authoritative — the client-side mirror in decide-allowance-request-
      // dialog.tsx is only a fast-fail convenience; this is the check that
      // actually stops a bad expiry from being written, since a client can
      // always send whatever it wants. See grantExpiryError's own doc comment
      // for the two concrete failures (a past expiry, an absurdly far one)
      // this closes.
      const expiryError = grantExpiryError(grantExpiresAtMs);
      if (expiryError) {
        return { error: expiryError };
      }
    } else {
      // Authoritative for the peer ceiling, mirrored client-side in the
      // dialog — same relationship grantExpiryError has with its own input
      // one branch up. decisionBlockReason has already refused a request
      // whose ASKED-FOR amount is over the ceiling; this is the separate,
      // later question of what the approver actually typed into a dialog
      // they were entitled to open.
      const amountError = peerGrantAmountError(grantAmountUsd, TRUSTED_WEEKLY_CAP_USD);
      if (amountError) {
        return { error: amountError };
      }

      // A peer does not choose the expiry: options.expiresAt is IGNORED, not
      // validated. Nothing to validate means nothing to keep in sync with the
      // client, and the dialog hides the picker for a peer for the same
      // reason — a control that cannot change the outcome is a trap. Every
      // peer grant expires at the end of the current Manila week, which is
      // also the default an admin gets, so this narrows the choice rather
      // than inventing a new rule. grantExpiryError is not called: this value
      // is computed here, not received, and endOfManilaWeekIso() is always
      // both in the future and inside MAX_GRANT_EXPIRY_DAYS.
      grantExpiresAt = endOfManilaWeekIso();
    }
  }

  const note = options.note?.trim() ? options.note.trim() : null;

  const { error } = await supabase.rpc("decide_allowance_request", {
    request_id: requestId,
    approve,
    grant_amount_usd: grantAmountUsd,
    grant_expires_at: grantExpiresAt,
    note,
  });

  if (error) {
    // decide_allowance_request (0032_allowance_requests.sql) raises 'request
    // % is not pending (or does not exist)' when a second admin races the
    // first (or a stale page re-submits after someone else already decided
    // it) — the WHERE ... status = 'pending' in that function's own UPDATE
    // finds no row, and it raises rather than silently no-opping. That's an
    // actionable fact for the admin reading it ("reload — someone beat you
    // to this"), not a generic "something broke" — lib/action-result.ts's
    // whole rule is that the first kind gets RETURNED, not thrown, since a
    // thrown Server Action error is redacted to error #441 in production
    // and this approver would never see the real message.
    //
    // Neither of 0074's two raises is matched here, for the same reason
    // 0032's is_admin() raise never was: each one is already guaranteed
    // unreachable by a check above. requireApprover() guarantees
    // can_approve_allowance(), and decisionBlockReason guarantees the
    // self-decision rule — both compare the SAME session identity the
    // function's own auth.uid() resolves to, on the same row, so they cannot
    // legitimately disagree and there is no race between them to lose. If
    // either fires anyway, the app and the database have diverged about who
    // the caller is, which is a fault to surface, not an outcome to
    // phrase politely. (PEER_APPROVAL_TODO.md's CL-4 originally said to map
    // the self-decision raise to a returned message; that would have made
    // this file inconsistent with its own stated rule for no gain.)
    if (error.message.includes("is not pending")) {
      return {
        error: "Someone else already decided this request — reload the page and try again.",
      };
    }
    throw new Error(`Failed to decide allowance request ${requestId}: ${error.message}`);
  }

  revalidatePath(ALLOWANCES_PATH);
  revalidatePath(USERS_PATH);
  revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
}

/**
 * Ends every ACTIVE grant on one account — the undo an approval never had.
 *
 * Why all of them at once rather than a grant picker: the question an admin
 * actually arrives with is "this account has allowance it should not have,
 * take it back", and answering it per-grant means reading a list of rows
 * that are indistinguishable to them (same account, overlapping weeks, a
 * $10 and a $5 that sum to the number they are actually looking at). Grants
 * SUM into one ceiling — see lib/spend.ts's getEffectiveWeeklyCapUsd — so
 * the ceiling is the unit an admin reasons about, and clearing it is the
 * operation that matches. An admin who wants a SMALLER ceiling rather than
 * the base one revokes and re-grants; that is two deliberate steps, which is
 * the right cost for changing what someone was told they could spend.
 *
 * ponytail: revokes the whole active set, no per-grant selection. If a
 * second simultaneous grant per account ever becomes normal (today an admin
 * approves each one by hand), take an optional grantId and default it to
 * "all" rather than growing a picker nobody asked for.
 *
 * Admin only, deliberately narrower than decideAllowanceRequest above, which
 * a trusted editor may also call (0074). A peer's authority is bounded to
 * granting up to WEEKLY_CAP_USD; revoking reaches grants an ADMIN issued,
 * of any size, so it is not inside that bound. requireAdmin() is the whole
 * rule — no second ceiling to get wrong.
 *
 * The write goes through the admin client because allowance_grants has no
 * UPDATE policy at all (0032, kept by 0075) — the same reason every
 * profiles write in actions/account.ts does. RLS stays default-deny for
 * every real user JWT, so this action is the only door.
 *
 * Scoped to rows that are still active (`revoked_at is null`, unexpired) for
 * the same reason decideAccountApproval scopes its UPDATE to DECIDABLE_FROM:
 * the loser of a two-admin race matches zero rows and is told so, rather
 * than silently re-stamping a revocation someone else already made and
 * reporting it as their own.
 */
export async function endActiveGrants(userId: string): Promise<ActionResult> {
  const { user } = await requireAdmin();

  const admin = createAdminClient();

  // The account's OWN base cap, which is what they fall back to. Read here
  // rather than passed from the page: /users renders a snapshot, and sizing
  // a money limit against a figure that may have moved since page load is
  // the one thing this must not do.
  const { data: target, error: profileError } = await admin
    .from("profiles")
    .select("role, daily_cap_override_usd, weekly_cap_override_usd")
    .eq("id", userId)
    .maybeSingle();

  if (profileError) {
    throw new Error(`Failed to load ${userId} before ending grants: ${profileError.message}`);
  }
  if (!target) {
    return { error: "That account could not be found." };
  }

  const nowIso = new Date().toISOString();
  const ended = await revokeActiveGrantsFor(admin, [userId], user.id, nowIso);

  // Zero rows is not "nothing went wrong" here — the admin clicked a control
  // that only renders when the row showed active grants, so zero means the
  // page they are looking at is stale: another admin ended them first, or
  // the last one expired between render and click.
  if (ended.count === 0) {
    revalidatePath(USERS_PATH);
    revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
    return {
      error:
        "That account has no active grants any more — they expired, or another admin ended them first.",
    };
  }

  // Land them at ZERO remaining, not in deficit.
  //
  // Removing the grant outright would drop the ceiling below what they have
  // already spent — an account $5 into a $10 grant would sit at -$5 against
  // its own allowance, blocked harder than "you have had enough this week"
  // and showing a negative figure in its own account menu. They spent that
  // money legitimately while the grant was live, and no admin ending a
  // grant means "put them in the hole".
  //
  // So the drawn portion is re-granted: ceiling == spend, remaining == 0.
  // Nothing is clawed back (it cannot be — the money is already at the
  // vendor), nothing further can be spent, and the replacement expires with
  // the week so Monday restores them to their base allowance on its own.
  //
  // Untouched grants write nothing at all: an account that never spent past
  // its own cap has drawn 0, and ending the grant costs it nothing.
  const baseWeeklyCapUsd = resolveAccountCaps(target).weeklyCapUsd;
  const drawnUsd = grantAmountAlreadyDrawnUsd(
    await getWeeklySpend(userId),
    baseWeeklyCapUsd,
    ended.totalUsd,
  );

  if (drawnUsd > 0) {
    const { error: replacementError } = await admin.from("allowance_grants").insert({
      user_id: userId,
      amount_usd: drawnUsd,
      expires_at: endOfManilaWeekIso(),
      granted_by: user.id,
      note: "Holds the account at what it had already spent when its grant was ended.",
    });

    // Thrown, not returned: the grants ARE ended by this point, so a failure
    // here leaves the account in the deficit this branch exists to prevent.
    // That is a fault to surface loudly, not a message to phrase politely.
    if (replacementError) {
      throw new Error(
        `Ended grants for ${userId} but could not hold it at its spent amount: ${replacementError.message}`,
      );
    }
  }

  revalidatePath(USERS_PATH);
  revalidatePath(ALLOWANCES_PATH);
  // The account's own menu and /profile read the same figures — see
  // requestAllowance's note on why this is a "layout" revalidate.
  revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
}
