// The single writer of allowance_grants.revoked_at
// (0075_revoke_allowance_grants.sql).
//
// Two Server Actions end grants, for two different reasons, and they must
// end them the same way:
//
//   - actions/allowance.ts's endActiveGrants — an admin stopping a grant
//     that was wrong, which then re-grants whatever was already spent so the
//     account lands at zero remaining rather than in deficit.
//   - actions/account.ts's setWeeklyCapOverride, when the override is ZERO
//     — "this account spends nothing". A zero base cap that live grants
//     still sit on top of is not zero: getEffectiveWeeklyCapUsd is
//     `resolveAccountCaps(...).weeklyCapUsd + activeGrantsUsd`, so an
//     account zeroed while holding a $20 grant has an effective ceiling of
//     $20 and keeps rendering. Zeroing without this is a control that
//     reports success and does nothing, which is worse than not having it.
//
// Lives here rather than in either action file because a "use server"
// module may only export async Server Actions — a shared helper cannot live
// beside its callers, and the alternative (one action importing the other)
// would drag along that action's own requireAdmin and its own "nothing to
// revoke" error semantics, which are right for one caller and wrong for the
// other. Both callers have already cleared requireAdmin() before reaching
// this; it performs no authorization of its own and must never be exported
// through a route.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

/**
 * Revokes every ACTIVE APPROVER grant on one account, returning how many
 * rows it actually ended.
 *
 * "Active" is the same predicate the four SQL aggregates enforce
 * (0075_revoke_allowance_grants.sql): unexpired AND not already revoked.
 * This set is deliberately NARROWER than theirs by one term — it also skips
 * both halves of a pass — for the reason spelled out at the filter below.
 * The aggregates are right to count a pass; an admin revoke is wrong to end
 * one, so the two predicates diverge on purpose and revoked-grants-drift
 * still governs only the four aggregates.
 * Scoping the UPDATE to that set rather than to `user_id` alone is what
 * makes the count meaningful — a second admin revoking the same account a
 * moment later matches zero rows and can say so, instead of re-stamping a
 * revocation someone else made and reporting it as their own. Same
 * concurrency shape as decideAccountApproval's `.in("status", ...)`.
 *
 * `revokedAtIso` is passed in rather than read from the clock here so one
 * caller can stamp a batch of writes with a single instant, and so a test
 * can assert the value without freezing time — the same reasoning
 * lib/spend.ts's startOfManilaDayIso and 0032's user_active_grants_usd(at_ts)
 * both already follow.
 */
export async function revokeActiveGrantsFor(
  admin: SupabaseClient<Database>,
  userIds: readonly string[],
  revokedBy: string,
  revokedAtIso: string,
): Promise<{ count: number; totalUsd: number }> {
  // An empty list would otherwise become `in.()`, which PostgREST rejects
  // as a malformed filter — and the honest answer for "revoke nothing" is
  // zero, not an error. setAllEditorsWeeklyCap reaches this on a team with
  // no editor-tier accounts, which that action already treats as a
  // legitimate state.
  if (userIds.length === 0) return { count: 0, totalUsd: 0 };

  const { data, error } = await admin
    .from("allowance_grants")
    .update({ revoked_at: revokedAtIso, revoked_by: revokedBy })
    .in("user_id", userIds as string[])
    .gt("expires_at", revokedAtIso)
    .is("revoked_at", null)
    // ...and never half of a pass. A pass (0087_pass_allowance.sql) is two
    // rows summing to zero, only one of which sits on this account. The
    // sender's negative half is unexpired and unrevoked, so it reads as
    // active, but revoking it alone leaves the recipient's positive half
    // standing and mints the amount into the team pool — the one property
    // that makes a pass need no approver. `transfer_peer_id is null` is
    // exactly "a grant an approver made", which is the only kind an admin
    // revoke has any business ending; both halves of a pass are the two
    // parties' own business and end together on their own expiry.
    .is("transfer_peer_id", null)
    // amount_usd as well as id: endActiveGrants sizes its replacement grant
    // against what was actually ended, so it can never hand back more
    // headroom than it took away.
    .select("id, amount_usd");

  if (error) {
    throw new Error(
      `Failed to revoke allowance grants for ${userIds.length} account(s): ${error.message}`,
    );
  }

  const rows = data ?? [];
  return {
    count: rows.length,
    totalUsd: rows.reduce((sum, row) => sum + row.amount_usd, 0),
  };
}

/**
 * How much of a grant an account has already spent — the figure that decides
 * what "end this grant" leaves them with.
 *
 * There is no `grant_id` on `runs`, so nothing records which dollars came
 * from a grant and which from the base allowance. It does not need to: spend
 * above the base weekly cap could only have been authorised by a grant, so
 * the overshoot IS the drawn amount. Clamped to what was actually ended, so
 * a stale or concurrent read can never manufacture headroom.
 *
 * Zero when they never spent past their own allowance — the grant was never
 * drawn on, and ending it should cost them nothing.
 */
export function grantAmountAlreadyDrawnUsd(
  weeklySpentUsd: number,
  baseWeeklyCapUsd: number,
  endedTotalUsd: number,
): number {
  return Math.min(Math.max(0, weeklySpentUsd - baseWeeklyCapUsd), endedTotalUsd);
}
