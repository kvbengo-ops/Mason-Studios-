-- Retain personal generated images and their run links until explicitly purged.
alter table assets add column deleted_at timestamptz;
create index assets_personal_bin_idx on assets (user_id, deleted_at desc)
  where deleted_at is not null and kind = 'generated_image';

create function manage_personal_image(p_asset_id uuid, p_operation text)
returns text language plpgsql security definer set search_path = public as $$
declare
  image assets%rowtype;
begin
  if not exists (select 1 from profiles where id = auth.uid() and status = 'active') then
    raise exception 'active account required';
  end if;
  select * into image from assets where id = p_asset_id and user_id = auth.uid()
    and project_id is null and kind = 'generated_image' for update;
  if not found then raise exception 'image unavailable'; end if;
  if p_operation = 'trash' then
    update assets set deleted_at = coalesce(deleted_at, now()) where id = image.id;
  elsif p_operation = 'restore' then
    update assets set deleted_at = null where id = image.id;
  elsif p_operation = 'purge' and image.deleted_at is not null then
    delete from assets where id = image.id;
    return image.storage_key;
  else
    raise exception 'invalid image operation';
  end if;
  return null;
end;
$$;
revoke all on function manage_personal_image(uuid, text) from public, anon;
grant execute on function manage_personal_image(uuid, text) to authenticated;

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in (
  'scene_completed', 'credit_requested', 'credit_approved', 'credit_received', 'credit_sent',
  'task_assigned', 'task_submitted', 'task_changes_requested', 'task_completed', 'task_cancelled',
  'image_queued', 'image_generating', 'image_completed', 'image_failed', 'image_billing_unknown'
));
alter table notifications drop constraint notifications_source_check;
alter table notifications add constraint notifications_source_check check (
  (kind = 'scene_completed' and scene_id is not null and allowance_request_id is null and allowance_grant_id is null and task_id is null and task_assignment_id is null)
  or (kind = 'credit_requested' and scene_id is null and allowance_request_id is not null and allowance_grant_id is null and task_id is null and task_assignment_id is null)
  or (kind = 'credit_approved' and scene_id is null and allowance_request_id is not null and allowance_grant_id is not null and task_id is null and task_assignment_id is null)
  or (kind in ('credit_received', 'credit_sent') and scene_id is null and allowance_request_id is null and allowance_grant_id is not null and task_id is null and task_assignment_id is null)
  or (kind in ('task_assigned', 'task_submitted', 'task_changes_requested', 'task_completed', 'task_cancelled') and scene_id is null and allowance_request_id is null and allowance_grant_id is null and task_id is not null and task_assignment_id is not null)
  or (kind in ('image_queued', 'image_generating', 'image_completed', 'image_failed', 'image_billing_unknown') and scene_id is null and allowance_request_id is null and allowance_grant_id is null and task_id is null and task_assignment_id is null and coalesce(jsonb_typeof(metadata->'run_id') = 'string', false))
);
create unique index notifications_credit_sent_once_idx on notifications (user_id, kind, allowance_grant_id) where kind = 'credit_sent';
create unique index notifications_image_event_once_idx on notifications (user_id, kind, (metadata->>'run_id')) where kind like 'image_%';

-- Positive transfer grants already notify recipients through 0102. Observe the
-- matching negative grant to confirm the transfer to the sender atomically.
create function notify_credit_sent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.transfer_peer_id is not null and new.amount_usd < 0 then
    insert into notifications (user_id, kind, title, body, metadata, allowance_grant_id)
    values (new.user_id, 'credit_sent', 'Credits sent', 'Your weekly credits were passed to a teammate.',
      jsonb_build_object('amount_usd', -new.amount_usd, 'to_user_id', new.transfer_peer_id), new.id)
    on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger allowance_grants_notify_credit_sent after insert on allowance_grants
  for each row execute function notify_credit_sent();

-- Observe existing attempt facts; do not write generation state or billing.
-- Completion waits for the saved asset, since settlement precedes storage.
create function notify_image_attempt() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  event_kind text;
  event_title text;
  event_body text;
begin
  if new.idempotency_key is null or new.user_id is null then return new; end if;
  if new.settled_at is null then
    if new.kie_task_id is null then
      event_kind := 'image_queued'; event_title := 'Image queued';
      event_body := 'Your image generation is queued.';
    else
      event_kind := 'image_generating'; event_title := 'Generating image';
      event_body := 'Your image is being generated.';
    end if;
  elsif new.error like 'billing-unknown:%' then
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
  insert into notifications (user_id, kind, title, body, metadata)
  values (new.user_id, event_kind, event_title, event_body,
    jsonb_build_object('run_id', new.id, 'project_id', new.project_id, 'asset_id', new.asset_id))
  on conflict do nothing;
  return new;
end;
$$;
create trigger runs_notify_image_attempt after insert or update of kie_task_id, settled_at, error, asset_id on runs
  for each row execute function notify_image_attempt();
revoke all on function notify_credit_sent(), notify_image_attempt() from public, anon, authenticated;
