-- =============================================================================
-- Collapse the sidebar's six concurrent Supabase reads into one round trip.
--
-- Measured on production, not guessed: budget_ms (the sidebar's read) sits
-- at 169ms p50 -- ~67% of every authenticated page render. That number is
-- NOT query cost, distance, cold starts, or TLS. It is a hard concurrency
-- ceiling at Supabase:
--
--   1 concurrent request  =  76ms
--   2                     =  92ms
--   3                     = 117ms
--   4                     = 131ms
--   6                     = 172ms
--   8                     = 206ms
--   12                    = 282ms
--   16                    = 375ms
--
-- roughly 76ms base + ~19ms per additional concurrent request. Promise.all
-- cannot create concurrency the other end will not serve -- firing more
-- reads in parallel is what COSTS the time, not what buys it back.
--
-- web/lib/sidebar-budget.ts's getSidebarBudget fires SIX reads to render one
-- footer: getAccountBudgetSnapshot's own five (getDailySpend,
-- getEffectiveWeeklyCapUsd -> getActiveGrantsUsd, getWeeklySpend,
-- getGlobalDailySpend, getActiveGrantsSummary) plus a sixth for the pending
-- allowance_requests row getAccountBudgetSnapshot deliberately doesn't know
-- about. Six concurrent reads sits at ~172ms on the measured curve above --
-- the observed 169ms is why this diagnosis is trusted, not guessed at.
--
-- This function is the fix: ONE Postgres function, called through ONE
-- PostgREST round trip, that returns everything the sidebar needs in a
-- single row.
--
-- ---------------------------------------------------------------------------
-- Why this CALLS the existing functions instead of reimplementing their SQL
-- ---------------------------------------------------------------------------
-- user_spend_usd, spend_total_usd and user_active_grants_usd
-- (0031_account_allowances.sql / 0032_allowance_requests.sql, both since
-- redefined by 0040_include_archived_cost_in_spend_reads.sql to also union
-- in archived cost history) are exactly the reads
-- assertWithinSpendCaps -- the ENFORCEMENT path -- calls. This function
-- below calls those same three functions rather than copying their
-- `sum(cost_usd)` bodies or their archived-history UNION ALL branches, for
-- one reason that matters more than the round trip this migration is
-- otherwise about: it is the only way the number the sidebar SHOWS and the
-- number enforcement CHECKS are guaranteed to never drift apart. If this
-- function inlined its own copy of that SQL, a future edit to 0040's
-- archive union (or any later redefinition of user_spend_usd/
-- spend_total_usd/user_active_grants_usd) would have to remember to touch
-- two places to stay correct, and the day it doesn't, the sidebar quietly
-- starts lying -- either showing headroom that enforcement has already
-- closed, or blocking a request enforcement would actually allow. Calling
-- the same functions makes that class of bug structurally impossible: there
-- is only one definition of "how much has this account spent" to get wrong.
--
-- ActiveGrantsSummary.totalUsd (web/lib/spend.ts) carries a doc comment
-- warning it is NOT necessarily the same read as user_active_grants_usd's
-- RPC-computed sum, because getAccountBudgetSnapshot fetches the grants
-- detail (count, earliest expiry) via a separate plain `select` over
-- allowance_grants rather than deriving the dollar figure from it. This
-- function collapses that into ONE read: grant_count and
-- grant_earliest_expires_at below are computed from the SAME
-- `allowance_grants` scan `user_active_grants_usd` itself would perform (a
-- consistent view within one query, unlike two separate round trips that
-- could straddle a grant expiring or an admin approving one in between) --
-- see web/lib/spend.ts for whether that footgun warning still applies to
-- this call site specifically.
--
-- ---------------------------------------------------------------------------
-- Why the time boundaries and caps are still parameters, not SQL
-- ---------------------------------------------------------------------------
-- Asia/Manila day/week boundaries (Monday reset) stay computed in
-- TypeScript (web/lib/spend.ts's startOfManilaDayIso/startOfManilaWeekIso)
-- and are PASSED IN here, exactly like user_spend_usd/spend_total_usd
-- already take from_ts/to_ts rather than computing "today" themselves --
-- that logic lives in exactly one place, and this function does not
-- duplicate it. Caps (DAILY_CAP_USD, WEEKLY_CAP_USD, TRUSTED_*, ADMIN_*,
-- GLOBAL_DAILY_CAP_USD) are ENV, resolved in TypeScript by
-- resolveAccountCaps -- this function returns raw SPENT figures only, never
-- a remaining/cap number, so there is nothing here for a cap to leak into.
--
-- ---------------------------------------------------------------------------
-- Signature
-- ---------------------------------------------------------------------------
-- day_start_ts/now_ts double as the window for BOTH daily_spent_usd (per
-- user) and global_spent_today_usd (team-wide) -- the TS side already
-- computes one "start of today" and one "now" for both of getDailySpend and
-- getGlobalDailySpend, so there is no reason for this function to take four
-- timestamps where two cover it. week_start_ts is the separate Monday
-- boundary getWeeklySpend uses. All three of "now" are the SAME instant on
-- the TS side (one `new Date().toISOString()` call, not three separate
-- ones like the old six-read version made) -- this function inherits that,
-- it does not itself call now().
--
-- security invoker, stable, `set search_path = public`: same posture as
-- every function it calls (user_spend_usd, spend_total_usd,
-- user_active_grants_usd are all `security invoker`) and as this file's own
-- direct reads of allowance_grants/allowance_requests, which rely on the
-- caller's RLS same as web/lib/sidebar-budget.ts's admin client already
-- does today for both of those tables (allowance_grants_select/
-- allowance_requests_select both allow `user_id = auth.uid() or is_admin()`
-- -- the admin client's service-role BYPASSRLS satisfies that regardless).
-- No `security definer` needed: nothing here writes, and nothing here needs
-- to see across accounts the caller couldn't already see on its own via the
-- functions/tables it touches.
create or replace function sidebar_budget_snapshot(
  target_user_id uuid,
  day_start_ts timestamptz,
  week_start_ts timestamptz,
  now_ts timestamptz
)
returns table (
  daily_spent_usd numeric,
  weekly_spent_usd numeric,
  global_spent_today_usd numeric,
  active_grants_usd numeric,
  grant_count integer,
  grant_earliest_expires_at timestamptz,
  pending_request_id uuid,
  pending_request_usd numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  -- No FROM clause needed for the four scalar function calls -- a bare
  -- SELECT of scalar expressions always yields exactly one row, the same
  -- "returns table with no GROUP BY always yields exactly one row" shape
  -- web/lib/db-aggregates.ts's getSpendCategoryTotals already documents for
  -- spend_category_totals. The two allowance_grants aggregates and the
  -- allowance_requests lookup are correlated subqueries in the SELECT list
  -- for the same reason: each is independent of the others, and a bare
  -- scalar subquery is the smallest way to fold "no matching row" into a
  -- NULL (grant_earliest_expires_at, pending_request_id/usd) without an
  -- extra JOIN or a second round trip of its own.
  select
    -- Same three functions assertWithinSpendCaps enforces against -- see
    -- this migration's header for why calling them, not reimplementing
    -- them, is the entire safety argument here.
    user_spend_usd(target_user_id, day_start_ts, now_ts)   as daily_spent_usd,
    user_spend_usd(target_user_id, week_start_ts, now_ts)  as weekly_spent_usd,
    spend_total_usd(day_start_ts, now_ts)                  as global_spent_today_usd,
    user_active_grants_usd(target_user_id, now_ts)         as active_grants_usd,

    -- The per-grant DISPLAY detail getActiveGrantsSummary (web/lib/spend.ts)
    -- used to fetch as its own separate `select ... from allowance_grants`
    -- round trip. Same predicate that function and user_active_grants_usd
    -- both use (`user_id = target_user_id and expires_at > at_ts`).
    (
      select count(*)::integer
      from allowance_grants
      where user_id = target_user_id
        and expires_at > now_ts
    ) as grant_count,
    (
      select min(expires_at)
      from allowance_grants
      where user_id = target_user_id
        and expires_at > now_ts
    ) as grant_earliest_expires_at,

    -- web/lib/sidebar-budget.ts's own sixth read -- a sidebar-only concern
    -- getAccountBudgetSnapshot deliberately doesn't know about (no
    -- render-page equivalent), folded in here instead of left as a separate
    -- round trip. `limit 1`: allowance_requests_one_pending_per_user
    -- (0032_allowance_requests.sql) already guarantees at most one pending
    -- row per user at the database level, so this is a belt-and-suspenders
    -- bound, not a real truncation risk.
    (
      select id
      from allowance_requests
      where user_id = target_user_id
        and status = 'pending'
      limit 1
    ) as pending_request_id,
    (
      select requested_usd
      from allowance_requests
      where user_id = target_user_id
        and status = 'pending'
      limit 1
    ) as pending_request_usd;
$$;

comment on function sidebar_budget_snapshot is
  'One-round-trip replacement for the sidebar footer''s six concurrent reads (web/lib/sidebar-'
  'budget.ts''s getSidebarBudget) -- see this migration''s header for the measured Supabase '
  'concurrency ceiling (76ms base + ~19ms per additional concurrent request; six concurrent reads '
  'measures ~172ms, matching the observed 169ms p50) that made firing them in parallel the cost, '
  'not the fix. Calls user_spend_usd/spend_total_usd/user_active_grants_usd (0031/0032, redefined '
  'by 0040_include_archived_cost_in_spend_reads.sql) rather than reimplementing their SQL, so the '
  'sidebar''s figures can never drift from what assertWithinSpendCaps enforces. day_start_ts/'
  'week_start_ts/now_ts are computed in TypeScript (web/lib/spend.ts''s startOfManilaDayIso/'
  'startOfManilaWeekIso, Asia/Manila day and Monday-reset week) and passed in, exactly like '
  'user_spend_usd/spend_total_usd already take from_ts/to_ts -- this function computes no time '
  'boundary of its own. Returns raw spent/grant/pending-request figures only, never a cap or a '
  'remaining amount -- caps stay ENV, resolved by web/lib/spend.ts''s resolveAccountCaps.';

-- No new grants needed on the function above -- 0007_grants.sql's `alter
-- default privileges ... grant execute on functions to authenticated`
-- already covers anything this migration's role creates, the same fact
-- every migration since 0026 has leaned on.
-- =============================================================================
