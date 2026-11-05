// Typed access to the SQL-side aggregates added by
// supabase/migrations/0026_cost_aggregates.sql — project_cost_totals (a
// view) and spend_total_usd / spend_totals_by_user (functions) —
// supabase/migrations/0027_user_project_counts.sql — user_project_counts (a
// view) — and supabase/migrations/0031_account_allowances.sql —
// user_spend_usd (a function; account_spend_windows, the other thing that
// migration adds, is read directly by web/app/(app)/users/page.tsx instead
// of through a helper here, the same way user_directory already is). All
// of these are folded into web/types/db.ts's `Database["public"]`
// (Views / Functions), so this file needs no local schema extension or
// client cast — every function below takes a plain `SupabaseClient<Database>`.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

/**
 * Sums `runs.cost_usd` per project via the `project_cost_totals` view (SQL
 * SUM/GROUP BY) instead of embedding every run app-side — see
 * 0026_cost_aggregates.sql's header for the query this replaces. Scoped to
 * `projectIds` (a single page of the projects list, not the whole table) so
 * the list stays one small, bounded query no matter how many projects or
 * runs exist overall.
 *
 * A project with no runs yet has no row in the view (inner join in the
 * view definition) and is simply absent from the returned Map — callers
 * read a missing key as $0 (`costMap.get(id) ?? 0`), not as an error.
 */
export async function getProjectCostTotals(
  supabase: SupabaseClient<Database>,
  projectIds: readonly string[],
): Promise<Map<string, number>> {
  const costMap = new Map<string, number>();
  if (projectIds.length === 0) {
    return costMap;
  }

  const { data, error } = await supabase
    .from("project_cost_totals")
    .select("project_id, total_cost_usd")
    .in("project_id", projectIds as string[]);

  if (error) {
    throw new Error(`Failed to load project cost totals: ${error.message}`);
  }

  for (const row of data ?? []) {
    costMap.set(row.project_id, row.total_cost_usd);
  }
  return costMap;
}

export interface ProjectSpend {
  /** Every run charged to this project — script compile, image, video alike. */
  totalUsd: number;
  /**
   * Per-scene subtotals; a scene-less run is absent by design (see below).
   * Real billed history, retries included — not a re-derived estimate,
   * which is what makes it the right source for the Deliver page's "already
   * spent on the clip being discarded" label (SceneFixPromptDialog): a
   * scene whose render settings changed after it rendered still shows the
   * dollars actually charged for it, not what re-rendering it would cost
   * today.
   */
  bySceneId: Record<string, number>;
}

/**
 * Every `runs` row charged to ONE project, reduced to a project total and
 * per-scene subtotals in a single query.
 *
 * Filters on `runs.project_id` (0030_runs_project_id.sql), NOT through a
 * `scenes!inner(project_id)` embed, and that distinction is the entire
 * reason this function exists. The Deliver page's "Spend to date" used the
 * scene hop, and `s.id = runs.scene_id` is never true for a run whose
 * scene_id is NULL — so every project-level cost (the Claude script
 * compile, a character reference photo, a product composite) was silently
 * missing from a figure an operator reads as the project's total bill,
 * while still being charged against the account's daily/weekly caps. Same
 * class of bug 0030's header describes closing in five other queries; this
 * one reader just never got converted.
 *
 * bySceneId skips scene-less runs rather than inventing a bucket for them:
 * a full-script compile has no single scene to attribute to. totalUsd is
 * therefore >= the sum of bySceneId, and the difference is exactly the
 * project-level spend.
 *
 * Paged rather than one select, for the same reason actions/reconcile.ts's
 * loadLedgerLines is: PostgREST caps a response at max_rows (1000,
 * supabase/config.toml), and an unbounded select silently returns the first
 * page instead of erroring. That is the exact failure 0026_cost_aggregates
 * .sql's header records — "silent under-report past max_rows = 1000 runs" —
 * and shipping the scene-hop fix on top of an uncapped read would have
 * closed one silent undercount of this figure while leaving a second one
 * behind it. Both figures are affected, not just totalUsd: a truncated page
 * takes whole scenes out of bySceneId, which is what SceneFixPromptDialog
 * labels "already spent on the clip being discarded". Costs nothing in the
 * ordinary case — the loop breaks on the first short page, so a project
 * under 1000 runs is still exactly one round trip.
 */
export async function getProjectSpend(
  supabase: SupabaseClient<Database>,
  projectId: string,
): Promise<ProjectSpend> {
  const PAGE = 1000;
  let totalUsd = 0;
  const bySceneId: Record<string, number> = {};

  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("runs")
      .select("scene_id, cost_usd")
      .eq("project_id", projectId)
      .range(offset, offset + PAGE - 1);

    if (error) {
      throw new Error(`Failed to load spend for project ${projectId}: ${error.message}`);
    }

    const rows = data ?? [];
    for (const run of rows) {
      const costUsd = run.cost_usd ?? 0;
      totalUsd += costUsd;
      if (run.scene_id) {
        bySceneId[run.scene_id] = (bySceneId[run.scene_id] ?? 0) + costUsd;
      }
    }
    if (rows.length < PAGE) break;
  }

  return { totalUsd, bySceneId };
}

/**
 * Total `cost_usd` for runs created in `[fromIso, toIso)`, aggregated in
 * SQL — see spend_total_usd (0026_cost_aggregates.sql) for why this exists
 * instead of reducing an application-side select (that select silently
 * under-reported past PostgREST's `max_rows = 1000`; this has no such cap).
 * Backs /spend's "Today" and "This month" tiles.
 */
export async function getSpendTotalUsd(
  supabase: SupabaseClient<Database>,
  fromIso: string,
  toIso: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("spend_total_usd", {
    from_ts: fromIso,
    to_ts: toIso,
  });

  if (error) {
    throw new Error(`Failed to compute spend total: ${error.message}`);
  }
  return data ?? 0;
}

/**
 * Per-user project counts via the `user_project_counts` view (SQL
 * COUNT/GROUP BY) instead of one `count: "exact", head: true` query per row
 * rendered — see 0027_user_project_counts.sql's header for the query this
 * replaces. Scoped to `userIds` (a single page of the /users list, not the
 * whole table) so the list stays one small, bounded query no matter how many
 * users or projects exist overall.
 *
 * A user with no projects yet has no row in the view (plain GROUP BY over
 * `projects`, no LEFT JOIN from `profiles`) and is simply absent from the
 * returned Map — callers read a missing key as 0 (`countMap.get(id) ?? 0`),
 * not as an error. Same contract as getProjectCostTotals above.
 */
export async function getUserProjectCounts(
  supabase: SupabaseClient<Database>,
  userIds: readonly string[],
): Promise<Map<string, number>> {
  const countMap = new Map<string, number>();
  if (userIds.length === 0) {
    return countMap;
  }

  const { data, error } = await supabase
    .from("user_project_counts")
    .select("user_id, project_count")
    .in("user_id", userIds as string[]);

  if (error) {
    throw new Error(`Failed to load user project counts: ${error.message}`);
  }

  for (const row of data ?? []) {
    countMap.set(row.user_id, row.project_count);
  }
  return countMap;
}

/**
 * Total `cost_usd` for ONE user's runs created in `[fromIso, toIso)`,
 * aggregated in SQL via `user_spend_usd` (0031_account_allowances.sql) —
 * lib/spend.ts's getDailySpend/getWeeklySpend call this instead of fetching
 * that user's runs and reducing in application code. See the migration's
 * header for why spend_total_usd (no per-user filter) and
 * spend_totals_by_user (grouped over a join that predates
 * 0030_runs_project_id.sql's fix and still misses scene-less runs) don't
 * fit this instead.
 */
export async function getUserSpendUsd(
  supabase: SupabaseClient<Database>,
  userId: string,
  fromIso: string,
  toIso: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("user_spend_usd", {
    target_user_id: userId,
    from_ts: fromIso,
    to_ts: toIso,
  });

  if (error) {
    throw new Error(`Failed to compute spend total for user ${userId}: ${error.message}`);
  }
  return data ?? 0;
}

/**
 * Sum of `amount_usd` for one user's unexpired `allowance_grants` as of
 * `atIso`, via `user_active_grants_usd` (0032_allowance_requests.sql) —
 * `user_spend_usd`'s grants twin, same shape and same reasoning (aggregate
 * in SQL, not fetch-and-reduce). Backs lib/spend.ts's getActiveGrantsUsd /
 * getEffectiveWeeklyCapUsd.
 */
export async function getUserActiveGrantsUsd(
  supabase: SupabaseClient<Database>,
  userId: string,
  atIso: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("user_active_grants_usd", {
    target_user_id: userId,
    at_ts: atIso,
  });

  if (error) {
    throw new Error(
      `Failed to compute active allowance grants for user ${userId}: ${error.message}`,
    );
  }
  return data ?? 0;
}

/**
 * One row of getUserActiveGrantsTotals. `count` is every active grant — the
 * figure that funds renders, so a pass belongs in it. `endableCount` is the
 * subset an admin revoke can actually end (approver grants, never half of a
 * pass — see lib/allowance-grants.ts), which is what decides whether /users'
 * End grant button does anything.
 */
export type ActiveGrantTotals = {
  totalUsd: number;
  count: number;
  endableCount: number;
  latestTransferAmountUsd: number | null;
};

/**
 * Per-user unexpired-allowance-grant totals (sum + count), for a whole page
 * of user ids at once, via `user_active_grants_usd_by_user`
 * (0033_allowance_requests_rls_fix.sql) — getUserActiveGrantsUsd's batched
 * twin, same relationship getUserProjectCounts has to a hypothetical
 * per-user project-count call. web/app/(app)/users/page.tsx uses this
 * instead of fetching `allowance_grants` rows and reducing them in
 * application code — see that migration's header for the max_rows = 1000
 * under-reporting bug that fetch-and-reduce reproduced.
 *
 * Same missing-key contract as getProjectCostTotals/getUserProjectCounts: a
 * user with no active grants has no row in the SQL result and is simply
 * absent from the returned Map, not an error.
 */
export async function getUserActiveGrantsTotals(
  supabase: SupabaseClient<Database>,
  userIds: readonly string[],
  atIso: string,
): Promise<Map<string, ActiveGrantTotals>> {
  const totalsByUserId = new Map<string, ActiveGrantTotals>();
  if (userIds.length === 0) {
    return totalsByUserId;
  }

  const { data, error } = await supabase.rpc("user_active_grants_usd_by_user", {
    target_user_ids: userIds as string[],
    at_ts: atIso,
  });

  if (error) {
    throw new Error(`Failed to load active allowance grant totals: ${error.message}`);
  }

  for (const row of data ?? []) {
    totalsByUserId.set(row.user_id, {
      totalUsd: row.total_usd,
      count: row.grant_count,
      endableCount: row.approver_grant_count,
      latestTransferAmountUsd: row.latest_transfer_amount_usd ?? null,
    });
  }
  return totalsByUserId;
}

/**
 * The sum, across every non-admin account, of what could still be spent
 * this Manila calendar week if each one used its full effective weekly
 * allowance — via `outstanding_allowance_usd` (0035_outstanding_allowance.sql),
 * one bounded SQL aggregate, not a fetch of every profile row reduced in
 * application code (see that migration's header for why: the same
 * max_rows = 1000 risk 0026_cost_aggregates.sql's header describes, this
 * time across every account in the system instead of one date range).
 *
 * `editorWeeklyDefaultUsd`/`trustedWeeklyDefaultUsd` are lib/spend.ts's
 * WEEKLY_CAP_USD/TRUSTED_WEEKLY_CAP_USD — passed in because the SQL side has
 * no access to the render.yaml env vars those constants are parsed from.
 * Backs /allowances' summary tiles and the approve dialog.
 */
export async function getOutstandingAllowanceUsd(
  supabase: SupabaseClient<Database>,
  editorWeeklyDefaultUsd: number,
  trustedWeeklyDefaultUsd: number,
): Promise<number> {
  const { data, error } = await supabase.rpc("outstanding_allowance_usd", {
    editor_weekly_default: editorWeeklyDefaultUsd,
    trusted_weekly_default: trustedWeeklyDefaultUsd,
  });

  if (error) {
    throw new Error(`Failed to compute outstanding allowance: ${error.message}`);
  }
  return data ?? 0;
}

/** spend_category_totals / spend_category_totals_by_user's shared shape — see 0037_spend_category_totals.sql for the category rule and why total_usd = iterateUsd + renderUsd is guaranteed, not merely usually true. */
export interface SpendCategoryTotals {
  iterateUsd: number;
  renderUsd: number;
  totalUsd: number;
}

/**
 * Team-wide iterate-vs-render split for runs created in `[fromIso, toIso)`,
 * via `spend_category_totals` (0037_spend_category_totals.sql) — one
 * bounded aggregate query, not a fetch-and-reduce over `runs`. Backs
 * /spend's breakdown tile.
 *
 * `returns table(...)` with no `GROUP BY` always yields exactly one row
 * (an aggregate over zero matching runs still returns one row of zeros via
 * `coalesce`, never an empty set) — this unwraps that single-element array
 * into a plain object so callers don't have to know that PostgREST
 * represents every `returns table` function as an array. A genuinely empty
 * array (which SQL cannot actually produce here, but which a caller should
 * never trust blindly) falls back to all-zero rather than throwing, so a
 * transport-layer surprise degrades to "nothing to show" instead of a
 * crashed page — the same fail-soft posture db-aggregates.ts's other Map-
 * returning functions already have for a missing row.
 */
export async function getSpendCategoryTotals(
  supabase: SupabaseClient<Database>,
  fromIso: string,
  toIso: string,
): Promise<SpendCategoryTotals> {
  const { data, error } = await supabase.rpc("spend_category_totals", {
    from_ts: fromIso,
    to_ts: toIso,
  });

  if (error) {
    throw new Error(`Failed to compute spend category totals: ${error.message}`);
  }

  const row = (data ?? [])[0];
  return {
    iterateUsd: row?.iterate_usd ?? 0,
    renderUsd: row?.render_usd ?? 0,
    totalUsd: row?.total_usd ?? 0,
  };
}

export interface UserSpendCategoryTotal extends SpendCategoryTotals {
  userId: string;
  email: string;
}

/**
 * Per-user iterate-vs-render split for runs created in `[fromIso, toIso)`,
 * via `spend_category_totals_by_user` (0037_spend_category_totals.sql) —
 * the function /spend's Per-user totals table reads instead of
 * getSpendTotalsByUser going forward, since this one joins runs -> projects
 * directly (matching user_spend_usd/RLS) rather than through scenes, which
 * drops scene-less runs (compiles, reference frames — see that migration's
 * header). `email` falls back to `userId` for the same LEFT JOIN edge case
 * getSpendTotalsByUser already handles.
 */
export async function getSpendCategoryTotalsByUser(
  supabase: SupabaseClient<Database>,
  fromIso: string,
  toIso: string,
): Promise<UserSpendCategoryTotal[]> {
  const { data, error } = await supabase.rpc("spend_category_totals_by_user", {
    from_ts: fromIso,
    to_ts: toIso,
  });

  if (error) {
    throw new Error(`Failed to compute per-user spend category totals: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    userId: row.user_id,
    email: row.email ?? row.user_id,
    iterateUsd: row.iterate_usd,
    renderUsd: row.render_usd,
    totalUsd: row.total_usd,
  }));
}

export interface UserSpendTotal {
  userId: string;
  email: string;
  totalUsd: number;
}

/**
 * Per-user `cost_usd` totals for runs created in `[fromIso, toIso)`,
 * grouped in SQL — see spend_totals_by_user (0026_cost_aggregates.sql).
 * `email` falls back to `userId` the same way spend/page.tsx's old
 * in-memory reduce did, for the edge case of a profile row that no longer
 * exists (the join is a LEFT JOIN on the SQL side for exactly this reason).
 */
/** sidebar_budget_snapshot's row shape (0044_sidebar_budget_snapshot.sql) — see getSidebarBudgetSnapshot below. */
export interface SidebarBudgetSnapshotRow {
  dailySpentUsd: number;
  weeklySpentUsd: number;
  globalSpentTodayUsd: number;
  activeGrantsUsd: number;
  grantCount: number;
  grantEarliestExpiresAt: string | null;
  pendingRequestId: string | null;
  pendingRequestUsd: number | null;
}

/**
 * The sidebar footer's whole read, in ONE round trip, via
 * `sidebar_budget_snapshot` (0044_sidebar_budget_snapshot.sql) — replaces
 * the six concurrent reads lib/sidebar-budget.ts's getSidebarBudget used to
 * fire (getAccountBudgetSnapshot's five, plus a sixth for the pending
 * allowance_requests row) with a single RPC. See that migration's header
 * for the measured Supabase concurrency ceiling this exists to dodge, and
 * for why the function CALLS user_spend_usd/spend_total_usd/
 * user_active_grants_usd rather than reimplementing them — the same
 * functions assertWithinSpendCaps enforces against, so this can never
 * drift from enforcement.
 *
 * `dayStartIso`/`weekStartIso`/`nowIso` are lib/spend.ts's
 * startOfManilaDayIso/startOfManilaWeekIso/`new Date().toISOString()` —
 * timezone boundaries stay computed in TypeScript, exactly like
 * getUserSpendUsd/getSpendTotalUsd above already take fromIso/toIso rather
 * than computing "today" themselves.
 *
 * `returns table(...)` with no `GROUP BY` always yields exactly one row —
 * same unwrap-the-single-element-array shape as getSpendCategoryTotals
 * above, not a second thing to learn.
 */
export async function getSidebarBudgetSnapshot(
  supabase: SupabaseClient<Database>,
  userId: string,
  dayStartIso: string,
  weekStartIso: string,
  nowIso: string,
): Promise<SidebarBudgetSnapshotRow> {
  const { data, error } = await supabase.rpc("sidebar_budget_snapshot", {
    target_user_id: userId,
    day_start_ts: dayStartIso,
    week_start_ts: weekStartIso,
    now_ts: nowIso,
  });

  if (error) {
    throw new Error(`Failed to load sidebar budget snapshot for user ${userId}: ${error.message}`);
  }

  const row = (data ?? [])[0];
  return {
    dailySpentUsd: row?.daily_spent_usd ?? 0,
    weeklySpentUsd: row?.weekly_spent_usd ?? 0,
    globalSpentTodayUsd: row?.global_spent_today_usd ?? 0,
    activeGrantsUsd: row?.active_grants_usd ?? 0,
    grantCount: row?.grant_count ?? 0,
    grantEarliestExpiresAt: row?.grant_earliest_expires_at ?? null,
    pendingRequestId: row?.pending_request_id ?? null,
    pendingRequestUsd: row?.pending_request_usd ?? null,
  };
}

export async function getSpendTotalsByUser(
  supabase: SupabaseClient<Database>,
  fromIso: string,
  toIso: string,
): Promise<UserSpendTotal[]> {
  const { data, error } = await supabase.rpc("spend_totals_by_user", {
    from_ts: fromIso,
    to_ts: toIso,
  });

  if (error) {
    throw new Error(`Failed to compute per-user spend totals: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    userId: row.user_id,
    email: row.email ?? row.user_id,
    totalUsd: row.total_usd,
  }));
}
