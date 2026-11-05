-- Persistent, per-account inbox events. The database owns emission because
-- scene completion is committed by the Go worker while allowance events are
-- committed by SQL functions; neither path should depend on web-to-worker
-- calls or on a best-effort second write after its source transaction.

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  kind text not null check (kind in (
    'scene_completed',
    'credit_requested',
    'credit_approved',
    'credit_received'
  )),
  title text not null,
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  scene_id uuid references scenes(id) on delete cascade,
  allowance_request_id uuid references allowance_requests(id) on delete cascade,
  allowance_grant_id uuid references allowance_grants(id) on delete cascade,
  check (
    (kind = 'scene_completed' and scene_id is not null and allowance_request_id is null and allowance_grant_id is null)
    or (kind = 'credit_requested' and scene_id is null and allowance_request_id is not null and allowance_grant_id is null)
    or (kind = 'credit_approved' and scene_id is null and allowance_request_id is not null and allowance_grant_id is not null)
    or (kind = 'credit_received' and scene_id is null and allowance_request_id is null and allowance_grant_id is not null)
  )
);

comment on table notifications is
  'Persistent per-account inbox events. Rows are emitted transactionally by source-table triggers: scene completion, allowance request, allowance approval and received peer credit. They are not a balance or money ledger.';

create index notifications_user_unread_created_at_idx
  on notifications (user_id, created_at desc)
  where read_at is null;
create index notifications_user_created_at_idx
  on notifications (user_id, created_at desc);

-- Each source transition emits once per recipient. The worker may observe a
-- completion twice; MarkDone itself rejects its second update, and these
-- indexes are a second, durable backstop against a duplicate inbox item.
create unique index notifications_scene_completed_once_idx
  on notifications (user_id, kind, scene_id)
  where kind = 'scene_completed';
create unique index notifications_credit_request_once_idx
  on notifications (user_id, kind, allowance_request_id)
  where kind = 'credit_requested';
create unique index notifications_credit_approved_once_idx
  on notifications (user_id, kind, allowance_grant_id)
  where kind = 'credit_approved';
create unique index notifications_credit_received_once_idx
  on notifications (user_id, kind, allowance_grant_id)
  where kind = 'credit_received';

alter table notifications enable row level security;

-- 0007's default privileges are intentionally broad for authenticated and
-- Supabase-managed local databases may also add table-owner defaults for
-- anon. This inbox needs only one direct privilege: authenticated SELECT,
-- still narrowed to the caller's rows by RLS. Read-state writes go through
-- mark_notifications_read below.
revoke all on table notifications from anon, authenticated;
grant select on table notifications to authenticated;

create policy notifications_select_own on notifications
  for select to authenticated
  using (user_id = auth.uid());

-- There is intentionally no browser INSERT/UPDATE/DELETE policy. Trigger
-- functions are the writers; mark_notifications_read is the sole read-state
-- mutation surface, so a user cannot forge an event or rewrite its metadata.

create or replace function mark_notifications_read(notification_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  update notifications
     set read_at = coalesce(read_at, now())
   where user_id = auth.uid()
     and read_at is null
     and (notification_ids is null or id = any(notification_ids));
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

revoke all on function mark_notifications_read(uuid[]) from public, anon;
grant execute on function mark_notifications_read(uuid[]) to authenticated;

-- New allowance requests are actionable only for admins and active trusted
-- editors (the same actor predicate can_approve_allowance() uses), except
-- the requester: no one is notified to decide their own request.
create or replace function notify_credit_requested()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into notifications (user_id, kind, title, body, metadata, allowance_request_id)
  select
    p.id,
    'credit_requested',
    'Credit request pending',
    'A teammate requested additional weekly credits.',
    jsonb_build_object('requested_usd', new.requested_usd, 'requester_id', new.user_id),
    new.id
  from profiles p
  where p.id <> new.user_id
    and (p.role = 'admin' or (p.role = 'trusted_editor' and p.status = 'active'))
  on conflict do nothing;
  return new;
end;
$$;

create trigger allowance_requests_notify_credit_requested
after insert on allowance_requests
for each row execute function notify_credit_requested();

-- An approval request is a work item, not a permanent alarm. Once another
-- approver decides it (or the requester cancels it), every recipient's copy
-- becomes read and its snapshot says what happened. This prevents a stale
-- "pending" item from continuing to badge other approvers after the request
-- is no longer actionable.
create or replace function resolve_credit_requested_notifications()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status <> 'pending' or new.status = 'pending' then
    return new;
  end if;

  update notifications
     set read_at = coalesce(read_at, now()),
         title = case new.status
           when 'approved' then 'Credit request approved'
           when 'denied' then 'Credit request denied'
           else 'Credit request cancelled'
         end,
         body = case new.status
           when 'approved' then 'Another approver approved this weekly credit request.'
           when 'denied' then 'Another approver denied this weekly credit request.'
           else 'The requester cancelled this weekly credit request.'
         end
   where allowance_request_id = new.id
     and kind = 'credit_requested';
  return new;
end;
$$;

create trigger allowance_requests_resolve_credit_requested
after update of status on allowance_requests
for each row execute function resolve_credit_requested_notifications();

-- A request approval inserts its matching grant in the same transaction.
-- Triggering from that grant rather than the request status records the
-- amount actually granted, which may differ from the amount requested.
create or replace function notify_credit_grant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.request_id is not null then
    insert into notifications (
      user_id, kind, title, body, metadata, allowance_request_id, allowance_grant_id
    ) values (
      new.user_id,
      'credit_approved',
      'Credits approved',
      'Your weekly credit request was approved.',
      jsonb_build_object('amount_usd', new.amount_usd),
      new.request_id,
      new.id
    ) on conflict do nothing;
  elsif new.transfer_peer_id is not null and new.amount_usd > 0 then
    -- pass_allowance writes one positive recipient row and one negative
    -- sender row. Only the positive row is a received-credit notification.
    insert into notifications (user_id, kind, title, body, metadata, allowance_grant_id)
    values (
      new.user_id,
      'credit_received',
      'Credits received',
      'A teammate passed you weekly credits.',
      jsonb_build_object('amount_usd', new.amount_usd, 'from_user_id', new.transfer_peer_id),
      new.id
    ) on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger allowance_grants_notify_credit_grant
after insert on allowance_grants
for each row execute function notify_credit_grant();

-- The worker owns rendering -> done. This trigger observes that transition
-- only; it neither writes scenes nor changes the web/worker status contract.
create or replace function notify_scene_completed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_id uuid;
  project_kind text;
  display_idx integer;
begin
  if old.status <> 'rendering' or new.status <> 'done' then
    return new;
  end if;

  select user_id, kind into owner_id, project_kind from projects where id = new.project_id;
  if owner_id is null then
    raise exception 'notify_scene_completed: project % has no owner', new.project_id;
  end if;
  display_idx := case when project_kind = 'clip' then new.idx else new.idx + 1 end;

  insert into notifications (user_id, kind, title, body, metadata, scene_id)
  values (
    owner_id,
    'scene_completed',
    'Scene completed',
    format('Scene %s is ready to review.', display_idx),
    jsonb_build_object(
      'project_id', new.project_id,
      'project_kind', project_kind,
      'scene_index', display_idx
    ),
    new.id
  ) on conflict do nothing;
  return new;
end;
$$;

create trigger scenes_notify_scene_completed
after update of status on scenes
for each row execute function notify_scene_completed();

-- The inbox can update live just as scenes render progress does. Full replica
-- identity lets a future per-user Realtime filter evaluate user_id on UPDATE.
alter publication supabase_realtime add table notifications;
alter table notifications replica identity full;
