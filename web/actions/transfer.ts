"use server";

// Credit passing (0087_pass_allowance.sql, docs/credit_passing_plan.md): an
// editor or trusted editor hands part of their own weekly headroom to
// another, with nobody's approval. A pass writes TWO allowance_grants rows —
// +X to the recipient, −X to the sender — so it is zero-sum and cannot
// create allowance, which is the whole reason it needs no approver.
//
// Nothing here touches the daily burst guard or profiles.daily_cap_override_
// usd, for the same reason actions/allowance.ts does not: a grant (either
// half of one, here) moves the EFFECTIVE WEEKLY allowance only — see
// lib/spend.ts's getEffectiveWeeklyCapUsd.

import { revalidatePath } from "next/cache";
import { requireUser } from "@/actions/guard";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { getAccountBudgetSnapshot } from "@/lib/spend";
import { passBlockReason, PASS_ROLES, NOT_A_PASSER } from "@/lib/transfer";
import type { ActionResult } from "@/lib/action-result";

// Same two paths actions/allowance.ts revalidates for a grant, and for the
// same reasons: the sidebar's budget readout lives in the root app layout
// (hence the "layout" segment), and /allowances lists the passes.
const SIDEBAR_LAYOUT_PATH = "/";
const ALLOWANCES_PATH = "/allowances";

/**
 * Passes `amountUsd` of the CALLER'S OWN weekly headroom to `toUserId`.
 *
 * The sender is never a parameter — it is requireUser()'s identity here and
 * auth.uid() inside the RPC. See 0087_pass_allowance.sql's header for why
 * that is stated rather than assumed.
 *
 * THREE reads, and each one is doing a job the others cannot:
 *
 *   1. requireUser() — the caller's own id and role, and the /pending
 *      redirect for an unapproved account.
 *   2. transfer_recipients() (0087) — the eligible recipient set. Used
 *      instead of reading the recipient's profiles row because an editor has
 *      no RLS policy that lets them, and reaching for createAdminClient()
 *      here would mean a service-role read standing in for a rule the
 *      database already states in one place. Membership in that list IS
 *      recipient eligibility: it is the same `active editor tier, not
 *      yourself` predicate pass_allowance re-checks.
 *   3. getAccountBudgetSnapshot() — the sender's headroom.
 *
 * The role guard runs BEFORE (2), not because it is cheaper but because
 * transfer_recipients() returns nothing at all to a non-passer, so an admin
 * calling this would otherwise get "that account can't receive credits" —
 * a true sentence about the wrong party. NOT_A_PASSER is shared with
 * passBlockReason so the two cannot drift.
 *
 * TWO CLIENTS, deliberately, and mixing them up is the bug to avoid here.
 *
 *   * transfer_recipients() goes through the CALLER'S OWN session client. It
 *     resolves the caller from auth.uid() and would return an empty list to the
 *     service role, which has no identity — the same reasoning, in the same
 *     words, as decideAllowanceRequest's.
 *   * pass_allowance() goes through createAdminClient(). It is revoked from
 *     `authenticated` (0087 section 2b) precisely so a browser cannot call it,
 *     which is what makes it safe for it to take the sender as a parameter.
 *
 * THE SERVICE-ROLE SESSION IS NOT THE EDITOR'S SESSION, so the editor's
 * identity has to be carried explicitly: `user.id` below is requireUser()'s
 * answer, established before any of this, and it is the only thing that says
 * whose allowance moves. It is never read from an argument, a form field or the
 * recipient list — the id the browser sends is `toUserId`, and it is only ever
 * used as the RECIPIENT, after being found in a list the database built.
 */
export async function passAllowance(
  toUserId: string,
  amountUsd: number,
  note?: string,
): Promise<ActionResult> {
  const { user, profile } = await requireUser();

  if (!PASS_ROLES.includes(profile.role)) {
    return { error: NOT_A_PASSER };
  }

  const supabase = await createClient();

  // Independent reads, fired together — the recipient list does not depend
  // on the sender's budget or the other way round.
  const [{ data: recipients, error: recipientsError }, snapshot] = await Promise.all([
    supabase.rpc("transfer_recipients"),
    getAccountBudgetSnapshot(user.id, profile),
  ]);

  if (recipientsError) {
    throw new Error(`Failed to load pass recipients: ${recipientsError.message}`);
  }

  const recipient = (recipients ?? []).find((row) => row.id === toUserId);
  if (!recipient) {
    return {
      error:
        "That account can't receive credits right now — it has to be an active editor or " +
        "trusted editor. Reload the page and pick again.",
    };
  }

  // FOR THE MESSAGE ONLY. The gate is pass_allowance's own computation, under
  // its lock, from user_spend_usd and user_active_grants_usd — this figure
  // never reaches the database (0087 section 2).
  //
  // weeklyRemainingUsd is the right number to SHOW because it is the true
  // one: effective cap (base + active grants) minus spend minus held, the
  // same three terms the RPC adds up. An earlier version passed
  // `weeklyBaseCapUsd - weeklyUsedUsd - heldUsd` here — grants deducted —
  // because that was also the value being sent as the headroom argument, and
  // it made this refusal stricter than the database's: a sender holding a
  // grant was told they had less than they could actually pass. With the
  // argument gone there is no reason to keep quoting the reduced figure.
  const headroomUsd = snapshot.weeklyRemainingUsd;

  const blockReason = passBlockReason({
    senderRole: profile.role,
    senderId: user.id,
    recipientRole: recipient.role,
    recipientId: toUserId,
    amountUsd,
    headroomUsd,
  });
  if (blockReason) {
    return { error: blockReason };
  }

  const trimmedNote = typeof note === "string" ? note.trim() : "";

  // The service-role client, for the reason in this function's doc comment.
  const admin = createAdminClient();
  const { error } = await admin.rpc("pass_allowance", {
    // The authenticated sender, carried explicitly because the service-role
    // session has no auth.uid() for the function to resolve. This is
    // requireUser()'s answer, never anything the browser sent.
    p_from_user_id: user.id,
    p_to_user_id: toUserId,
    p_amount_usd: amountUsd,
    // The two terms SQL cannot derive, and nothing else. Both come from this
    // server's own admin-client reads:
    //
    //   * the weekly BASE cap — WEEKLY_CAP_USD / TRUSTED_WEEKLY_CAP_USD from
    //     render.yaml, or the account's weekly_cap_override_usd, resolved by
    //     resolveAccountCaps. A Postgres function cannot read an env var,
    //     which is why reserve_image_attempt takes its ceilings the same way.
    //   * the in-flight render estimate — each queued or rendering scene
    //     priced through lib/models.ts's rate table and the scene-override
    //     merge. There is no SQL expression for it.
    //
    // Spend, active grants and the expiry are all the function's own, computed
    // under its per-sender lock. There is deliberately no headroom argument
    // and no expiry argument: those were the two findings.
    p_weekly_base_cap_usd: snapshot.weeklyBaseCapUsd,
    p_held_usd: snapshot.heldUsd,
    p_note: trimmedNote.length > 0 ? trimmedNote : null,
  });

  if (error) {
    // The headroom raise is the one refusal here that is an ordinary
    // outcome rather than a fault: passBlockReason checked the same rule a
    // moment ago against a snapshot, and a render that landed in between —
    // or a second pass from another tab — legitimately moves the answer.
    // That is a sentence to read, not an error #441 (lib/action-result.ts).
    //
    // None of 0087's other raises is matched, for the reason
    // decideAllowanceRequest states about 0074's: each is already guaranteed
    // unreachable by a check above, comparing the SAME session identity the
    // function's own auth.uid() resolves to. If one fires anyway, the app
    // and the database disagree about who the caller is, which is a fault to
    // surface rather than an outcome to phrase politely.
    if (error.message.includes("remaining allowance")) {
      return {
        error: "You don't have that much left any more — reload the page to see what you can pass.",
      };
    }
    throw new Error(`Failed to pass allowance to ${toUserId}: ${error.message}`);
  }

  revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
  revalidatePath(ALLOWANCES_PATH);
}
