-- Notifications speak dollars, not kie credits.
--
-- Credits (200 per $1) were kie's unit. With BytePlus billing per token, the
-- app shows USD everywhere, so the five functions that write notification text
-- are redefined here with the same logic and new wording. Existing rows keep
-- the text they were written with.

create or replace function public.notify_credit_requested()
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
    'Allowance request pending',
    'A teammate requested more weekly allowance.',
    jsonb_build_object('requested_usd', new.requested_usd, 'requester_id', new.user_id),
    new.id
  from profiles p
  where p.id <> new.user_id
    and (p.role = 'admin' or (p.role = 'trusted_editor' and p.status = 'active'))
  on conflict do nothing;
  return new;
end;
$$;

create or replace function public.notify_credit_grant()
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
      'Allowance approved',
      '$' || to_char(new.amount_usd, 'FM999,999,990.00') || ' added to your weekly allowance.',
      jsonb_build_object('amount_usd', new.amount_usd),
      new.request_id,
      new.id
    ) on conflict do nothing;
  elsif new.transfer_peer_id is not null and new.amount_usd > 0 then
    -- pass_allowance writes one positive recipient row and one negative
    -- sender row. Only the positive row is a received notification.
    insert into notifications (user_id, kind, title, body, metadata, allowance_grant_id)
    values (
      new.user_id,
      'credit_received',
      'Allowance received',
      'A teammate passed you $' || to_char(new.amount_usd, 'FM999,999,990.00') || ' of weekly allowance.',
      jsonb_build_object('amount_usd', new.amount_usd, 'from_user_id', new.transfer_peer_id),
      new.id
    ) on conflict do nothing;
  end if;
  return new;
end;
$$;

create or replace function public.notify_weekly_credit_renewal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  week_start date;
begin
  week_start := date_trunc('week', now() at time zone 'Asia/Manila')::date;

  insert into public.notifications (user_id, kind, title, body, metadata)
  select
    p.id,
    'credit_renewed',
    'Weekly allowance reset',
    'Your weekly spending period has reset. Check your profile menu for the available allowance.',
    jsonb_build_object('week_start', week_start::text)
  from public.profiles p
  where p.status = 'active'
    and p.role in ('editor', 'trusted_editor', 'admin')
  on conflict do nothing;
end;
$$;

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
    'Allowance request denied',
    case
      when nullif(btrim(new.decision_note), '') is null
        then 'Your weekly allowance request was denied.'
      else 'Your weekly allowance request was denied: ' || btrim(new.decision_note)
    end,
    jsonb_build_object('requested_usd', new.requested_usd),
    new.id
  ) on conflict do nothing;
  return new;
end;
$$;

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

  -- NULL weekly/daily means the role default applies; NULL hourly means no hourly cap.
  limits_body := format(
    'Weekly: %s · Daily: %s · Hourly: %s',
    coalesce('$' || to_char(new.weekly_cap_override_usd, 'FM999,999,990.00'), 'role default'),
    coalesce('$' || to_char(new.daily_cap_override_usd, 'FM999,999,990.00'), 'role default'),
    coalesce('$' || to_char(new.hourly_cap_override_usd, 'FM999,999,990.00'), 'none')
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
