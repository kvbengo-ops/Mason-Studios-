-- The assignee can now close out their own work: assigned/in_progress ->
-- completed, and back again if they marked it by mistake.
--
-- This is NOT the submission/review flow 0109 revoked. Nothing here reads or
-- writes task_submissions, nobody reviews anything, and no deliverable is
-- collected — completion is self-reported by the person doing the work, the
-- same way "start" already is. The dormant submit/review scaffold stays
-- revoked and untouched for the follow-up work 0109 reserved it for.
--
-- 'completed' was already legal in task_assignments' status check (0107); it
-- simply had no RPC an assignee was allowed to call.

create or replace function complete_task_assignment(p_assignment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  assignment_row task_assignments%rowtype;
  task_creator uuid;
begin
  select * into assignment_row from task_assignments where id = p_assignment_id for update;
  if not found then raise exception 'task assignment not found'; end if;
  if assignment_row.assignee_id <> auth.uid() then raise exception 'only the assignee can update this assignment'; end if;
  if not exists (select 1 from profiles where id = auth.uid() and role = 'editor' and status = 'active') then
    raise exception 'your account is no longer eligible to work on this assignment';
  end if;
  -- Idempotent, like start_task_assignment: a double-tap or a retried
  -- request must not raise, and must not notify the creator twice.
  if assignment_row.status = 'completed' then return; end if;
  if assignment_row.status not in ('assigned', 'in_progress') then
    raise exception 'this assignment has already moved on';
  end if;

  update task_assignments
  set status = 'completed',
      -- Finishing without ever pressing Start is a legitimate path; record a
      -- start time anyway so the row is not left claiming it never began.
      started_at = coalesce(started_at, now()),
      completed_at = now(),
      updated_at = now()
  where id = p_assignment_id;

  select t.created_by into task_creator from tasks t where t.id = assignment_row.task_id;
  insert into notifications (user_id, kind, title, body, metadata, task_id, task_assignment_id)
  values (
    task_creator,
    'task_completed',
    'Task marked done',
    'An editor marked their assignment as done.',
    jsonb_build_object('task_id', assignment_row.task_id, 'assignment_id', p_assignment_id),
    assignment_row.task_id,
    p_assignment_id
  ) on conflict do nothing;
end;
$$;

revoke all on function complete_task_assignment(uuid) from public, anon;
grant execute on function complete_task_assignment(uuid) to authenticated;

-- Undo for the button above. Marking work done is one tap and easy to hit by
-- accident; without this the only way back is asking the task creator to
-- cancel and recreate the whole task.
create or replace function reopen_task_assignment(p_assignment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  assignment_row task_assignments%rowtype;
begin
  select * into assignment_row from task_assignments where id = p_assignment_id for update;
  if not found then raise exception 'task assignment not found'; end if;
  if assignment_row.assignee_id <> auth.uid() then raise exception 'only the assignee can update this assignment'; end if;
  if not exists (select 1 from profiles where id = auth.uid() and role = 'editor' and status = 'active') then
    raise exception 'your account is no longer eligible to work on this assignment';
  end if;
  -- Cancelled is the task creator's decision and stays terminal to the
  -- assignee; only self-marked completion is reversible here.
  if assignment_row.status <> 'completed' then
    raise exception 'this assignment has already moved on';
  end if;
  -- An assignment completed before the creator cancelled the task stays
  -- completed (cancel_task only touches non-terminal rows). Reopening it
  -- would put live in_progress work under a task marked cancelled.
  if exists (select 1 from tasks where id = assignment_row.task_id and cancelled_at is not null) then
    raise exception 'this task has already moved on';
  end if;

  update task_assignments
  set status = 'in_progress', completed_at = null, updated_at = now()
  where id = p_assignment_id;
end;
$$;

revoke all on function reopen_task_assignment(uuid) from public, anon;
grant execute on function reopen_task_assignment(uuid) to authenticated;

-- Projections have to carry completion, or the creator's roster shows work
-- sitting in progress forever and the progress bar can never fill.
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
  where t.created_by = auth.uid() and is_active_task_manager()
  group by t.id
  order by (t.due_at is null), t.due_at, t.created_at desc
  limit 100;
$$;

revoke all on function managed_tasks() from public, anon;
grant execute on function managed_tasks() to authenticated;

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
  completed_at timestamptz,
  cancelled_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select a.id, t.id, t.title, t.brief, t.due_at, t.priority, t.created_by, t.created_at,
         a.status, a.started_at, a.completed_at, a.cancelled_at
  from task_assignments a
  join tasks t on t.id = a.task_id
  where a.assignee_id = auth.uid()
  order by (t.due_at is null), t.due_at, t.created_at desc
  limit 100;
$$;

revoke all on function my_task_assignments() from public, anon;
grant execute on function my_task_assignments() to authenticated;

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
    and (t.created_by = auth.uid() or a.assignee_id = auth.uid())
  order by lower(p.username), a.id;
$$;

revoke all on function task_assignment_directory(uuid) from public, anon;
grant execute on function task_assignment_directory(uuid) to authenticated;
