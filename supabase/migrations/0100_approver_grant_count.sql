-- =============================================================================
-- 0100 — user_active_grants_usd_by_user also reports how many of those grants
--        an admin can actually end
-- =============================================================================
-- /users' Active grants cell renders an "End grant" button whenever the count
-- is above zero, but endActiveGrants (via revokeActiveGrantsFor,
-- web/lib/allowance-grants.ts) deliberately skips both halves of a pass
-- (0087_pass_allowance.sql): revoking one half alone leaves the other
-- standing and mints the amount into the team pool. An account holding only
-- passed credit therefore showed an enabled button that could only ever match
-- zero rows and come back with "no active grants any more" — a control that
-- reports a stale page when the page was right.
--
-- The count the button needs is not the count the column shows: the column is
-- right to include a pass (it funds renders, so it belongs in the ceiling),
-- and the button is right to ignore one. One extra aggregate column rather
-- than a second function, so the two figures can never be fetched from
-- sources that disagree.
--
-- `transfer_peer_id is null` is the same predicate revokeActiveGrantsFor
-- filters the UPDATE by — exactly "a grant an approver made". Return type
-- changes, so this drops before it creates; create or replace cannot widen a
-- returns table.
-- =============================================================================
drop function if exists user_active_grants_usd_by_user(uuid[], timestamptz);

create or replace function user_active_grants_usd_by_user(target_user_ids uuid[], at_ts timestamptz)
returns table(user_id uuid, total_usd numeric, grant_count integer, approver_grant_count integer)
language sql
stable
security invoker
set search_path = public
as $$
  select
    g.user_id,
    sum(g.amount_usd) as total_usd,
    count(*)::integer as grant_count,
    count(*) filter (where g.transfer_peer_id is null)::integer as approver_grant_count
  from allowance_grants g
  where g.user_id = any(target_user_ids)
    and g.expires_at > at_ts
    and g.revoked_at is null
  group by g.user_id;
$$;

comment on function user_active_grants_usd_by_user is
  'Batched twin of user_active_grants_usd: sum(amount_usd) and count(*) of every ACTIVE '
  '(expires_at > at_ts and revoked_at is null) allowance_grants row, grouped by user_id, for '
  'every id in target_user_ids, plus approver_grant_count — the subset with transfer_peer_id is '
  'null, i.e. the grants an admin revoke can actually end (both halves of a pass are the two '
  'parties'' own business; see web/lib/allowance-grants.ts). Backs web/app/(app)/users/page.tsx''s '
  'Active grants column and whether its End grant button is enabled. A user with no active grants '
  'has no row in the result (plain GROUP BY, no LEFT JOIN against target_user_ids) — callers read '
  'a missing key as $0/0 grants, same contract as every other Map-shaped aggregate in '
  'web/lib/db-aggregates.ts. security invoker, `language sql`, no special grant needed — '
  '0007_grants.sql''s default privileges already cover any function this migration''s role creates.';
