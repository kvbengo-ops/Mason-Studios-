-- Credit allowance periods renew on Monday 00:00 in Asia/Manila. The
-- production worker checks this idempotent function every five minutes;
-- leave queued/generating image progress to the Runs panel.
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'scene_completed', 'credit_requested', 'credit_approved', 'credit_received', 'credit_sent',
  'credit_renewed',
  'task_assigned', 'task_submitted', 'task_changes_requested', 'task_completed', 'task_cancelled',
  'image_queued', 'image_generating', 'image_completed', 'image_failed', 'image_billing_unknown'
));

alter table public.notifications drop constraint notifications_source_check;
alter table public.notifications add constraint notifications_source_check check (
  (kind = 'scene_completed' and scene_id is not null and allowance_request_id is null and allowance_grant_id is null and task_id is null and task_assignment_id is null)
  or (kind = 'credit_requested' and scene_id is null and allowance_request_id is not null and allowance_grant_id is null and task_id is null and task_assignment_id is null)
  or (kind = 'credit_approved' and scene_id is null and allowance_request_id is not null and allowance_grant_id is not null and task_id is null and task_assignment_id is null)
  or (kind in ('credit_received', 'credit_sent') and scene_id is null and allowance_request_id is null and allowance_grant_id is not null and task_id is null and task_assignment_id is null)
  or (kind = 'credit_renewed' and scene_id is null and allowance_request_id is null and allowance_grant_id is null and task_id is null and task_assignment_id is null)
  or (kind in ('task_assigned', 'task_submitted', 'task_changes_requested', 'task_completed', 'task_cancelled') and scene_id is null and allowance_request_id is null and allowance_grant_id is null and task_id is not null and task_assignment_id is not null)
  or (kind in ('image_queued', 'image_generating', 'image_completed', 'image_failed', 'image_billing_unknown') and scene_id is null and allowance_request_id is null and allowance_grant_id is null and task_id is null and task_assignment_id is null and coalesce(jsonb_typeof(metadata->'run_id') = 'string', false))
);

create unique index notifications_credit_renewed_once_idx
  on public.notifications (user_id, (metadata->>'week_start'))
  where kind = 'credit_renewed';

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
    'Weekly credit period reset',
    'Your weekly spending period has reset. Check your profile menu for the available allowance.',
    jsonb_build_object('week_start', week_start::text)
  from public.profiles p
  where p.status = 'active'
    and p.role in ('editor', 'trusted_editor', 'admin')
  on conflict do nothing;
end;
$$;

revoke all on function public.notify_weekly_credit_renewal() from public, anon, authenticated;

-- Progress is already visible in the Runs panel. Only terminal outcomes
-- produce an inbox item, avoiding queued + generating + complete triplets.
create or replace function public.notify_image_attempt() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  event_kind text;
  event_title text;
  event_body text;
begin
  if new.idempotency_key is null or new.user_id is null or new.settled_at is null then
    return new;
  end if;

  if new.error like 'billing-unknown:%' then
    event_kind := 'image_billing_unknown'; event_title := 'Image needs a status check';
    event_body := 'The generation outcome is uncertain. Check its status before generating again.';
  elsif new.error is not null then
    event_kind := 'image_failed'; event_title := 'Image generation failed';
    event_body := 'Open the image generator to review the failed attempt.';
  elsif new.asset_id is not null then
    event_kind := 'image_completed'; event_title := 'Image ready';
    event_body := 'Your generated image is saved and ready to view.';
  else
    return new;
  end if;

  insert into public.notifications (user_id, kind, title, body, metadata)
  values (new.user_id, event_kind, event_title, event_body,
    jsonb_build_object('run_id', new.id, 'project_id', new.project_id, 'asset_id', new.asset_id))
  on conflict do nothing;
  return new;
end;
$$;

revoke all on function public.notify_image_attempt() from public, anon, authenticated;
