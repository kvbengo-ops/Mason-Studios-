"use server";

// Admin approval of a newly created account (0052_account_approval.sql).
// Self-serve signup leaves editor profiles at 'pending'; requireUser()
// (actions/guard.ts) holds those editor tiers at /pending. Admins are
// trusted by role and are excluded from this decision path.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/action-result";
import type { ProfileRole, ProfileStatus } from "@/types/db";
import { ASSIGNABLE_ROLES, isAssignableRole } from "@/lib/model-access";
import {
  BULK_ALLOWANCE_SCOPE_ROLES,
  dailyCapOverrideError,
  weeklyCapOverrideError,
  type BulkAllowanceScope,
} from "@/lib/allowance";
import { revokeActiveGrantsFor } from "@/lib/allowance-grants";
import { ADMIN_DAILY_CAP_USD, ADMIN_WEEKLY_CAP_USD } from "@/lib/spend";
import type { GlobalSpendCapPeriod } from "@/lib/spend";

const USERS_PATH = "/users";
// Zeroing an allowance revokes that account's grants (see
// setWeeklyCapOverride), which changes what /allowances totals and what the
// account menu in the root layout shows — the same two surfaces
// actions/allowance.ts revalidates for the same reason.
const ALLOWANCES_PATH = "/allowances";
const SIDEBAR_LAYOUT_PATH = "/";
const ACCOUNTS_CONTROL_PATH = "/accounts-control";

export type AccountDecision = "approve" | "reject" | "deactivate" | "reactivate";

const DECISION_STATUS: Record<AccountDecision, ProfileStatus> = {
  approve: "active",
  reject: "rejected",
  deactivate: "deactivated",
  reactivate: "active",
};

// Which statuses a decision is allowed to move an account OUT of — the
// concurrency guard below, and deliberately not the same list for both
// decisions.
//
// Approve accepts 'rejected' as well as 'pending': rejecting the wrong row
// is one misclick on a list of near-identical rows, and before this the
// only way back was a hand-written UPDATE in the Supabase dashboard. The
// account is held at /pending either way, so re-approving it grants exactly
// what approving it the first time would have.
//
// Reject stays 'pending'-only. Nothing here should be able to cut off an
// account that is already active and working — that is a different, larger
// decision (a suspend/deactivate control) than the one this page makes, and
// it is not in this page's scope.
//
// 'active' appears in neither list, so an already-decided row still loses
// the race rather than silently overwriting the winner.
// Deactivate moves an account OUT of 'active' only. That is the whole point
// of it being a separate decision from reject: reject answers "was this
// application ever accepted", deactivate answers "should this colleague
// still have access". Neither can reach the other's rows, so a misclick on
// one list cannot produce the other's outcome.
//
// Reactivate is 'deactivated'-only for the mirror reason. It must not be
// able to approve a pending account or un-reject a refused one — those are
// approve's decisions, and they are asked on a different row with different
// information in front of the admin.
const DECIDABLE_FROM: Record<AccountDecision, ProfileStatus[]> = {
  approve: ["pending", "rejected"],
  reject: ["pending"],
  deactivate: ["active"],
  reactivate: ["deactivated"],
};

/**
 * Approves or rejects a pending account, from /users.
 *
 * requireAdmin() first, and it is the only authorization here — 0002_rls.sql
 * gives `profiles` no UPDATE policy at all, for anyone, which is what makes
 * "a user promotes themselves" unreachable through PostgREST and is
 * deliberately left that way. The write therefore has to go through
 * createAdminClient(), the same admin-client-behind-a-passing-guard shape
 * actions/profile.ts already uses for every profile write in this app,
 * rather than opening a new update policy just for this column.
 *
 * `.in("status", DECIDABLE_FROM[decision])` is the concurrency guard, not
 * decoration: two admins on the list at once, or one stale tab, would
 * otherwise let the second decision silently overwrite the first —
 * including flipping an account that has already been approved and started
 * working back to 'rejected'. Scoping the UPDATE to the statuses this
 * decision may legally move an account out of makes the loser of that race
 * match zero rows, which is reported below as something the admin can act
 * on rather than a lie about what happened. Same reasoning, and the same
 * returned-not-thrown shape, as decideAllowanceRequest's "is not pending"
 * branch (actions/allowance.ts).
 */
export async function decideAccountApproval(
  userId: string,
  decision: AccountDecision,
): Promise<ActionResult> {
  await requireAdmin();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .update({ status: DECISION_STATUS[decision] })
    .eq("id", userId)
    // Only editor tiers participate in account approval. This server-side
    // filter backs up /users hiding the controls for admin rows.
    .neq("role", "admin")
    .in("status", DECIDABLE_FROM[decision])
    .select("id");

  if (error) {
    throw new Error(`Failed to ${decision} account ${userId}: ${error.message}`);
  }

  // Zero rows means this decision lost the race (or the row is gone). The
  // page the admin is looking at is stale either way, and it is stale in
  // the way that matters: it still shows Approve/Reject on a row that has
  // already been decided, so the obvious next click loses the same race
  // again. Revalidate here as well as on the success path, and let the
  // message say what happened rather than asking the admin to go and
  // refresh the page themselves — the render this triggers has already
  // replaced the row by the time they read it.
  if ((data ?? []).length === 0) {
    revalidatePath(USERS_PATH);
    return {
      error:
        "That account no longer needs approval or someone else already decided it — this list now shows where it stands.",
    };
  }

  revalidatePath(USERS_PATH);
}

// =============================================================================
// Trusted-editor promotion, from /users (0074_peer_allowance_approval.sql).
//
// P6 gives a trusted editor authority to decide a colleague's allowance
// request. The role has existed since 0031 and, until this action, had no
// assignment path anywhere in the app — the only way to grant it was a
// hand-written UPDATE in the Supabase dashboard, which meant P6 shipped
// switched on and inert. See PEER_APPROVAL_TODO.md D10.
//
// Deliberately editor <-> trusted_editor ONLY. Admin promotion is a separate,
// confirmed action below because it grants cross-account access and is not
// reversible from this page.
// =============================================================================

export type RoleDecision = "trust" | "untrust";

const DECISION_ROLE: Record<RoleDecision, ProfileRole> = {
  trust: "trusted_editor",
  untrust: "editor",
};

// Which roles a decision may move an account OUT of — the same concurrency
// guard as DECIDABLE_FROM above, doing a second job at the same time.
//
// 'admin' appears in NEITHER list, so this action cannot touch an admin row
// no matter what userId it is handed. That is the whole admin protection,
// and it lives in one clause rather than in a separate `.neq("role",
// "admin")` that a later edit could drop independently of the guard beside
// it. decideAccountApproval needs its own explicit .neq() precisely because
// its status lists cannot express a role exclusion; this one can.
//
// Status is deliberately NOT constrained here. Promoting a 'pending' editor
// is harmless: can_approve_allowance() (0074) requires status = 'active' for
// the trusted_editor branch, and requireApprover -> canUseApp holds the same
// line in the app, so the role alone grants nothing until the account is
// approved. One rule, enforced where it already lives.
const CHANGEABLE_FROM: Record<RoleDecision, ProfileRole[]> = {
  trust: ["editor"],
  untrust: ["trusted_editor"],
};

/**
 * Promotes an editor to trusted_editor, or demotes one back, from /users.
 *
 * Authorization is requireAdmin() and nothing else, for the same reason
 * decideAccountApproval documents above: 0002_rls.sql gives `profiles` no
 * UPDATE policy at all, so the write has to go through createAdminClient()
 * and "an editor promotes themselves" stays unreachable through PostgREST.
 *
 * Both directions are one action because they are one decision read in two
 * directions, and because demotion has to be as easy as promotion — this
 * hands out spend, and a mispromotion the admin cannot undo from the same
 * row is the shape of mistake that ends in a dashboard UPDATE again.
 */
export async function setTrustedEditor(
  userId: string,
  decision: RoleDecision,
): Promise<ActionResult> {
  await requireAdmin();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .update({ role: DECISION_ROLE[decision] })
    .eq("id", userId)
    .in("role", CHANGEABLE_FROM[decision])
    .select("id");

  if (error) {
    throw new Error(`Failed to ${decision} account ${userId}: ${error.message}`);
  }

  // Zero rows: someone else already changed this role, the row is gone, or
  // the id belongs to an admin. Same treatment as the approval race above —
  // revalidate so the list stops offering the click that just failed, and
  // say so rather than reporting a success that did not happen.
  if ((data ?? []).length === 0) {
    revalidatePath(USERS_PATH);
    return {
      error:
        "That account's role is no longer what this list showed — it now shows where it stands.",
    };
  }

  revalidatePath(USERS_PATH);
}

/**
 * Sets a non-admin account's role from Accounts Control: editor, trusted editor, Hybrid
 * Editor or AI Animator (0131). The role decides spend caps (lib/spend.ts), video models
 * (lib/model-access.ts) and whether the account may approve allowances or hold API tokens
 * (trusted editor only). Admin is never set or cleared here: promoteToAdmin/demoteAdmin
 * own that, with their own guards, so this update only matches rows that are not admin.
 * requireAdmin first; the admin client because profiles has no UPDATE policy (0002_rls.sql).
 */
export async function setAccountRole(userId: string, role: string): Promise<ActionResult> {
  await requireAdmin();
  if (!isAssignableRole(role)) return { error: "Choose a valid role." };

  const { data, error } = await createAdminClient()
    .from("profiles")
    .update({ role })
    .eq("id", userId)
    .in("role", ASSIGNABLE_ROLES as unknown as ProfileRole[])
    .select("id");
  if (error) throw new Error(`Failed to set the role for account ${userId}: ${error.message}`);
  if ((data ?? []).length === 0) {
    return { error: "That account is an admin or no longer exists; its role was not changed." };
  }

  revalidatePath(ACCOUNTS_CONTROL_PATH);
  revalidatePath(USERS_PATH);
}

/** Promotes an active editor to admin, from /users. */
export async function promoteToAdmin(userId: string): Promise<ActionResult> {
  await requireAdmin();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .update({ role: "admin" })
    .eq("id", userId)
    .eq("status", "active")
    .in("role", ASSIGNABLE_ROLES as unknown as ProfileRole[])
    .select("id");

  if (error) {
    throw new Error(`Failed to promote account ${userId} to admin: ${error.message}`);
  }

  if ((data ?? []).length === 0) {
    revalidatePath(USERS_PATH);
    return {
      error: "That account is no longer an active editor — this list now shows where it stands.",
    };
  }

  revalidatePath(USERS_PATH);
}

/** Demotes another admin to editor or trusted_editor, from /users. */
export async function demoteAdmin(
  userId: string,
  role: "editor" | "trusted_editor",
): Promise<ActionResult> {
  const { user } = await requireAdmin();
  if (role !== "editor" && role !== "trusted_editor") {
    throw new Error(`Invalid demotion role: ${String(role)}`);
  }
  // ponytail: refusing yourself is also the last-admin guard — the caller stays an admin.
  if (userId === user.id) {
    return { error: "You can't change your own admin role." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .update({ role })
    .eq("id", userId)
    .eq("role", "admin")
    .select("id");

  if (error) {
    throw new Error(`Failed to demote account ${userId}: ${error.message}`);
  }

  if ((data ?? []).length === 0) {
    revalidatePath(USERS_PATH);
    return {
      error: "That account is no longer an admin — this list now shows where it stands.",
    };
  }

  revalidatePath(USERS_PATH);
}

/**
 * Sets or clears one account's weekly allowance override, from /users.
 *
 * `weeklyCapUsd = null` clears it, and the account falls back to its role
 * default (resolveAccountCaps, lib/spend.ts: `weekly_cap_override_usd ??
 * weeklyCapForRole(role)`). That is the undo, and it is why this control
 * needs no confirmation dialog the way Reject does — every state it can
 * reach is one click from every other.
 *
 * USD, not credits. The column is USD, every cap comparison is USD, and
 * assertWithinSpendCaps is untouched by this file — the credit unit is a
 * display and input concern (lib/format-usd.ts), converted at the dialog
 * boundary, never in transit to a column.
 *
 * Per-account overrides can target any role, including admins. The bulk
 * allowance controls remain explicitly scoped to editor tiers.
 *
 * ADMIN_WEEKLY_CAP_USD is imported statically, exactly as actions/
 * allowance.ts imports WEEKLY_CAP_USD. That does couple this file's other
 * action to lib/spend.ts's module-load throw on a malformed cap env var —
 * accepted deliberately, because an app whose cap vars do not parse is
 * already failing at the render page, /allowances and the sidebar, and one
 * more affected surface is not the difference between working and not.
 */
export async function setWeeklyCapOverride(
  userId: string,
  weeklyCapUsd: number | null,
): Promise<ActionResult> {
  const { user } = await requireAdmin();

  // Authoritative check. The dialog runs the same function for a fast-fail,
  // but a Server Action is reachable without it.
  if (weeklyCapUsd !== null) {
    const error = weeklyCapOverrideError(weeklyCapUsd, ADMIN_WEEKLY_CAP_USD);
    if (error) return { error };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .update({ weekly_cap_override_usd: weeklyCapUsd })
    .eq("id", userId)
    .select("id");

  if (error) {
    throw new Error(`Failed to set weekly allowance for ${userId}: ${error.message}`);
  }

  // Zero rows: the row is gone, or it belongs to an admin. Unlike the two
  // actions above there is no race to lose here — the write is not scoped
  // to a "from" state, so a second admin setting a different number simply
  // wins, which is the correct behaviour for a value with no workflow.
  if ((data ?? []).length === 0) {
    revalidatePath(USERS_PATH);
    return { error: "That account no longer exists." };
  }

  // ZERO MEANS ZERO. getEffectiveWeeklyCapUsd (lib/spend.ts) is
  // `resolveAccountCaps(...).weeklyCapUsd + activeGrantsUsd`, so an account
  // zeroed while holding a live grant has an effective ceiling of that
  // grant and carries on rendering — the control would report success and
  // change nothing an editor could notice. Every other override value
  // deliberately leaves grants alone: a $25 base cap topped up by an
  // approved $10 grant is the workflow working, not a contradiction. Zero
  // is the only value that cannot coexist with a grant, because it is the
  // one value that states an intent about the TOTAL rather than the base.
  //
  // Ordered after the profiles write, not before: if the cap write fails,
  // nothing has been revoked, and the admin retries from an unchanged
  // state. The reverse order can revoke grants and then fail to zero the
  // cap, which loses grant state for no benefit. Not atomic — see the
  // second paragraph of this function's own note above; a single failed
  // revoke leaves a zeroed cap with live grants, which is the pre-0075
  // behaviour and visible on /users as a non-zero Active grants cell.
  if (weeklyCapUsd === 0) {
    await revokeActiveGrantsFor(admin, [userId], user.id, new Date().toISOString());
    revalidatePath(ALLOWANCES_PATH);
    revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
  }

  revalidatePath(USERS_PATH);
}

/**
 * setWeeklyCapOverride's daily twin — profiles.daily_cap_override_usd.
 *
 * That column has existed since 0031_account_allowances.sql and was READ in
 * four places (resolveAccountCaps, /users, /allowances, the render page)
 * while being WRITTEN nowhere in the app: the only way to give one account
 * a different daily burst guard was a hand-written UPDATE in the Supabase
 * dashboard. /users has been rendering "spent today / $X" against a figure
 * no admin on that page could change. Same shape of gap setTrustedEditor
 * closed for profiles.role, and the WeeklyAllowanceDialog closed for the
 * other half of this very pair.
 *
 * NO grant revocation on zero, unlike setWeeklyCapOverride: a grant raises
 * the WEEKLY ceiling only (getEffectiveWeeklyCapUsd), never the daily
 * guard, so a zero here already stops every render on its own — the daily
 * check runs last and refuses regardless of what any grant did to the week.
 * Revoking would remove allowance that this action never claimed to touch.
 *
 * That makes a daily zero the NARROWER of the two pauses, and the reason to
 * keep both: it stops today without touching the week's allowance or
 * cancelling an approval, which is what "stop, we'll talk tomorrow" needs.
 * The weekly zero is "stop until I say otherwise", and pays for that by
 * revoking.
 *
 * No cross-check against this account's weekly figure — resolveAccountCaps
 * clamps the pair on READ (see its own note on why a write-time check
 * cannot hold for hand-SQL writes or two tabs), so a daily override above
 * the weekly allowance is not an error to refuse, it is simply capped at
 * the weekly figure when anything reads it.
 */
export async function setDailyCapOverride(
  userId: string,
  dailyCapUsd: number | null,
): Promise<ActionResult> {
  await requireAdmin();

  // Authoritative check, same as the weekly twin: the dialog runs this for
  // a fast-fail, but a Server Action is reachable without it.
  if (dailyCapUsd !== null) {
    const error = dailyCapOverrideError(dailyCapUsd, ADMIN_DAILY_CAP_USD);
    if (error) return { error };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .update({ daily_cap_override_usd: dailyCapUsd })
    .eq("id", userId)
    .select("id");

  if (error) {
    throw new Error(`Failed to set daily guard for ${userId}: ${error.message}`);
  }

  if ((data ?? []).length === 0) {
    revalidatePath(USERS_PATH);
    return { error: "That account no longer exists." };
  }

  revalidatePath(USERS_PATH);
  // The daily figure shows in the account menu's meter and on /profile.
  revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
}

export async function setHourlyCapOverride(
  userId: string,
  hourlyCapUsd: number | null,
): Promise<ActionResult> {
  await requireAdmin();
  if (hourlyCapUsd !== null && (!Number.isFinite(hourlyCapUsd) || hourlyCapUsd < 0)) {
    return { error: "Hourly cap must be zero or a positive amount." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .update({ hourly_cap_override_usd: hourlyCapUsd })
    .eq("id", userId)
    .select("id");

  if (error) throw new Error(`Failed to set the hourly cap: ${error.message}`);
  if (!data?.length) return { error: "That account could not be found." };

  revalidatePath(USERS_PATH);
  revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
}

/**
 * Sets, or clears, the weekly allowance override on EVERY editor-tier
 * account at once, from /users.
 *
 * What this is NOT, and the UI says so out loud: it does not change the
 * role default. The defaults live in env vars (WEEKLY_CAP_USD,
 * TRUSTED_WEEKLY_CAP_USD) and are read by resolveAccountCaps only when an
 * account has no override. So this writes an override onto each existing
 * editor row, and **an account created afterwards still starts on the env
 * default** until someone runs this again.
 *
 * Making it a true default would mean moving the role caps out of env vars
 * and into a table — resolveAccountCaps becomes an async, DB-backed read
 * with a migration behind it, and lib/spend.ts stops being the synchronous
 * pure module that assertWithinSpendCaps and the sidebar both depend on.
 * That is a real change and not one to make as a side effect of adding a
 * button. Recorded here so the next person knows the ceiling was chosen,
 * not missed.
 *
 * Clearing (null) is genuinely useful, and is the cheap escape hatch from
 * the above: it drops every editor back onto whatever the env vars now say,
 * which is how a real default change gets applied to accounts that already
 * carry an override from a previous bulk set.
 */
/**
 * Not ActionResult: this one reports HOW MANY rows it touched, and
 * ActionResult (lib/action-result.ts) is deliberately `{ error } |
 * undefined` for every other action in the app. Widening a shared type for
 * a single caller costs more than one local union.
 */
export type BulkAllowanceResult = { error: string } | { updated: number };

export async function setAllEditorsWeeklyCap(
  weeklyCapUsd: number | null,
  // Defaults to every editor tier — the behaviour before scopes existed, so
  // an existing caller that never passed one keeps writing to exactly the
  // rows it always did.
  scope: BulkAllowanceScope = "all",
): Promise<BulkAllowanceResult> {
  const { user } = await requireAdmin();

  // A scope arriving from outside the three known values would fall through
  // to `undefined` roles and, with `.in("role", undefined)`, write to EVERY
  // profile including admins. Checked rather than trusted: this is a Server
  // Action, reachable without the dialog that normally constrains it.
  const roles = BULK_ALLOWANCE_SCOPE_ROLES[scope];
  if (!roles) {
    return { error: "Choose which accounts this allowance applies to." };
  }

  if (weeklyCapUsd !== null) {
    const error = weeklyCapOverrideError(weeklyCapUsd, ADMIN_WEEKLY_CAP_USD);
    if (error) return { error };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .update({ weekly_cap_override_usd: weeklyCapUsd })
    // Whichever editor tiers the scope names, never admins — see
    // BULK_ALLOWANCE_SCOPE_ROLES (lib/allowance.ts), where 'admin' appears in
    // no list at all. Named roles rather than `.neq("role", "admin")`
    // because this writes to many rows at once and should say exactly whose
    // allowance it is changing.
    .in("role", roles as ProfileRole[])
    .select("id");

  if (error) {
    throw new Error(`Failed to set the editor weekly allowance: ${error.message}`);
  }

  const updatedIds = (data ?? []).map((row) => row.id);

  // Same ZERO MEANS ZERO rule setWeeklyCapOverride documents, applied to
  // everyone this bulk write just touched — a team-wide zero that leaves
  // live grants standing is the same lie one account at a time, and the
  // admin has even less chance of noticing it across a whole list.
  if (weeklyCapUsd === 0) {
    await revokeActiveGrantsFor(admin, updatedIds, user.id, new Date().toISOString());
    revalidatePath(ALLOWANCES_PATH);
    revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
  }

  revalidatePath(USERS_PATH);
  // Zero is not an error here: a team with no editor-tier accounts is a
  // legitimate state, and reporting the count lets the admin see that the
  // click landed on the number of people they expected.
  return { updated: updatedIds.length };
}

/**
 * Turns the per-user daily burst guard on or off for the whole installation
 * (app_settings.user_daily_cap_enabled, 0077_daily_cap_toggle.sql).
 *
 * This is the "Enable daily cap" button. The feature ships OFF and stays off
 * until an admin asks for it — which is the point: the editors asked not to
 * be stopped mid-job, so a daily ceiling is now something a team opts into
 * when it decides it needs one, not something a deploy imposes.
 *
 * Replaces the USER_DAILY_CAP_ENABLED env var, which could only be changed
 * by editing render.yaml and redeploying. Two sources of truth for one
 * switch is how the deployed answer and the displayed answer end up
 * disagreeing, so the variable is gone rather than kept as a fallback.
 *
 * The only input to whether the guard applies, since 0078 dropped the
 * per-account override that was never given a write path.
 */
export async function setUserDailyCapEnabled(enabled: boolean): Promise<ActionResult> {
  const { user } = await requireAdmin();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("app_settings")
    .update({
      user_daily_cap_enabled: enabled,
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    })
    // The singleton row (0077's boolean primary key). Named explicitly rather
    // than updating unfiltered: an UPDATE with no WHERE is one dropped clause
    // away from rewriting a table, and this one happens to have a single row
    // only by constraint, not by nature.
    .eq("id", true)
    .select("id");

  if (error) {
    throw new Error(`Failed to set the daily cap switch: ${error.message}`);
  }

  // Zero rows means 0077 created the table but its seed INSERT did not run —
  // a half-applied migration, which is a real deploy-order failure rather
  // than a race. Reported instead of thrown because the admin can act on it
  // (apply the migration) and because a 500 here would say nothing about
  // which of the two statements is missing.
  if ((data ?? []).length === 0) {
    return {
      error:
        "The settings row is missing — migration 0077 has not been applied in full to this database.",
    };
  }

  revalidatePath(USERS_PATH);
  // Every account's own menu and render page resolve the guard from this
  // value, so the change has to reach the shared layout, not just /users.
  revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
}

export async function setGlobalSpendCap(
  enabled: boolean,
  capUsd: number,
  period: GlobalSpendCapPeriod,
): Promise<ActionResult> {
  const { user } = await requireAdmin();
  if (!Number.isFinite(capUsd) || capUsd < 0) {
    return { error: "Global cap must be zero or a positive amount." };
  }
  if (period !== "daily" && period !== "weekly") {
    return { error: "Choose a daily or weekly global cap." };
  }

  const { data, error } = await createAdminClient()
    .from("app_settings")
    .update({
      global_spend_cap_enabled: enabled,
      global_spend_cap_usd: capUsd,
      global_spend_cap_period: period,
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    })
    .eq("id", true)
    .select("id");

  if (error) throw new Error(`Failed to update the global spend cap: ${error.message}`);
  if (!data?.length) return { error: "The app settings row is missing. Apply migration 0124." };

  revalidatePath(ACCOUNTS_CONTROL_PATH);
  revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
}

/**
 * setAllEditorsWeeklyCap's daily twin: sets, or clears, the daily burst
 * guard on every account in `scope` at once.
 *
 * Same ceiling caveat as the weekly version, and worth repeating because it
 * is the thing an admin will assume otherwise: this does NOT change the role
 * default. DAILY_CAP_USD and friends are env vars read by resolveAccountCaps
 * only when an account has no override, so this writes a value onto each
 * existing row and an account created afterwards still starts on the env
 * default until someone runs this again.
 *
 * NO grant revocation on zero, unlike the weekly twin. A grant raises the
 * WEEKLY ceiling only (getEffectiveWeeklyCapUsd), so a zero here already
 * stops every render on its own and revoking would remove allowance this
 * action never claimed to touch — the same asymmetry setDailyCapOverride
 * documents for one account.
 *
 * Independent of whether the guard is currently ENABLED. An admin setting
 * daily amounts before turning the feature on is the ordinary order of
 * operations, not an edge case, and a value written while it is off simply
 * starts applying when it is switched on.
 */
export async function setAllEditorsDailyCap(
  dailyCapUsd: number | null,
  scope: BulkAllowanceScope = "all",
): Promise<BulkAllowanceResult> {
  await requireAdmin();

  const roles = BULK_ALLOWANCE_SCOPE_ROLES[scope];
  if (!roles) {
    return { error: "Choose which accounts this daily guard applies to." };
  }

  if (dailyCapUsd !== null) {
    const error = dailyCapOverrideError(dailyCapUsd, ADMIN_DAILY_CAP_USD);
    if (error) return { error };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .update({ daily_cap_override_usd: dailyCapUsd })
    .in("role", roles as ProfileRole[])
    .select("id");

  if (error) {
    throw new Error(`Failed to set the editor daily guard: ${error.message}`);
  }

  revalidatePath(USERS_PATH);
  revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
  return { updated: (data ?? []).length };
}

/**
 * The hourly twin of setAllEditorsDailyCap: sets, or clears (null = no
 * hourly cap), profiles.hourly_cap_override_usd on every account in `scope`.
 * Same validation as setHourlyCapOverride, same never-admins scoping. No
 * grant revocation on zero, for the same reason as the daily twin.
 */
export async function setAllEditorsHourlyCap(
  hourlyCapUsd: number | null,
  scope: BulkAllowanceScope = "all",
): Promise<BulkAllowanceResult> {
  await requireAdmin();

  const roles = BULK_ALLOWANCE_SCOPE_ROLES[scope];
  if (!roles) {
    return { error: "Choose which accounts this hourly cap applies to." };
  }
  if (hourlyCapUsd !== null && (!Number.isFinite(hourlyCapUsd) || hourlyCapUsd < 0)) {
    return { error: "Hourly cap must be zero or a positive amount." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .update({ hourly_cap_override_usd: hourlyCapUsd })
    .in("role", roles as ProfileRole[])
    .select("id");

  if (error) {
    throw new Error(`Failed to set the editor hourly cap: ${error.message}`);
  }

  revalidatePath(USERS_PATH);
  revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
  return { updated: (data ?? []).length };
}
