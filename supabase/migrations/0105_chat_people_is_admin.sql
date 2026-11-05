-- chat_people() gains is_admin so the inbox can badge admins the way its
-- Discord reference does. Return-column changes need drop+recreate: Postgres
-- rejects `create or replace function` when the output row shape changes.
drop function chat_people();

create function chat_people()
returns table (
  user_id uuid,
  username text,
  avatar_storage_key text,
  conversation_id uuid,
  last_message_body text,
  last_message_at timestamptz,
  last_message_sender_id uuid,
  unread_count integer,
  is_admin boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select
    p.id,
    p.username,
    p.avatar_storage_key,
    c.id,
    latest.body,
    latest.created_at,
    latest.sender_id,
    coalesce((
      select count(*)::integer
      from chat_messages unread
      where unread.conversation_id = c.id
        and unread.sender_id <> auth.uid()
        and (
          r.user_id is null
          or (unread.created_at, unread.id) > (r.last_read_at, r.last_read_message_id)
        )
    ), 0),
    p.role = 'admin'
  from profiles p
  left join chat_conversations c
    on c.user_low_id = least(auth.uid(), p.id)
   and c.user_high_id = greatest(auth.uid(), p.id)
  left join chat_read_states r
    on r.conversation_id = c.id
   and r.user_id = auth.uid()
  left join lateral (
    select m.body, m.created_at, m.sender_id
    from chat_messages m
    where m.conversation_id = c.id
    order by m.created_at desc, m.id desc
    limit 1
  ) latest on true
  where is_active()
    and p.id <> auth.uid()
    and (p.role = 'admin' or p.status = 'active')
  order by latest.created_at desc nulls last, p.username;
$$;

revoke all on function chat_people() from public, anon;
grant execute on function chat_people() to authenticated;
