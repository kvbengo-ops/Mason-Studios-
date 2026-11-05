-- Admins get a READ-ONLY window on task management: the sidebar entry, the
-- full task list and each task's roster. Every write path is untouched —
-- create_task and cancel_task still demand is_active_task_manager(), and the
-- assignment RPCs still demand the assignee — so an admin can see everything
-- here and change nothing.
--
-- Widening the two policy helpers is what makes this one migration instead of
-- a parallel admin read path: tasks_select_participant, task_assignments_-
-- select_participant and task_submissions_select_participant all route through
-- them, so a single `or is_admin()` covers RLS, requireTaskReadable's own
-- `tasks` select and the detail page at once.

create or replace function can_read_task(p_task_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select is_admin() or exists (
    select 1 from tasks t where t.id = p_task_id and t.created_by = auth.uid()
  ) or exists (
    select 1 from task_assignments a where a.task_id = p_task_id and a.assignee_id = auth.uid()
  );
$$;

create or replace function can_read_assignment(p_assignment_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select is_admin() or exists (
    select 1
    from task_assignments a
    join tasks t on t.id = a.task_id
    where a.id = p_assignment_id
      and (a.assignee_id = auth.uid() or t.created_by = auth.uid())
  );
$$;

-- Same projection, same columns, one wider WHERE: an admin sees every task
-- rather than only the ones they created (they create none).
create or replace function public.managed_tasks()
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
  completed_count bigint,
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
         count(a.id) filter (where a.status = 'completed'),
         count(a.id) filter (where a.status = 'cancelled')
  from tasks t
  join task_assignments a on a.task_id = t.id
  where is_admin() or (t.created_by = auth.uid() and is_active_task_manager())
  group by t.id
  order by (t.due_at is null), t.due_at, t.created_at desc
  limit 100;
$$;

create or replace function public.task_assignment_directory(p_task_id uuid)
returns table (
  assignment_id uuid,
  task_id uuid,
  assignee_id uuid,
  assignee_username text,
  assignee_email text,
  status text,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select a.id, a.task_id, a.assignee_id, p.username, p.email, a.status,
         a.started_at, a.completed_at, a.cancelled_at
  from task_assignments a
  join tasks t on t.id = a.task_id
  join profiles p on p.id = a.assignee_id
  where a.task_id = p_task_id
    and (is_admin() or t.created_by = auth.uid() or a.assignee_id = auth.uid())
  order by lower(p.username), a.id;
$$;

revoke all on function managed_tasks() from public, anon;
grant execute on function managed_tasks() to authenticated;
revoke all on function task_assignment_directory(uuid) from public, anon;
grant execute on function task_assignment_directory(uuid) to authenticated;
