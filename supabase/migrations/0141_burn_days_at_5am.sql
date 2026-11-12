-- Burn rate days run 05:00 to 05:00 Asia/Manila, the boundary the caps reset on
-- since 0138. Before this, /users' Team burn, sparklines and burn drawer cut
-- days at midnight, so their "today" disagreed with the cap's "today".
--
-- Same two objects as 0135, only the day boundary moves: a run at 03:00 Tuesday
-- now belongs to Monday. Callers pass 05:00-aligned from_ts/to_ts (lib/burn-data.ts).

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
    where r.created_at >= (public.manila_spend_day_start(now()) - interval '6 days')
    union all
    select h.user_id, h.cost_usd
    from deleted_project_cost_history h
    where h.run_created_at >= (public.manila_spend_day_start(now()) - interval '6 days')
  ) t
  where t.user_id is not null
  group by t.user_id
) b on b.user_id = d.id;


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
           ((r.created_at - interval '5 hours') at time zone 'Asia/Manila')::date as day,
           r.cost_usd
    from runs r
    left join projects p on p.id = r.project_id
    where r.created_at >= from_ts and r.created_at < to_ts
      and r.cost_usd is not null
    union all
    select h.user_id,
           ((h.run_created_at - interval '5 hours') at time zone 'Asia/Manila')::date,
           h.cost_usd
    from deleted_project_cost_history h
    where h.run_created_at >= from_ts and h.run_created_at < to_ts
      and h.cost_usd is not null
  ) t
  where user_ids is null or t.user_id = any (user_ids)
  group by 1, 2
  order by 1, 2;
$$;

