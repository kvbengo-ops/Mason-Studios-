-- =============================================================================
-- Burn rate: per-day spend by account, for /users' Burn column, the team burn
-- strip and the per-account burn drawer.
--
-- "Spend" here is exactly what the caps and Accounts Control sum: runs.cost_usd
-- attributed to coalesce(runs.user_id, projects.user_id) (0085), plus the
-- archive of deleted projects/scenes (deleted_project_cost_history, 0038/0040)
-- so deleting a project or deactivating an account never erases its past
-- spend. Days are Asia/Manila calendar days, the boundary lib/spend.ts and
-- account_spend_windows (0031/0040) already enforce.
--
-- Nothing here stores or decrements a balance. All three objects are reads
-- over runs; security invoker, so RLS (runs_select, is_admin() on the archive)
-- scopes them exactly like spend_category_totals_by_user.
--
-- 1. user_directory_burn   view      -- user_directory + 7-day burn, sortable
-- 2. spend_daily_by_user   function  -- (user, Manila day) -> USD
-- 3. spend_models_by_user  function  -- one account's spend by model
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. user_directory_burn
-- ---------------------------------------------------------------------------
-- /users must ORDER BY burn in the same query as its search/page/LIMIT, the
-- reason user_directory (0028) exists for spend_usd: sorting after fetching a
-- page of profiles would only order that page. burn_usd = spend over the
-- current Manila day and the six before it, divided by 7 (a day with no spend
-- counts as 0; today counts as a day even though it is part-way through).
create or replace view user_directory_burn
with (security_invoker = true) as
select
  d.id,
  d.email,
  d.username,
  d.role,
  d.created_at,
  d.project_count,
  d.spend_usd,
  d.status,
  coalesce(b.spend_usd, 0) / 7 as burn_usd
from user_directory d
left join (
  select t.user_id, sum(t.cost_usd) as spend_usd
  from (
    select coalesce(r.user_id, p.user_id) as user_id, r.cost_usd
    from runs r
    left join projects p on p.id = r.project_id
    where r.created_at >= ((date_trunc('day', now() at time zone 'Asia/Manila') - interval '6 days') at time zone 'Asia/Manila')
    union all
    select h.user_id, h.cost_usd
    from deleted_project_cost_history h
    where h.run_created_at >= ((date_trunc('day', now() at time zone 'Asia/Manila') - interval '6 days') at time zone 'Asia/Manila')
  ) t
  where t.user_id is not null
  group by t.user_id
) b on b.user_id = d.id;

comment on view user_directory_burn is
  'user_directory plus burn_usd: the account''s average spend per Asia/Manila day over the last 7 '
  'days (today and the six before it; total / 7), archived runs included. Lets /users sort by burn '
  'server-side next to search and paging. See 0135_spend_burn_rate.sql.';

-- ---------------------------------------------------------------------------
-- 2. spend_daily_by_user
-- ---------------------------------------------------------------------------
-- One row per (account, Manila day) that has spend; days with none are absent,
-- the caller zero-fills. Bounded by user_ids (the ids on one /users page, or
-- one account for the drawer) so a page's read is never one query per row.
-- user_ids NULL is the team read: user_id comes back NULL and the rows are the
-- team's per-day totals, INCLUDING archived runs whose owner could not be
-- resolved (the same spend spend_total_usd counts).
create or replace function spend_daily_by_user(
  from_ts timestamptz,
  to_ts timestamptz,
  user_ids uuid[] default null
)
returns table(user_id uuid, day date, total_usd numeric)
language sql stable security invoker set search_path = public as $$
  select
    case when user_ids is null then null::uuid else t.user_id end as user_id,
    t.day,
    coalesce(sum(t.cost_usd), 0) as total_usd
  from (
    select coalesce(r.user_id, p.user_id) as user_id,
           (r.created_at at time zone 'Asia/Manila')::date as day,
           r.cost_usd
    from runs r
    left join projects p on p.id = r.project_id
    where r.created_at >= from_ts and r.created_at < to_ts
      and r.cost_usd is not null
    union all
    select h.user_id,
           (h.run_created_at at time zone 'Asia/Manila')::date,
           h.cost_usd
    from deleted_project_cost_history h
    where h.run_created_at >= from_ts and h.run_created_at < to_ts
      and h.cost_usd is not null
  ) t
  where user_ids is null or t.user_id = any (user_ids)
  group by 1, 2
  order by 1, 2;
$$;

comment on function spend_daily_by_user is
  'Spend per Asia/Manila day for runs in [from_ts, to_ts), archived runs included (0038/0040). One '
  'row per (user_id, day) with spend, for the accounts in user_ids; user_ids NULL returns the whole '
  'team''s per-day totals with user_id NULL. Backs /users'' burn sparklines, the team burn strip and '
  'the burn drawer. See 0135_spend_burn_rate.sql.';

-- ---------------------------------------------------------------------------
-- 3. spend_models_by_user
-- ---------------------------------------------------------------------------
create or replace function spend_models_by_user(
  target_user_id uuid,
  from_ts timestamptz,
  to_ts timestamptz
)
returns table(model text, vendor text, run_count bigint, cost_usd numeric)
language sql stable security invoker set search_path = public as $$
  select t.model, t.vendor, count(*) as run_count, coalesce(sum(t.cost_usd), 0) as cost_usd
  from (
    select r.model, r.vendor, r.cost_usd
    from runs r
    left join projects p on p.id = r.project_id
    where coalesce(r.user_id, p.user_id) = target_user_id
      and r.created_at >= from_ts and r.created_at < to_ts
      and r.cost_usd is not null
    union all
    select h.model, h.vendor, h.cost_usd
    from deleted_project_cost_history h
    where h.user_id = target_user_id
      and h.run_created_at >= from_ts and h.run_created_at < to_ts
      and h.cost_usd is not null
  ) t
  group by t.model, t.vendor
  order by cost_usd desc;
$$;

comment on function spend_models_by_user is
  'One account''s billed spend per (model, vendor) for runs in [from_ts, to_ts), archived runs '
  'included. Backs the /users burn drawer''s "spend by model". See 0135_spend_burn_rate.sql.';
