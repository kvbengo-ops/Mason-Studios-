// Fail-soft wrapper around lib/spend.ts for the sidebar footer
// (app/(app)/layout.tsx). Exists ONLY because of where the caller lives:
// layout.tsx wraps every page in the app, including the sign-out button, so
// anything it does unconditionally becomes a single point of failure for the
// entire product. lib/spend.ts is not safe to use unconditionally there —
// two of its own documented behaviors are direct threats to a root layout:
//
//   - parseCapEnvUsd (lib/spend.ts) THROWS AT MODULE LOAD if a *_CAP_USD env
//     var is malformed. That throw is deliberate and, today, safely scoped:
//     lib/spend.ts is only imported by actions/enqueue.ts and the render
//     page, so a bad env var takes down rendering, not the app. A `import
//     { ... } from "@/lib/spend"` at the top of this file (or of layout.tsx)
//     would pull that same throw into the root layout's module graph —
//     evaluated once per server instance the first time ANY page is hit —
//     and a render.yaml typo would 500 every route behind AppLayout.
//   - getGlobalDailySpend/getWeeklySpend (lib/spend.ts, via
//     getSpendTotalUsd/getUserSpendUsd in lib/db-aggregates.ts) THROW on a
//     failed RPC — correct for a render-time gate that must refuse to
//     enqueue rather than silently under-count spend, but the sidebar is
//     not a gate. A transient Postgres hiccup must not blank the shell out
//     from under someone who is just trying to look at a project.
//
// The fix for both is the same shape: defer lib/spend.ts's evaluation to
// call time with a dynamic import() (a static `import` at the top of this
// file would defeat the point — it evaluates, and can throw, at module-load
// same as before) and wrap the whole read in one try/catch. `import()`
// returns a promise that REJECTS on a top-level throw during evaluation
// instead of throwing synchronously through the import graph, so a
// malformed cap becomes an ordinary catchable rejection here — same
// treatment as the DB call failing. Callers get `null` on ANY failure
// (bad env var or bad DB read, deliberately not distinguished — the sidebar
// has no actionable difference to offer for either) and render a plain "—"
// instead of a number. A blank figure is a fine failure for a glanceable
// status readout; an unhandled exception in a Server Component that wraps
// every route is not.
import { createAdminClient, createClient } from "@/lib/supabase/server";
import type { TransferRecipient } from "@/components/pass-credits-dialog";
import type { ProfileRole } from "@/types/db";
import { getSidebarBudgetSnapshot } from "@/lib/db-aggregates";
import { getKieAccountBalanceUsd } from "@/lib/kie-balance";
import type { AccountCapProfile, AllowanceDialogState } from "@/lib/spend";
import { decisionBlockReason } from "@/lib/allowance";

// getSidebarBudgetSnapshot (lib/db-aggregates.ts) is imported statically,
// unlike lib/spend.ts below — it has no module-load side effect that can
// throw (no parseCapEnvUsd-style env parsing, just a typed `.rpc(...)`
// wrapper), so there is no synchronous-throw-through-the-import-graph risk
// for a static import to create. See this file's header for why lib/spend.ts
// itself does NOT get this treatment.

// Overspend-pressure classification (warning/critical at 70%/90% of a
// line's cap consumed, for the sidebar's daily/weekly/team lines) is
// deliberately NOT derived in this file, despite the name — see
// lib/budget-tier.ts's `budgetPressure` and its header comment for why: this
// file has a static, runtime `import { createAdminClient } from
// "@/lib/supabase/server"` above, which pulls in `next/headers` and is only
// safe from a Server Component. The sidebar's presentation components
// (components/sidebar-budget.tsx, components/account-menu.tsx) render on
// the client and need the pure derivation without that import chain
// attached, so it lives in lib/budget-tier.ts instead — the module already
// built with zero imports for exactly this reason.

export interface SidebarBudget {
  /** The authenticated caller, carried to the pass dialog; the action rechecks identity. */
  userId: string;
  /** The caller's raw role, used to show passing only for editor tiers. */
  role: ProfileRole;
  /** Session-scoped transfer_recipients, fetched on the server. null means unavailable. */
  transferRecipients: TransferRecipient[] | null;
  /** Active approver grants — getActiveGrantsSummary.grantedInUsd, as on AccountBudgetSnapshot. */
  grantedInUsd: number;
  /** Active incoming peer passes — getActiveGrantsSummary.receivedUsd, in USD. */
  receivedUsd: number;
  /** Active outgoing peer passes — getActiveGrantsSummary.passedOutUsd, reported positive. */
  passedOutUsd: number;
  /** Whether the per-user daily burst guard is enforced and should be displayed. */
  dailyCapEnabled?: boolean;
  /** resolveAccountCaps(profile).dailyCapUsd minus today's spend. Can be negative. */
  remainingUsd: number;
  /** resolveAccountCaps(profile).dailyCapUsd — the daily burst guard remainingUsd is measured against. */
  capUsd: number;
  /** Today's spend — lib/spend.ts's AccountBudgetSnapshot.dailyUsedUsd, threaded through so the avatar menu can show the arithmetic (Part 2 of the task that added this field), not just the answer. */
  dailyUsedUsd: number;
  /** getEffectiveWeeklyCapUsd(profile) (role/override weekly cap PLUS active allowance_grants) minus this week's spend. Can be negative. */
  remainingWeeklyUsd: number;
  /** getEffectiveWeeklyCapUsd(profile) — the account's real periodic allowance, grants included (see lib/spend.ts). */
  weeklyCapUsd: number;
  /** This week's spend — AccountBudgetSnapshot.weeklyUsedUsd. */
  weeklyUsedUsd: number;
  /** The plain role/override weekly figure BEFORE grants — AccountBudgetSnapshot.weeklyBaseCapUsd. weeklyCapUsd above is this plus weeklyGrantUsd. */
  weeklyBaseCapUsd: number;
  /** Active grants folded into weeklyCapUsd, as a dollar figure — AccountBudgetSnapshot.weeklyGrantUsd. 0 means no active grant. */
  weeklyGrantUsd: number;
  /** This account's queued/rendering estimate — AccountBudgetSnapshot.heldUsd, already subtracted from both remaining figures above. */
  heldUsd: number;
  /** How many unexpired grants make up weeklyGrantUsd — AccountBudgetSnapshot.weeklyGrantCount. */
  weeklyGrantCount: number;
  /** The soonest expires_at among unexpired grants, or null — AccountBudgetSnapshot.weeklyGrantEarliestExpiresAt. */
  weeklyGrantEarliestExpiresAt: string | null;
  hourlyRemainingUsd: number | null;
  hourlyCapUsd: number | null;
  hourlyUsedUsd: number;
  /**
   * True when the kie account holds less money than `remainingUsd` claims is
   * still available today — i.e. this sidebar's own headline number is a
   * promise the account cannot keep.
   *
   * The two figures answer different questions and nothing used to compare
   * them: an allowance is a ceiling on what we will LET someone spend, the
   * balance is what there is to spend. Observed live at $1.56 in the account
   * against a sidebar reading "$3.06 left" — the smaller, real number was
   * the one nobody could see, and the editor's first hint was a render
   * refused after they had already built the frames.
   *
   * `false` when the balance cannot be read. Unknown must not alarm, for the
   * same reason lib/spend.ts skips the balance check rather than blocking on
   * it: a billing-API hiccup is not evidence of an empty account.
   */
  accountUnderfunded: boolean;
  /**
   * The real account balance — populated for admins ONLY, exactly like
   * globalRemainingUsd/globalCapUsd below. Editors get `accountUnderfunded`
   * instead: they need to know their allowance overstates what they can
   * spend, which the boolean says, and putting the company's balance in
   * front of twenty people on every page render says more than that.
   */
  accountFundsUsd: number | null;
  /** Global window headroom; Infinity when the global cap is disabled. */
  globalRemainingUsd: number | null;
  /** Global cap amount and window, only populated for admins when enabled. */
  globalCapUsd: number | null;
  globalCapEnabled: boolean;
  globalCapPeriod: "daily" | "weekly";
  /**
   * Which of lib/spend.ts's allowanceDialogState() outcomes the "Request
   * more" dialog should show. The dialog itself is now rendered
   * unconditionally (components/sidebar-budget.tsx) whenever there is no
   * pending request — this field only decides which of its honest
   * explanations to display, never whether the control exists. Replaces
   * the old `canRequestMore: boolean`, which the control's visibility used
   * to be gated on — that was the bug (see this file's own header and
   * components/sidebar-budget.tsx's).
   */
  requestDialogState: AllowanceDialogState;
  /** True when this account already has a pending allowance_requests row (0032_allowance_requests.sql) — the sidebar shows its status (with a cancel control) instead of a new "Request more" link when this is true. */
  pendingRequestUsd: number | null;
  /** The pending request's own id, so the sidebar's cancel control (CancelAllowanceRequestDialog) has something to call cancelAllowanceRequest with. null exactly when pendingRequestUsd is null. */
  pendingRequestId: string | null;
}

/**
 * Reads the signed-in account's remaining daily-burst and weekly-allowance
 * budget (and, for admins, the team-wide remaining figure) for display in
 * the sidebar footer. Returns `null` on any failure — malformed cap env
 * var, failed Postgres read, or anything else lib/spend.ts might throw —
 * never lets the error escape to the caller. See the file header for why
 * that's the right trade here.
 *
 * Takes the whole `profile` (role plus any per-account override), not just
 * `role`, so an admin-set override actually shows up here — the same
 * reason every other lib/spend.ts caller moved from `profile.role` to
 * `profile` when 0031_account_allowances.sql added per-account allowances.
 */
export async function getSidebarBudget(
  userId: string,
  profile: AccountCapProfile,
): Promise<SidebarBudget | null> {
  try {
    // Dynamic import, not a static one — see file header. This is what
    // turns lib/spend.ts's module-load throw into a rejected promise this
    // try/catch can actually catch, instead of an exception that propagates
    // synchronously through AppLayout before this function's body even runs.
    const spend = await import("@/lib/spend");

    // Admin client, not the caller's own session client: allowance_requests
    // has no RLS policy granting a plain select filtered only by user_id —
    // its select policy is `user_id = auth.uid() or is_admin()`, which a
    // session client already satisfies for the caller's own rows, but this
    // sidebar's fail-soft contract (this file's whole header) means every
    // read here should behave uniformly regardless of which client would
    // technically work, the same reasoning getDailySpend/getWeeklySpend use.
    const admin = createAdminClient();

    // Core totals remain one round trip — see 0044_sidebar_budget_snapshot.sql's
    // header for the measured Supabase concurrency ceiling (six concurrent
    // reads costs ~172ms; this is one). day/week boundaries are computed
    // here in TypeScript exactly like spend.getAccountBudgetSnapshot's own
    // getDailySpend/getWeeklySpend do, and passed to the RPC as parameters
    // — the SQL side computes no time boundary of its own. All three of
    // "now" (day window's end, week window's end, and the grants/pending-
    // request cutoff) are this ONE instant, unlike the old six-read version
    // which took a separate `new Date()` per call.
    const nowIso = new Date().toISOString();
    // The snapshot RPC retains the signed total. Reuse spend's existing
    // detail reader for the display split; no new grant predicate or SQL.
    // Recipients are session-scoped, and a failed directory read must not
    // hide the budget or the pass trigger.
    const [row, grants, transferRecipients, globalSpend, hourlySpentUsd, inFlight] = await Promise.all([
      getSidebarBudgetSnapshot(
        admin,
        userId,
        spend.startOfManilaDayIso(),
        spend.startOfManilaWeekIso(),
        nowIso,
      ),
      spend.getActiveGrantsSummary(userId, nowIso),
      (async (): Promise<TransferRecipient[] | null> => {
        if (profile.role !== "editor" && profile.role !== "trusted_editor") return [];
        try {
          const session = await createClient();
          const { data, error } = await session.rpc("transfer_recipients");
          if (error) throw error;
          return data ?? [];
        } catch (error) {
          console.error("Failed to load pass recipients", error);
          return null;
        }
      })(),
      spend.getGlobalSpendSnapshot(),
      profile.hourly_cap_override_usd == null ? Promise.resolve(0) : spend.getHourlySpend(userId),
      spend.getInFlightSpendSafe(),
    ]);

    // The same derivation spend.getAccountBudgetSnapshot performs over its
    // five separate reads (see that function for render/page.tsx and
    // profile/page.tsx's callers) — just over this function's single row.
    const caps = spend.resolveAccountCaps(profile);
    // The installation setting (app_settings, 0077), which since 0078 is the
    // only input to whether the daily guard applies. Rides alongside the
    // snapshot RPC this function already awaits.
    const dailyCapEnabled = await spend.getUserDailyCapEnabled();
    const heldUsd = inFlight.byUserUsd.get(userId) ?? 0;
    const effectiveWeeklyCapUsd = caps.weeklyCapUsd + row.activeGrantsUsd;
    const dailyRemainingUsd = caps.dailyCapUsd - row.dailySpentUsd - heldUsd;
    const weeklyRemainingUsd = effectiveWeeklyCapUsd - row.weeklySpentUsd - heldUsd;
    const globalRemainingUsd = globalSpend.settings.enabled
      ? globalSpend.settings.capUsd - globalSpend.spentUsd - inFlight.globalUsd
      : Number.POSITIVE_INFINITY;
    const hourlyCapUsd = profile.hourly_cap_override_usd ?? null;
    const hourlyRemainingUsd =
      hourlyCapUsd === null ? null : hourlyCapUsd - hourlySpentUsd - heldUsd;

    // requestDialogState is computed for every role, not just when the
    // sidebar's own team BudgetLine displays (admins only) — the "Request
    // more" dialog needs the real team-wide headroom regardless of who's
    // looking at it, same reasoning the old canRequestMore/grantWouldUnblock
    // call here used to follow (a grant never touches the global cap, so an
    // account blocked by it needs the honest "won't help" message too, not
    // just admins).
    // Cached for 60s in lib/kie-balance.ts and already read on every render
    // gate load, so this adds no new call in practice — that cache exists
    // precisely because this sidebar loads constantly. Returns null (never
    // throws) when kie's billing API is unreachable.
    const accountFundsUsd = await getKieAccountBalanceUsd();

    const requestDialogState = spend.allowanceDialogState({
      globalRemainingUsd,
      weeklyRemainingUsd,
      dailyRemainingUsd,
      hourlyRemainingUsd,
      dailyCapEnabled,
      globalCapPeriod: globalSpend.settings.period,
    });

    return {
      userId,
      role: profile.role,
      transferRecipients,
      grantedInUsd: grants.grantedInUsd,
      receivedUsd: grants.receivedUsd,
      passedOutUsd: grants.passedOutUsd,
      dailyCapEnabled,
      remainingUsd: dailyRemainingUsd,
      capUsd: caps.dailyCapUsd,
      dailyUsedUsd: row.dailySpentUsd,
      remainingWeeklyUsd: weeklyRemainingUsd,
      weeklyCapUsd: effectiveWeeklyCapUsd,
      weeklyUsedUsd: row.weeklySpentUsd,
      weeklyBaseCapUsd: caps.weeklyCapUsd,
      weeklyGrantUsd: row.activeGrantsUsd,
      heldUsd,
      weeklyGrantCount: row.grantCount,
      weeklyGrantEarliestExpiresAt: row.grantEarliestExpiresAt,
      hourlyRemainingUsd,
      hourlyCapUsd,
      hourlyUsedUsd: hourlySpentUsd,
      // Compared against the figure that will BIND first for this account —
      // daily when that guard is on, weekly when it isn't.
      //
      // Which is the same rule the warning's own text states: "renders may be
      // refused before this allowance runs out". The allowance it means is
      // the one about to stop them, so the comparison follows the enforced
      // ceiling rather than naming a fixed window. Under the flag it is
      // always daily, because resolveAccountCaps clamps daily to weekly; with
      // the flag off daily is not enforced at all and weekly is the only
      // per-user ceiling there is.
      //
      // The old worry — that weekly warns too readily, since nobody spends a
      // week in one click — is the wrong way round. The case it fires on is
      // an account whose ALLOWANCE outruns the vendor balance, which is
      // exactly the "$200 authorised vs. $31 funded" gap /allowances' own
      // admin tile exists to surface. A grant is what usually opens it, and
      // an editor holding one they cannot actually spend is worth a line of
      // warning text.
      accountUnderfunded:
        accountFundsUsd !== null &&
        accountFundsUsd < (dailyCapEnabled ? dailyRemainingUsd : weeklyRemainingUsd),
      accountFundsUsd: profile.role === "admin" ? accountFundsUsd : null,
      // Team figure DISPLAYED only for admins, per components/sidebar-
      // budget.tsx — but computed above for everyone, since
      // requestDialogState needs it regardless of role (see this block's
      // own comment).
      globalRemainingUsd: profile.role === "admin" ? globalRemainingUsd : null,
      globalCapUsd:
        profile.role === "admin" && globalSpend.settings.enabled
          ? globalSpend.settings.capUsd
          : null,
      globalCapEnabled: globalSpend.settings.enabled,
      globalCapPeriod: globalSpend.settings.period,
      requestDialogState,
      pendingRequestUsd: row.pendingRequestUsd,
      pendingRequestId: row.pendingRequestId,
    };
  } catch (error) {
    // Logged, not surfaced: the sidebar has no UI for "here's what broke"
    // and shouldn't grow one for a glance-only figure. Server logs are
    // where a malformed cap or a failing RPC actually gets fixed.
    console.error("Failed to load sidebar budget", error);
    return null;
  }
}

/**
 * How many pending allowance requests this approver may actually decide,
 * for the nav badge (components/nav-links.tsx). `null` on any failure, and
 * `0` renders no badge — same fail-soft contract as getSidebarBudget above,
 * and for the same reason: a broken count must never take the sidebar down.
 *
 * "May actually decide" is the whole point, and it is NOT `count(*) where
 * status = 'pending'`. Nobody decides their own request (D3), and a peer
 * cannot decide one above their ceiling (D4) — a badge promising three
 * decisions when two of them render as "Over your approval limit" is worse
 * than no badge, because the operator clicks through and finds nothing to
 * do.
 *
 * So the rows are fetched and filtered through decisionBlockReason, the
 * same pure function /allowances renders each row with. That predicate has
 * exactly one home (lib/allowance.ts) and this does not add a second one in
 * SQL — CX-1's "do not reimplement the predicate" rule applies here too.
 *
 * Fetching rather than counting is affordable precisely because of
 * allowance_requests_one_pending_per_user (0032): at most one pending row
 * per account exists, so this is bounded by the size of the team, not by
 * the table's history. Three columns, no joins.
 */
export async function getDecidableRequestCount(
  userId: string,
  profile: AccountCapProfile,
): Promise<number | null> {
  try {
    // Dynamic import for the same reason getSidebarBudget uses one: a
    // malformed cap env var throws at lib/spend.ts's module load, and only
    // an awaited import turns that into something this try/catch catches.
    const spend = await import("@/lib/spend");

    const admin = createAdminClient();
    const { data, error } = await admin
      .from("allowance_requests")
      .select("user_id, requested_usd")
      .eq("status", "pending");

    if (error) return null;

    // An admin gets a null ceiling and decisionBlockReason returns before
    // ever reading it. A peer gets the real cap; if it could not be
    // resolved the import above would have thrown, so this is never a
    // silent zero-ceiling that blocks everything.
    const peerMaxGrantUsd = profile.role === "admin" ? null : spend.TRUSTED_WEEKLY_CAP_USD;

    return (data ?? []).filter(
      (row) =>
        decisionBlockReason({
          approverRole: profile.role,
          approverId: userId,
          requesterId: row.user_id,
          requestedUsd: row.requested_usd,
          peerMaxGrantUsd,
        }) === null,
    ).length;
  } catch {
    return null;
  }
}
