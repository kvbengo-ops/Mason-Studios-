// Pure helpers for CREDIT PASSING (0087_pass_allowance.sql,
// web/actions/transfer.ts, docs/credit_passing_plan.md): an editor or
// trusted editor hands part of their own weekly headroom to another editor
// or trusted editor, with nobody's approval.
//
// Its own file rather than a section of lib/allowance.ts, and the line
// between them is the same one that file's own header draws with
// lib/spend.ts: lib/spend.ts is CAP ARITHMETIC, lib/allowance.ts is the
// REQUEST -> GRANT workflow (an editor asks, an approver decides), and this
// is a THIRD workflow that shares neither's shape — no request row, no
// decision, no approver, and a ledger entry on BOTH sides instead of one.
// The two meet only where every allowance path meets: lib/spend.ts's
// getEffectiveWeeklyCapUsd, which sums the allowance_grants rows all of
// them write.
//
// Deliberately NOT `server-only`, and it must stay that way:
// components/pass-credits-dialog.tsx is a Client Component and imports
// passBlockReason from here, exactly as decide-allowance-request-dialog.tsx
// imports decisionBlockReason. Both imports below are safe on that boundary
// — ProfileRole is type-only (erased at compile time) and lib/format-usd.ts
// documents its own client-safety at its line 20.

import type { ProfileRole } from "@/types/db";
import { formatCredits, remainingForDisplayUsd } from "@/lib/format-usd";

/**
 * The `profiles.role` values that may be either end of a pass.
 *
 * ADMINS ARE OUT OF SCOPE ON BOTH ENDS, which is why this is one list and
 * not a sender list plus a recipient list. An admin has no weekly allowance
 * worth passing (they can raise anyone's cap outright on /users), and an
 * admin RECEIVING a pass would move an editor's headroom somewhere no editor
 * can get it back from. 0087_pass_allowance.sql raises on both directions
 * independently — this list is what turns each into a sentence.
 */
export const PASS_ROLES: readonly ProfileRole[] = ["editor", "trusted_editor"];

/**
 * Why the CALLER may not pass credits at all, regardless of who they picked.
 *
 * Exported as a constant because it has two call sites that must not drift:
 * passBlockReason below, and web/actions/transfer.ts, which has to refuse a
 * non-editor caller BEFORE it can look a recipient up — transfer_recipients()
 * returns nothing for such a caller, so there would be no recipient role to
 * build a PassEligibility from. One string, two callers, no copy.
 */
export const NOT_A_PASSER =
  "Only an editor or a trusted editor can pass credits — admins raise an allowance instead.";

export interface PassEligibility {
  /** The would-be sender's role. */
  senderRole: ProfileRole;
  /** The would-be sender's user id. */
  senderId: string;
  /** The chosen recipient's role. */
  recipientRole: ProfileRole;
  /** The chosen recipient's user id. */
  recipientId: string;
  /** How much is about to be passed, in DOLLARS. The dialog converts from credits at its edge (docs/credit-display-plan.md). */
  amountUsd: number;
  /** weeklyBaseCapUsd − weeklyUsedUsd − heldUsd + active grants. Can be <= 0. */
  headroomUsd: number;
}

/**
 * Why this account may not pass this amount to this recipient, or null when
 * it may.
 *
 * Same `string | null` shape as lib/allowance.ts's decisionBlockReason, and
 * for the same reason: THREE callers have to agree on this answer and must
 * not each re-derive it — passAllowance (web/actions/transfer.ts), which is
 * the authoritative one; PassCreditsDialog, which fast-fails so a refusal
 * costs no round trip; and the sidebar, which decides what to say when
 * headroom is zero. A hand-copied predicate in three places is exactly the
 * drift this codebase already refuses to accept for grant expiry bounds.
 *
 * It is NOT the gate. 0087_pass_allowance.sql re-checks every rule below
 * against auth.uid() and raises, because a Client Component can send
 * anything and a Server Action can be reached without a dialog. This
 * function only turns each refusal into something a person reads instead of
 * a 500 — the same relationship decisionBlockReason has with 0074's own
 * raises.
 *
 * The rules, in the order they are checked:
 *
 *   1. The AMOUNT first, because it is the only one that is wrong on its own
 *      terms rather than wrong for this pair — and because a headroom
 *      comparison against NaN silently passes (`NaN > x` is false), so a
 *      non-finite amount checked later would be checked not at all.
 *   2. NOBODY passes to themselves. It would write +X and −X to the same
 *      account, net zero, and read as a bug in every breakdown that showed
 *      it.
 *   3. The SENDER must be an editor tier. Checked before the recipient
 *      because it is the caller's own problem and the more useful thing to
 *      be told.
 *   4. The RECIPIENT must be an editor tier.
 *   5. The amount must fit the sender's headroom. Last, because it is the
 *      only rule whose answer changes minute to minute — the other four are
 *      facts about who these two accounts are.
 *
 * Deliberately does NOT check the recipient's account status. The eligible
 * set comes from transfer_recipients() (0087), which returns only ACTIVE
 * editors and trusted editors, so both real callers pick from a list that
 * cannot contain a suspended account — and the RPC re-checks it anyway. A
 * status field on PassEligibility would be a fourth thing to thread through
 * that no caller could ever set to anything but 'active'.
 */
export function passBlockReason({
  senderRole,
  senderId,
  recipientRole,
  recipientId,
  amountUsd,
  headroomUsd,
}: PassEligibility): string | null {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return "Enter a positive amount to pass.";
  }

  if (senderId === recipientId) {
    return "You can't pass credits to yourself — pick a teammate.";
  }

  if (!PASS_ROLES.includes(senderRole)) {
    return NOT_A_PASSER;
  }

  if (!PASS_ROLES.includes(recipientRole)) {
    return "You can only pass credits to another editor or trusted editor.";
  }

  // NOTHING TO PASS is its own refusal, ahead of the comparison below.
  // Both used to share one "you only have 0 cr left — you can't pass more
  // than that" message, which reads as a cap on the AMOUNT when the real
  // answer is that no amount would work. An empty balance is a different
  // fact from an amount that overshoots a real one, and the sender acts on
  // it differently: top up, rather than retype a smaller number.
  //
  // Catches non-finite headroom too. It is unpassable for the same reason
  // an empty balance is, and routing it here rather than through the
  // comparison keeps NaN from being waved past `amountUsd > headroomUsd`,
  // which is false for every amount.
  if (!Number.isFinite(headroomUsd) || headroomUsd <= 0) {
    // Still quotes the figure, and still through remainingForDisplayUsd: an
    // account in deficit has negative headroom and must never be shown it —
    // "-400 cr" is a number nobody can act on. Clamped at DISPLAY only; the
    // condition above tests the real value.
    return (
      `Insufficient funds — you have ${formatCredits(remainingForDisplayUsd(headroomUsd))} ` +
      "left to pass this week."
    );
  }

  if (amountUsd > headroomUsd) {
    // Reached only with a real, positive balance, so this is now purely
    // "that is more than you have" and can say so without also having to
    // cover the empty case.
    return (
      `You only have ${formatCredits(remainingForDisplayUsd(headroomUsd))} left this week — ` +
      "you can't pass more than that."
    );
  }

  return null;
}
