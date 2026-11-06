-- Two editor-facing inbox events:
--
--   credit_denied   — a request now always ends in the requester's inbox,
--                     approved (credit_approved, 0102) OR denied (this).
--   credit_limits_changed — an admin changed this editor's weekly, daily or hourly
--                     limit (per account, or in bulk from Spending limits).
--
-- Same rule as 0102: triggers on the source tables are the only writers.

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'scene_completed', 'credit_requested', 'credit_approved', 'credit_received', 'credit_sent',
  'credit_renewed', 'credit_denied', 'credit_limits_changed',
  'task_assigned', 'task_submitted', 'task_changes_requested', 'task_completed', 'task_cancelled',
  'image_queued', 'image_generating', 'image_completed', 'image_failed', 'image_billing_unknown'
));

alter table public.notifications drop constraint notifications_source_check;
alter table public.notifications add constraint notifications_source_check check (
  (kind = 'scene_completed' and scene_id is not null and allowance_request_id is null and allowance_grant_id is null and task_id is null and task_assignment_id is null)
  or (kind in ('credit_requested', 'credit_denied') and scene_id is null and allowance_request_id is not null and allowance_grant_id is null and task_id is null and task_assignment_id is null)
  or (kind = 'credit_approved' and scene_id is null and allowance_request_id is not null and allowance_grant_id is not null and task_id is null and task_assignment_id is null)
  or (kind in ('credit_received', 'credit_sent') and scene_id is null and allowance_request_id is null and allowance_grant_id is not null and task_id is null and task_assignment_id is null)
  or (kind in ('credit_renewed', 'credit_limits_changed') and scene_id is null and allowance_request_id is null and allowance_grant_id is null and task_id is null and task_assignment_id is null)
  or (kind in ('task_assigned', 'task_submitted', 'task_changes_requested', 'task_completed', 'task_cancelled') and scene_id is null and allowance_request_id is null and allowance_grant_id is null and task_id is not null and task_assignment_id is not null)
  or (kind in ('image_queued', 'image_generating', 'image_completed', 'image_failed', 'image_billing_unknown') and scene_id is null and allowance_request_id is null and allowance_grant_id is null and task_id is null and task_assignment_id is null and coalesce(jsonb_typeof(metadata->'run_id') = 'string', false))
);

create unique index notifications_credit_denied_once_idx
  on public.notifications (user_id, kind, allowance_request_id)
  where kind = 'credit_denied';

-- ── credit_denied ──────────────────────────────────────────────────────────
create or replace function public.notify_credit_denied()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status <> 'pending' or new.status <> 'denied' then
    return new;
  end if;

  insert into public.notifications (user_id, kind, title, body, metadata, allowance_request_id)
  values (
    new.user_id,
    'credit_denied',
    'Credit request denied',
    case
      when nullif(btrim(new.decision_note), '') is null
        then 'Your weekly credit request was denied.'
      else 'Your weekly credit request was denied: ' || btrim(new.decision_note)
    end,
    jsonb_build_object('requested_usd', new.requested_usd),
    new.id
  ) on conflict do nothing;
  return new;
end;
$$;

revoke all on function public.notify_credit_denied() from public, anon, authenticated;

create trigger allowance_requests_notify_credit_denied
after update of status on public.allowance_requests
for each row execute function public.notify_credit_denied();

-- ── limits_changed ─────────────────────────────────────────────────────────
-- One Save in Spending limits writes weekly, daily and hourly as three
-- separate UPDATEs. Rather than three inbox items, a change within two
-- minutes of an UNREAD credit_limits_changed folds into it (latest values win).
create or replace function public.notify_limits_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  limits_body text;
  limits_meta jsonb;
  recent_id uuid;
begin
  if new.weekly_cap_override_usd is not distinct from old.weekly_cap_override_usd
     and new.daily_cap_override_usd is not distinct from old.daily_cap_override_usd
     and new.hourly_cap_override_usd is not distinct from old.hourly_cap_override_usd then
    return new;
  end if;
  -- Editors only: an admin's own limits are not an inbox event.
  if new.role not in ('editor', 'trusted_editor') then
    return new;
  end if;

  -- Credits at 200 per dollar (docs/spend-model.md). NULL weekly/daily means
  -- the role default applies; NULL hourly means no hourly cap.
  limits_body := format(
    'Weekly: %s · Daily: %s · Hourly: %s',
    coalesce(to_char(round(new.weekly_cap_override_usd * 200), 'FM999,999,990') || ' cr', 'role default'),
    coalesce(to_char(round(new.daily_cap_override_usd * 200), 'FM999,999,990') || ' cr', 'role default'),
    coalesce(to_char(round(new.hourly_cap_override_usd * 200), 'FM999,999,990') || ' cr', 'none')
  );
  limits_meta := jsonb_build_object(
    'weekly_usd', new.weekly_cap_override_usd,
    'daily_usd', new.daily_cap_override_usd,
    'hourly_usd', new.hourly_cap_override_usd
  );

  select id into recent_id
    from public.notifications
   where user_id = new.id
     and kind = 'credit_limits_changed'
     and read_at is null
     and created_at > now() - interval '2 minutes'
   order by created_at desc
   limit 1;

  if recent_id is not null then
    update public.notifications
       set body = limits_body, metadata = limits_meta
     where id = recent_id;
  else
    insert into public.notifications (user_id, kind, title, body, metadata)
    values (new.id, 'credit_limits_changed', 'Your spending limits changed', limits_body, limits_meta);
  end if;
  return new;
end;
$$;

revoke all on function public.notify_limits_changed() from public, anon, authenticated;

create trigger profiles_notify_limits_changed
after update of weekly_cap_override_usd, daily_cap_override_usd, hourly_cap_override_usd
on public.profiles
for each row execute function public.notify_limits_changed();
