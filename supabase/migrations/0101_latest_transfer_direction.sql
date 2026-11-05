-- Display the latest active transfer, independently of the net allowance total.
drop function if exists user_active_grants_usd_by_user(uuid[], timestamptz);

create or replace function user_active_grants_usd_by_user(target_user_ids uuid[], at_ts timestamptz)
returns table(user_id uuid, total_usd numeric, grant_count integer,
  approver_grant_count integer, latest_transfer_amount_usd numeric)
language sql stable security invoker set search_path = public
as $$
  select g.user_id, sum(g.amount_usd), count(*)::integer,
    count(*) filter (where g.transfer_peer_id is null)::integer,
    (array_agg(g.amount_usd order by g.created_at desc, g.id desc)
      filter (where g.transfer_peer_id is not null))[1]
  from allowance_grants g
  where g.user_id = any(target_user_ids)
    and g.expires_at > at_ts
    and g.revoked_at is null
  group by g.user_id;
$$;

comment on function user_active_grants_usd_by_user is
  'Active allowance totals plus the latest active transfer amount for the Users page direction label.';
