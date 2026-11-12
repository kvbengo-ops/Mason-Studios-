-- The note that comes with an allowance grant now travels with its notification.
--
-- An approver's note on a request (copied onto allowance_grants.note by
-- decide_allowance_request) and the note on a passed allowance were shown in the
-- profile's grant list but left out of the "Allowance approved" and "Allowance
-- received" notifications. Same logic as 0126's notify_credit_grant; the body
-- gains " Note: <text>" when a note exists, and metadata carries it too. The
-- note lives in the row's text, not looked up at render time, so the live
-- inbox (Realtime INSERT and UPDATE carry only the row) shows it as well.
-- Existing rows keep the text they were written with.

create or replace function public.notify_credit_grant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  note_text text := case
    when nullif(btrim(new.note), '') is null then ''
    else ' Note: ' || btrim(new.note)
  end;
begin
  if new.request_id is not null then
    insert into notifications (
      user_id, kind, title, body, metadata, allowance_request_id, allowance_grant_id
    ) values (
      new.user_id,
      'credit_approved',
      'Allowance approved',
      '$' || to_char(new.amount_usd, 'FM999,999,990.00') || ' added to your weekly allowance.'
        || note_text,
      jsonb_build_object('amount_usd', new.amount_usd, 'note', nullif(btrim(new.note), '')),
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
      'A teammate passed you $' || to_char(new.amount_usd, 'FM999,999,990.00')
        || ' of weekly allowance.' || note_text,
      jsonb_build_object(
        'amount_usd', new.amount_usd,
        'from_user_id', new.transfer_peer_id,
        'note', nullif(btrim(new.note), '')
      ),
      new.id
    ) on conflict do nothing;
  end if;
  return new;
end;
$$;
