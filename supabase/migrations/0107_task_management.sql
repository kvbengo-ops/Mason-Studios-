-- Task management: trusted editors assign independent work to active editors.
--
-- Postgres is the transaction boundary. The browser can read rows only when it
-- is a task participant; all lifecycle writes go through security-definer RPCs
-- that derive the actor from auth.uid() and lock the assignment they change.

create table tasks (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references profiles(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 160),
  brief text not null check (char_length(brief) between 1 and 10000),
  deliverable_description text not null check (char_length(deliverable_description) between 1 and 2000),
  due_at timestamptz,
  audience text not null check (audience in ('all', 'selected')),
  request_key uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  unique (created_by, request_key)
);

create table task_assignments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete restrict,
  assignee_id uuid not null references profiles(id) on delete restrict,
  status text not null default 'assigned'
    check (status in ('assigned', 'in_progress', 'submitted', 'changes_requested', 'completed', 'cancelled')),
  current_revision integer not null default 0 check (current_revision >= 0),
  started_at timestamptz,
  submitted_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, assignee_id)
);

create table task_submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references task_assignments(id) on delete restrict,
  revision integer not null check (revision > 0),
  deliverable_url text not null check (deliverable_url ~ '^https://[^[:space:]]+$'),
  note text check (note is null or char_length(note) <= 2000),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewer_id uuid references profiles(id) on delete restrict,
  decision text check (decision in ('accepted', 'changes_requested')),
  feedback text check (feedback is null or char_length(feedback) <= 4000),
  unique (assignment_id, revision),
  check (
    (reviewed_at is null and decision is null and reviewer_id is null and feedback is null)
    or (reviewed_at is not null and decision is not null and reviewer_id is not null)
  )
);

create index tasks_creator_updated_idx on tasks (created_by, updated_at desc);
create index task_assignments_assignee_status_idx on task_assignments (assignee_id, status, updated_at desc);
create index task_assignments_task_status_idx on task_assignments (task_id, status);
create index task_submissions_assignment_revision_idx on task_submissions (assignment_id, revision desc);

comment on table tasks is
  'A trusted-editor work brief. Assignments snapshot the regular editors eligible at creation time.';
comment on table task_assignments is
  'One independent obligation per task recipient. Progress is derived from these rows.';
comment on table task_submissions is
  'Immutable deliverable revisions; only review fields are written after insert.';

alter table tasks enable row level security;
alter table task_assignments enable row level security;
alter table task_submissions enable row level security;

revoke all on table tasks, task_assignments, task_submissions from anon, authenticated;
grant select on table tasks, task_assignments, task_submissions to authenticated;

create or replace function is_active_task_manager()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'trusted_editor' and status = 'active'
  );
$$;

create or replace function can_read_task(p_task_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
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
  select exists (
    select 1
    from task_assignments a
    join tasks t on t.id = a.task_id
    where a.id = p_assignment_id
      and (a.assignee_id = auth.uid() or t.created_by = auth.uid())
  );
$$;

revoke all on function is_active_task_manager() from public, anon;
revoke all on function can_read_task(uuid) from public, anon;
revoke all on function can_read_assignment(uuid) from public, anon;

create policy tasks_select_participant on tasks
  for select to authenticated
  using (can_read_task(id));

create policy task_assignments_select_participant on task_assignments
  for select to authenticated
  using (can_read_assignment(id));

create policy task_submissions_select_participant on task_submissions
  for select to authenticated
  using (can_read_assignment(assignment_id));

-- There are deliberately no browser insert/update/delete policies. RPCs below
-- perform the writes after checking the role, resource, status and actor.

create or replace function task_eligible_assignees()
returns table (id uuid, username text, email text)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, p.username, p.email
  from profiles p
  where is_active_task_manager()
    and p.role = 'editor'
    and p.status = 'active'
  order by lower(p.username), p.id;
$$;

revoke all on function task_eligible_assignees() from public, anon;
grant execute on function task_eligible_assignees() to authenticated;

create or replace function my_task_assignments()
returns table (
  assignment_id uuid,
  task_id uuid,
  title text,
  brief text,
  due_at timestamptz,
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
  select a.id, t.id, t.title, t.brief, t.due_at, t.created_by, t.created_at,
         a.status, a.current_revision, a.submitted_at, a.completed_at
  from task_assignments a
  join tasks t on t.id = a.task_id
  where a.assignee_id = auth.uid()
  order by (t.due_at is null), t.due_at, t.created_at desc
  limit 100;
$$;

create or replace function managed_tasks()
returns table (
  task_id uuid,
  title text,
  brief text,
  due_at timestamptz,
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
  select t.id, t.title, t.brief, t.due_at, t.audience, t.created_at, t.cancelled_at,
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

create or replace function task_assignment_directory(p_task_id uuid)
returns table (
  assignment_id uuid,
  task_id uuid,
  assignee_id uuid,
  assignee_username text,
  assignee_email text,
  status text,
  current_revision integer,
  started_at timestamptz,
  submitted_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select a.id, a.task_id, a.assignee_id, p.username, p.email, a.status,
         a.current_revision, a.started_at, a.submitted_at, a.completed_at, a.cancelled_at
  from task_assignments a
  join tasks t on t.id = a.task_id
  join profiles p on p.id = a.assignee_id
  where a.task_id = p_task_id
    and (t.created_by = auth.uid() or a.assignee_id = auth.uid())
  order by lower(p.username), a.id;
$$;

revoke all on function my_task_assignments() from public, anon;
grant execute on function my_task_assignments() to authenticated;
revoke all on function managed_tasks() from public, anon;
grant execute on function managed_tasks() to authenticated;
revoke all on function task_assignment_directory(uuid) from public, anon;
grant execute on function task_assignment_directory(uuid) to authenticated;

-- Extend the existing inbox before the RPCs below reference its new source
-- columns. Existing rows remain valid under the widened source check.
alter table notifications add column task_id uuid references tasks(id) on delete restrict;
alter table notifications add column task_assignment_id uuid references task_assignments(id) on delete restrict;
alter table notifications drop constraint if exists notifications_check;
alter table notifications add constraint notifications_source_check check (
  (kind = 'scene_completed' and scene_id is not null and allowance_request_id is null and allowance_grant_id is null and task_id is null and task_assignment_id is null)
  or (kind = 'credit_requested' and scene_id is null and allowance_request_id is not null and allowance_grant_id is null and task_id is null and task_assignment_id is null)
  or (kind = 'credit_approved' and scene_id is null and allowance_request_id is not null and allowance_grant_id is not null and task_id is null and task_assignment_id is null)
  or (kind = 'credit_received' and scene_id is null and allowance_request_id is null and allowance_grant_id is not null and task_id is null and task_assignment_id is null)
  or (kind in ('task_assigned', 'task_submitted', 'task_changes_requested', 'task_completed', 'task_cancelled')
      and scene_id is null and allowance_request_id is null and allowance_grant_id is null
      and task_id is not null and task_assignment_id is not null)
);

alter table notifications drop constraint if exists notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (
  kind in ('scene_completed', 'credit_requested', 'credit_approved', 'credit_received',
           'task_assigned', 'task_submitted', 'task_changes_requested', 'task_completed', 'task_cancelled')
);

create unique index notifications_task_assigned_once_idx
  on notifications (user_id, kind, task_assignment_id) where kind = 'task_assigned';
create unique index notifications_task_submitted_once_idx
  on notifications (user_id, kind, task_assignment_id, (metadata->>'revision')) where kind = 'task_submitted';
create unique index notifications_task_changes_once_idx
  on notifications (user_id, kind, task_assignment_id, (metadata->>'revision')) where kind = 'task_changes_requested';
create unique index notifications_task_completed_once_idx
  on notifications (user_id, kind, task_assignment_id) where kind = 'task_completed';
create unique index notifications_task_cancelled_once_idx
  on notifications (user_id, kind, task_assignment_id) where kind = 'task_cancelled';

create or replace function create_task(
  p_title text,
  p_brief text,
  p_deliverable_description text,
  p_due_at timestamptz,
  p_audience text,
  p_assignee_ids uuid[],
  p_request_key uuid
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
  if p_audience = 'selected' and coalesce(cardinality(p_assignee_ids), 0) = 0 then
    raise exception 'choose at least one active regular editor';
  end if;

  -- A retry with the same key returns the original task and never mutates its
  -- brief or recipient set.
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

  insert into tasks (created_by, title, brief, deliverable_description, due_at, audience, request_key)
  values (caller_id, btrim(p_title), btrim(p_brief), btrim(p_deliverable_description), p_due_at, p_audience, p_request_key)
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
         format('You have a new task: %s.', left(btrim(p_title), 160)),
         jsonb_build_object('task_id', created_task_id, 'assignment_id', a.id),
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

revoke all on function create_task(text, text, text, timestamptz, text, uuid[], uuid) from public, anon;
grant execute on function create_task(text, text, text, timestamptz, text, uuid[], uuid) to authenticated;

create or replace function start_task_assignment(p_assignment_id uuid)
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
  if assignment_row.status = 'in_progress' then return; end if;
  if assignment_row.status <> 'assigned' then raise exception 'this assignment has already moved on'; end if;

  update task_assignments
  set status = 'in_progress', started_at = coalesce(started_at, now()), updated_at = now()
  where id = p_assignment_id;
end;
$$;

revoke all on function start_task_assignment(uuid) from public, anon;
grant execute on function start_task_assignment(uuid) to authenticated;

create or replace function submit_task_assignment(
  p_assignment_id uuid,
  p_deliverable_url text,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  assignment_row task_assignments%rowtype;
  next_revision integer;
  trimmed_url text := btrim(p_deliverable_url);
  trimmed_note text := nullif(btrim(coalesce(p_note, '')), '');
  task_creator uuid;
begin
  select a into assignment_row
  from task_assignments a
  where a.id = p_assignment_id
  for update;
  if not found then raise exception 'task assignment not found'; end if;
  select t.created_by into task_creator from tasks t where t.id = assignment_row.task_id;
  if assignment_row.assignee_id <> auth.uid() then raise exception 'only the assignee can update this assignment'; end if;
  if not exists (select 1 from profiles where id = auth.uid() and role = 'editor' and status = 'active') then
    raise exception 'your account is no longer eligible to work on this assignment';
  end if;
  if assignment_row.status not in ('in_progress', 'changes_requested') then
    raise exception 'this assignment has already moved on';
  end if;
  if trimmed_url !~ '^https://[^[:space:]]+$' then raise exception 'submit an HTTPS deliverable link'; end if;
  if length(trimmed_url) > 2000 then raise exception 'the deliverable link is too long'; end if;
  if trimmed_note is not null and length(trimmed_note) > 2000 then raise exception 'the handoff note is too long'; end if;

  next_revision := assignment_row.current_revision + 1;
  insert into task_submissions (assignment_id, revision, deliverable_url, note)
  values (p_assignment_id, next_revision, trimmed_url, trimmed_note);

  update task_assignments
  set status = 'submitted', current_revision = next_revision, submitted_at = now(), updated_at = now()
  where id = p_assignment_id;

  insert into notifications (user_id, kind, title, body, metadata, task_id, task_assignment_id)
  values (
    task_creator,
    'task_submitted',
    'Task submitted for review',
    'An editor submitted work for one of your tasks.',
    jsonb_build_object('task_id', assignment_row.task_id, 'assignment_id', p_assignment_id, 'revision', next_revision),
    assignment_row.task_id,
    p_assignment_id
  ) on conflict do nothing;
end;
$$;

revoke all on function submit_task_assignment(uuid, text, text) from public, anon;
grant execute on function submit_task_assignment(uuid, text, text) to authenticated;

create or replace function review_task_submission(
  p_assignment_id uuid,
  p_revision integer,
  p_decision text,
  p_feedback text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  assignment_row task_assignments%rowtype;
  submission_id uuid;
  assignee_id uuid;
  task_creator uuid;
  trimmed_feedback text := nullif(btrim(coalesce(p_feedback, '')), '');
begin
  select a into assignment_row
  from task_assignments a
  where a.id = p_assignment_id
  for update;
  if not found then raise exception 'task assignment not found'; end if;
  select t.created_by into task_creator from tasks t where t.id = assignment_row.task_id;
  if task_creator <> auth.uid() then raise exception 'only the task creator can review this submission'; end if;
  if not is_active_task_manager() then raise exception 'only an active trusted editor can review tasks'; end if;
  if p_decision not in ('accepted', 'changes_requested') then raise exception 'choose accept or request changes'; end if;
  if p_decision = 'changes_requested' and trimmed_feedback is null then raise exception 'feedback is required when requesting changes'; end if;
  if assignment_row.status <> 'submitted' or assignment_row.current_revision <> p_revision then
    raise exception 'this submission is no longer current';
  end if;

  select s.id, a.assignee_id into submission_id, assignee_id
  from task_submissions s join task_assignments a on a.id = s.assignment_id
  where s.assignment_id = p_assignment_id and s.revision = p_revision and s.reviewed_at is null
  for update of s;
  if submission_id is null then raise exception 'this submission is no longer current'; end if;

  update task_submissions
  set reviewed_at = now(), reviewer_id = auth.uid(), decision = p_decision, feedback = trimmed_feedback
  where id = submission_id;

  update task_assignments
  set status = case when p_decision = 'accepted' then 'completed' else 'changes_requested' end,
      completed_at = case when p_decision = 'accepted' then now() else null end,
      updated_at = now()
  where id = p_assignment_id;

  insert into notifications (user_id, kind, title, body, metadata, task_id, task_assignment_id)
  values (
    assignee_id,
    case when p_decision = 'accepted' then 'task_completed' else 'task_changes_requested' end,
    case when p_decision = 'accepted' then 'Task completed' else 'Changes requested' end,
    case when p_decision = 'accepted' then 'Your task submission was accepted.' else 'The task creator requested changes to your submission.' end,
    jsonb_build_object('task_id', assignment_row.task_id, 'assignment_id', p_assignment_id, 'revision', p_revision),
    assignment_row.task_id,
    p_assignment_id
  ) on conflict do nothing;
end;
$$;

revoke all on function review_task_submission(uuid, integer, text, text) from public, anon;
grant execute on function review_task_submission(uuid, integer, text, text) to authenticated;

create or replace function cancel_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  task_creator uuid;
  changed_count integer;
  assignment_row task_assignments%rowtype;
begin
  if not is_active_task_manager() then raise exception 'only an active trusted editor can cancel tasks'; end if;
  select created_by into task_creator from tasks where id = p_task_id for update;
  if task_creator is null then raise exception 'task not found'; end if;
  if task_creator <> auth.uid() then raise exception 'only the task creator can cancel this task'; end if;

  changed_count := 0;
  for assignment_row in
    select * from task_assignments
    where task_id = p_task_id and status in ('assigned', 'in_progress', 'submitted', 'changes_requested')
    for update
  loop
    update task_assignments
    set status = 'cancelled', cancelled_at = now(), updated_at = now()
    where id = assignment_row.id;
    changed_count := changed_count + 1;

    insert into notifications (user_id, kind, title, body, metadata, task_id, task_assignment_id)
    values (
      assignment_row.assignee_id,
      'task_cancelled',
      'Task cancelled',
      'The task creator cancelled this assignment.',
      jsonb_build_object('task_id', p_task_id, 'assignment_id', assignment_row.id),
      p_task_id,
      assignment_row.id
    ) on conflict do nothing;
  end loop;
  if changed_count = 0 then raise exception 'all task assignments are already terminal'; end if;

  update tasks set cancelled_at = now(), updated_at = now() where id = p_task_id;
end;
$$;

revoke all on function cancel_task(uuid) from public, anon;
grant execute on function cancel_task(uuid) to authenticated;

alter publication supabase_realtime add table tasks;
alter publication supabase_realtime add table task_assignments;
alter publication supabase_realtime add table task_submissions;
alter table tasks replica identity full;
alter table task_assignments replica identity full;
alter table task_submissions replica identity full;
