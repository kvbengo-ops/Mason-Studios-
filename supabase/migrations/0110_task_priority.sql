-- Assignment metadata: trusted editors can communicate urgency while keeping
-- the deadline as an explicit UTC timestamp (the UI may offer today,
-- tomorrow, this-week, custom, and no-deadline presets).
alter table tasks
  add column priority text not null default 'normal'
  check (priority in ('urgent', 'high', 'normal', 'low'));

create index tasks_creator_priority_idx on tasks (created_by, priority, updated_at desc);

comment on column tasks.priority is
  'Assignment priority selected by the trusted editor: urgent, high, normal, or low.';
comment on column tasks.due_at is
  'Optional UTC deadline. Assignment UI may expose same-day and other deadline presets.';

-- Replace the original create signature so authenticated callers must provide
-- the active assignment priority. The old function is not left as a bypass.
revoke all on function public.create_task(text, text, text, timestamptz, text, uuid[], uuid)
  from public, anon, authenticated;
drop function public.create_task(text, text, text, timestamptz, text, uuid[], uuid);

create function public.create_task(
  p_title text,
  p_brief text,
  p_deliverable_description text,
  p_due_at timestamptz,
  p_audience text,
  p_assignee_ids uuid[],
  p_request_key uuid,
  p_priority text
)
returns table (task_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  created_task_id uuid;
  requested_count integer;
  eligible_count integer;
begin
  if caller_id is null then raise exception 'task manager authentication required'; end if;
  if not is_active_task_manager() then raise exception 'only an active trusted editor can create tasks'; end if;
  if p_request_key is null then raise exception 'a request key is required'; end if;
  if p_audience not in ('all', 'selected') then raise exception 'choose all editors or selected editors'; end if;
  if p_priority not in ('urgent', 'high', 'normal', 'low') then raise exception 'choose a valid task priority'; end if;
  if p_audience = 'selected' and coalesce(cardinality(p_assignee_ids), 0) = 0 then
    raise exception 'choose at least one active regular editor';
  end if;

  -- A retry with the same key returns the original task and never mutates its
  -- brief, priority, deadline, or recipient set.
  select t.id into created_task_id
  from tasks t
  where t.created_by = caller_id and t.request_key = p_request_key;
  if created_task_id is not null then
    return query select created_task_id;
    return;
  end if;

  if p_audience = 'selected' then
    select cardinality(p_assignee_ids), count(*) into requested_count, eligible_count
    from profiles p
    where p.id = any(p_assignee_ids) and p.role = 'editor' and p.status = 'active';
    if requested_count <> eligible_count then
      raise exception 'that editor is no longer eligible';
    end if;
  else
    select count(*) into eligible_count from profiles p where p.role = 'editor' and p.status = 'active';
    if eligible_count = 0 then raise exception 'choose at least one active regular editor'; end if;
  end if;

  insert into tasks (
    created_by, title, brief, deliverable_description, due_at, audience, request_key, priority
  )
  values (
    caller_id, btrim(p_title), btrim(p_brief), btrim(p_deliverable_description),
    p_due_at, p_audience, p_request_key, p_priority
  )
  returning id into created_task_id;

  insert into task_assignments (task_id, assignee_id)
  select created_task_id, p.id
  from profiles p
  where p.role = 'editor'
    and p.status = 'active'
    and (p_audience = 'all' or p.id = any(p_assignee_ids));

  insert into notifications (user_id, kind, title, body, metadata, task_id, task_assignment_id)
  select a.assignee_id,
         'task_assigned',
         'New task assigned',
         format('%s priority task: %s.', initcap(p_priority), left(btrim(p_title), 160)),
         jsonb_build_object('task_id', created_task_id, 'assignment_id', a.id, 'priority', p_priority),
         created_task_id,
         a.id
  from task_assignments a
  where a.task_id = created_task_id
  on conflict do nothing;

  return query select created_task_id;
exception
  when unique_violation then
    select t.id into created_task_id
    from tasks t where t.created_by = caller_id and t.request_key = p_request_key;
    if created_task_id is null then raise; end if;
    return query select created_task_id;
end;
$$;

revoke all on function public.create_task(text, text, text, timestamptz, text, uuid[], uuid, text)
  from public, anon;
grant execute on function public.create_task(text, text, text, timestamptz, text, uuid[], uuid, text)
  to authenticated;

-- Include priority in the bounded assignment list and manager summary.
drop function public.my_task_assignments();
create function public.my_task_assignments()
returns table (
  assignment_id uuid,
  task_id uuid,
  title text,
  brief text,
  due_at timestamptz,
  priority text,
  created_by uuid,
  created_at timestamptz,
  status text,
  current_revision integer,
  submitted_at timestamptz,
  completed_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select a.id, t.id, t.title, t.brief, t.due_at, t.priority, t.created_by, t.created_at,
         a.status, a.current_revision, a.submitted_at, a.completed_at
  from task_assignments a
  join tasks t on t.id = a.task_id
  where a.assignee_id = auth.uid()
  order by (t.due_at is null), t.due_at, t.created_at desc
  limit 100;
$$;

revoke all on function public.my_task_assignments() from public, anon;
grant execute on function public.my_task_assignments() to authenticated;

drop function public.managed_tasks();
create function public.managed_tasks()
returns table (
  task_id uuid,
  title text,
  brief text,
  due_at timestamptz,
  priority text,
  audience text,
  created_at timestamptz,
  cancelled_at timestamptz,
  total_count bigint,
  completed_count bigint,
  cancelled_count bigint,
  submitted_count bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select t.id, t.title, t.brief, t.due_at, t.priority, t.audience, t.created_at, t.cancelled_at,
         count(a.id),
         count(a.id) filter (where a.status = 'completed'),
         count(a.id) filter (where a.status = 'cancelled'),
         count(a.id) filter (where a.status = 'submitted')
  from tasks t
  join task_assignments a on a.task_id = t.id
  where t.created_by = auth.uid() and is_active_task_manager()
  group by t.id
  order by (t.due_at is null), t.due_at, t.created_at desc
  limit 100;
$$;

revoke all on function public.managed_tasks() from public, anon;
grant execute on function public.managed_tasks() to authenticated;
