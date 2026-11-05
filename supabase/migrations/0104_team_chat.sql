-- Private, one-to-one chat. Conversations store a canonical pair (low/high
-- UUID) so two simultaneous first messages cannot create duplicate threads.
-- Presence is ephemeral in Supabase Realtime; only durable messages and
-- per-account read cursors live in Postgres.

create table chat_conversations (
  id uuid primary key default gen_random_uuid(),
  user_low_id uuid not null references profiles(id) on delete cascade,
  user_high_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz,
  check (user_low_id < user_high_id),
  unique (user_low_id, user_high_id)
);

create index chat_conversations_low_recent_idx
  on chat_conversations (user_low_id, last_message_at desc nulls last);
create index chat_conversations_high_recent_idx
  on chat_conversations (user_high_id, last_message_at desc nulls last);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references chat_conversations(id) on delete cascade,
  sender_id uuid not null references profiles(id) on delete cascade,
  sender_name text not null,
  body text not null,
  created_at timestamptz not null default now(),
  check (char_length(sender_name) between 1 and 80),
  check (char_length(body) between 1 and 2000)
);

create index chat_messages_conversation_cursor_idx
  on chat_messages (conversation_id, created_at desc, id desc);
create index chat_messages_sender_rate_idx
  on chat_messages (sender_id, created_at desc);

create table chat_read_states (
  conversation_id uuid not null references chat_conversations(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  last_read_message_id uuid not null default '00000000-0000-0000-0000-000000000000',
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

alter table chat_conversations enable row level security;
alter table chat_messages enable row level security;
alter table chat_read_states enable row level security;

-- One authorization seam for every conversation read and RPC. A future
-- block/mute policy can tighten this function without rewriting each caller.
create or replace function can_access_chat_conversation(target_conversation_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select is_active() and exists (
    select 1
    from chat_conversations c
    where c.id = target_conversation_id
      and auth.uid() in (c.user_low_id, c.user_high_id)
  );
$$;

create policy chat_conversations_select_own on chat_conversations
  for select to authenticated
  using (can_access_chat_conversation(id));

create policy chat_messages_select_own_conversation on chat_messages
  for select to authenticated
  using (can_access_chat_conversation(conversation_id));

create policy chat_read_states_select_own on chat_read_states
  for select to authenticated
  using (user_id = auth.uid() and can_access_chat_conversation(conversation_id));

-- No direct table writes. RPCs derive the caller from auth.uid(), choose the
-- canonical participant pair, and own read-cursor changes.
revoke all on table chat_conversations, chat_messages, chat_read_states
  from anon, authenticated;
grant select on table chat_conversations, chat_messages, chat_read_states
  to authenticated;

-- Fixed projection of the active people directory plus the caller's own
-- conversation preview/read count. This does not widen profiles_select_admin.
-- The result is one compact row per colleague: 100+ accounts remain one DB
-- round trip, while message bodies themselves stay cursor-paginated.
create or replace function chat_people()
returns table (
  user_id uuid,
  username text,
  avatar_storage_key text,
  conversation_id uuid,
  last_message_body text,
  last_message_at timestamptz,
  last_message_sender_id uuid,
  unread_count integer
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
    ), 0)
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

create or replace function send_direct_chat_message(p_recipient_id uuid, p_body text)
returns table (
  id uuid,
  conversation_id uuid,
  sender_id uuid,
  sender_name text,
  body text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  sender profiles%rowtype;
  recipient profiles%rowtype;
  thread_id uuid;
  clean_body text := btrim(p_body);
  sent_at timestamptz;
  sent_id uuid;
begin
  select * into sender from profiles where profiles.id = auth.uid();
  select * into recipient from profiles where profiles.id = p_recipient_id;

  if sender.id is null or not is_active() then
    raise exception 'chat access denied';
  end if;
  if recipient.id is null
     or recipient.id = sender.id
     or not (recipient.role = 'admin' or recipient.status = 'active') then
    raise exception 'chat recipient unavailable';
  end if;
  if char_length(clean_body) < 1 or char_length(clean_body) > 2000 then
    raise exception 'message must contain between 1 and 2000 characters';
  end if;
  if (
    select count(*)
    from chat_messages recent
    where recent.sender_id = sender.id
      and recent.created_at >= now() - interval '10 seconds'
  ) >= 8 then
    raise exception 'too many messages; wait a moment and try again';
  end if;

  insert into chat_conversations (user_low_id, user_high_id)
  values (least(sender.id, recipient.id), greatest(sender.id, recipient.id))
  on conflict (user_low_id, user_high_id) do update
    set user_low_id = excluded.user_low_id
  returning chat_conversations.id into thread_id;

  insert into chat_read_states (conversation_id, user_id, last_read_at)
  values (thread_id, sender.id, now()), (thread_id, recipient.id, now())
  on conflict on constraint chat_read_states_pkey do nothing;

  insert into chat_messages (conversation_id, sender_id, sender_name, body)
  values (thread_id, sender.id, sender.username, clean_body)
  returning chat_messages.id, chat_messages.created_at into sent_id, sent_at;

  update chat_conversations
  set last_message_at = sent_at
  where chat_conversations.id = thread_id;

  update chat_read_states
  set last_read_at = sent_at,
      last_read_message_id = sent_id,
      updated_at = now()
  where chat_read_states.conversation_id = thread_id
    and chat_read_states.user_id = sender.id;

  return query
  select sent_id, thread_id, sender.id, sender.username, clean_body, sent_at;
end;
$$;

create or replace function mark_direct_chat_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  latest_at timestamptz;
  latest_id uuid;
begin
  if not can_access_chat_conversation(p_conversation_id) then
    raise exception 'chat access denied';
  end if;

  select m.created_at, m.id into latest_at, latest_id
  from chat_messages m
  where m.conversation_id = p_conversation_id
  order by m.created_at desc, m.id desc
  limit 1;

  insert into chat_read_states (
    conversation_id, user_id, last_read_at, last_read_message_id, updated_at
  ) values (
    p_conversation_id,
    auth.uid(),
    coalesce(latest_at, now()),
    coalesce(latest_id, '00000000-0000-0000-0000-000000000000'::uuid),
    now()
  )
  on conflict (conversation_id, user_id) do update
    set last_read_at = excluded.last_read_at,
        last_read_message_id = excluded.last_read_message_id,
        updated_at = excluded.updated_at;
end;
$$;

create or replace function direct_chat_unread_count()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select case when not is_active() then 0 else coalesce(sum(person.unread_count), 0)::integer end
  from chat_people() person;
$$;

revoke all on function can_access_chat_conversation(uuid) from public, anon;
revoke all on function chat_people() from public, anon;
revoke all on function send_direct_chat_message(uuid, text) from public, anon;
revoke all on function mark_direct_chat_read(uuid) from public, anon;
revoke all on function direct_chat_unread_count() from public, anon;
grant execute on function can_access_chat_conversation(uuid) to authenticated;
grant execute on function chat_people() to authenticated;
grant execute on function send_direct_chat_message(uuid, text) to authenticated;
grant execute on function mark_direct_chat_read(uuid) to authenticated;
grant execute on function direct_chat_unread_count() to authenticated;

-- One RLS-filtered change stream for every signed-in account, regardless of
-- whether the directory holds ten people or hundreds. Presence likewise uses
-- one shared channel; no per-user subscriptions are needed.
alter publication supabase_realtime add table chat_messages;
alter table chat_messages replica identity full;
