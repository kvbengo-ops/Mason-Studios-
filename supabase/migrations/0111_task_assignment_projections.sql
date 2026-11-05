-- Keep active assignment reads free of submission/review fields. The underlying
-- columns and dormant tables remain available for Darwin's future workflow.
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
  started_at timestamptz,
  cancelled_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select a.id, t.id, t.title, t.brief, t.due_at, t.priority, t.created_by, t.created_at,
         a.status, a.started_at, a.cancelled_at
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
  assigned_count bigint,
  in_progress_count bigint,
  cancelled_count bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select t.id, t.title, t.brief, t.due_at, t.priority, t.audience, t.created_at, t.cancelled_at,
         count(a.id),
         count(a.id) filter (where a.status = 'assigned'),
         count(a.id) filter (where a.status = 'in_progress'),
         count(a.id) filter (where a.status = 'cancelled')
  from tasks t
  join task_assignments a on a.task_id = t.id
  where t.created_by = auth.uid() and is_active_task_manager()
  group by t.id
  order by (t.due_at is null), t.due_at, t.created_at desc
  limit 100;
$$;

revoke all on function public.managed_tasks() from public, anon;
grant execute on function public.managed_tasks() to authenticated;

drop function public.task_assignment_directory(uuid);
create function public.task_assignment_directory(p_task_id uuid)
returns table (
  assignment_id uuid,
  task_id uuid,
  assignee_id uuid,
  assignee_username text,
  assignee_email text,
  status text,
  started_at timestamptz,
  cancelled_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select a.id, a.task_id, a.assignee_id, p.username, p.email, a.status,
         a.started_at, a.cancelled_at
  from task_assignments a
  join tasks t on t.id = a.task_id
  join profiles p on p.id = a.assignee_id
  where a.task_id = p_task_id
    and (t.created_by = auth.uid() or a.assignee_id = auth.uid())
  order by lower(p.username), a.id;
$$;

revoke all on function public.task_assignment_directory(uuid) from public, anon;
grant execute on function public.task_assignment_directory(uuid) to authenticated;
