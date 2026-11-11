-- Two cuts to DB load seen in the Supabase query-performance report.
--
-- 1. account_spend_windows (0031, 0040, 0085): 25.6% of total DB time, read
--    with no WHERE by /users and /accounts-control (every 30 s per open admin
--    tab). The old definition ran two LATERAL sums per profile whose
--    predicate, coalesce(r.user_id, pr.user_id) = p.id, no index can serve,
--    so every profile re-scanned runs from the window start twice.
--
--    Same numbers, one pass: read the week's runs ONCE (the day is inside
--    the week, so the week bound covers both), attribute each to its owner
--    with the same coalesce rule split into its two halves, then group. The
--    range scan is on runs_created_at_idx. Same Manila boundaries as
--    lib/spend.ts, same columns and types, still security_invoker.
--
-- 2. Realtime: realtime.list_changes was 22% of DB time while the app only
--    subscribes to scenes (render-progress.tsx) and notifications
--    (top-bar.tsx, notifications-list.tsx). chat_messages, tasks,
--    task_assignments and task_submissions were published (0104, 0107) with
--    no subscriber, so the WAL reader decoded their changes for nothing.
--    Add one back with `alter publication supabase_realtime add table ...`
--    in the migration that ships its first subscriber.

create or replace view account_spend_windows
with (security_invoker = true) as
with bounds as (
  select
    (date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila') as day_start,
    (date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila') as week_start
),
spend as (
  select r.user_id as owner_id, r.cost_usd, r.created_at as ran_at
  from runs r, bounds b
  where r.user_id is not null
    and r.created_at >= b.week_start

  union all

  -- Runs with no user_id of their own belong to their project's owner.
  select pr.user_id, r.cost_usd, r.created_at
  from runs r
  join projects pr on pr.id = r.project_id, bounds b
  where r.user_id is null
    and r.created_at >= b.week_start

  union all

  select h.user_id, h.cost_usd, h.run_created_at
  from deleted_project_cost_history h, bounds b
  where h.run_created_at >= b.week_start
)
select
  p.id as user_id,
  coalesce(sum(s.cost_usd) filter (where s.ran_at >= b.day_start), 0) as spent_today_usd,
  coalesce(sum(s.cost_usd), 0) as spent_this_week_usd
from profiles p
cross join bounds b
left join spend s on s.owner_id = p.id
group by p.id;

do $$
declare
  t text;
begin
  foreach t in array array['chat_messages', 'tasks', 'task_assignments', 'task_submissions'] loop
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end
$$;
