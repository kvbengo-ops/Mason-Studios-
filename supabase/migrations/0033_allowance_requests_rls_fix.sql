-- =============================================================================
-- Two independent fixes discovered by audit against 0032_allowance_requests.sql
-- (the allowance request -> grant workflow), bundled into one migration
-- because both touch that feature's schema and neither is large enough to
-- deserve its own file.
--
-- NOT APPLIED as of this migration being written — same constraint as 0031
-- and 0032: reviewed and staged, not run.
-- =============================================================================

-- =============================================================================
-- 1. allowance_requests_update — close the "rewrite an already-decided
--    request" hole
-- =============================================================================
-- 0032's own comment on this policy claimed the non-admin path was "only to
-- cancel it while it is still pending" — but the `using` clause it shipped
-- with had no `status = 'pending'` predicate, only the `with check` did.
-- `using` gates which EXISTING rows a non-admin may target for an update at
-- all; `with check` only constrains what the NEW row may look like. Without
-- `status = 'pending'` in `using`, a non-admin could PATCH their own row
-- REGARDLESS of its current status — including an already-'approved' one —
-- straight against PostgREST with their own session token, rewriting
-- requested_usd/decision_note and flipping status to 'cancelled'. The grant
-- itself is a separate, append-only table (allowance_grants has no update
-- policy at all) so it survives untouched either way, but the audit trail
-- would then read "cancelled" for a request whose grant is still active —
-- exactly the kind of drift 0032's own "never mutated once written" language
-- for allowance_grants was trying to prevent one table over.
--
-- `alter policy`, not `drop policy` + `create policy` — same object, same
-- privilege, just narrower `using`. Not `create or replace view` anywhere
-- near this: that statement form is unrelated to policies and, per this
-- project's own prior incident, fails outright (SQLSTATE 42P16) the moment
-- a view's column set changes shape, which is not even what's happening
-- here — noted only because that mistake has already cost this project a
-- failed migration once and is worth actively steering away from.
alter policy allowance_requests_update on allowance_requests
  using (is_admin() or (user_id = auth.uid() and status = 'pending'))
  with check (
    is_admin()
    or (user_id = auth.uid() and status = 'cancelled')
  );

comment on policy allowance_requests_update on allowance_requests is
  'Two different actors, two different allowed transitions, one policy: an admin (is_admin()) may '
  'update any row to any legal state — that is decideAllowanceRequest''s whole job. A non-admin may '
  'target only their OWN row, and only while it is still ''pending'' (using) — the with check then '
  're-confirms the new row is still theirs and now ''cancelled''. Both halves of the transition are '
  'now gated on status: `using`''s `status = ''pending''` stops a non-admin from even selecting an '
  'already-decided row as an update target (closing the hole this migration fixes — see this '
  'migration''s header), and `with check`''s `status = ''cancelled''` stops the one remaining '
  'transition from becoming anything other than a cancellation. They may not approve/deny their own '
  'request, and may not touch anyone else''s row.';

-- =============================================================================
-- 2. user_active_grants_usd_by_user — bounded, batched per-user active-grants
--    totals for /users (web/app/(app)/users/page.tsx)
-- =============================================================================
-- /users was summing allowance_grants.amount_usd in JAVASCRIPT after an
-- unbounded `.from("allowance_grants").select("user_id, amount_usd")
-- .in(userIds).gt("expires_at", nowIso)` — no `.limit()`. PostgREST's
-- `max_rows = 1000` (supabase/config.toml) silently truncates a result past
-- that count, exactly the /spend under-reporting bug 0026_cost_aggregates.sql
-- was written to eliminate, and web/lib/spend.ts's own file header cites as
-- the standing reason this schema never fetches-and-reduces dollar sums in
-- application code. A page of 10-50 users each with a handful of grants
-- stays comfortably under 1000 rows today, but "stays under today" is
-- exactly the property that silently stops being true and then silently
-- under-reports, which is the whole reason this codebase's convention is
-- SUM()/GROUP BY in Postgres (no row cap to cross) rather than trusting a
-- fetch to stay small forever.
--
-- Enforcement (lib/spend.ts's getActiveGrantsUsd, via user_active_grants_usd,
-- ONE user at a time) and this display path were also two different queries
-- computing what should be the same number — /users' JS reduce and
-- user_active_grants_usd's SQL sum diverge the moment either one has a bug,
-- since nothing forces them to agree. This function is user_active_grants_usd
-- (0032_allowance_requests.sql) widened to take an ARRAY of user ids and
-- GROUP BY, rather than a second, independently-written aggregate — same
-- WHERE clause, same expiry semantics (`expires_at > at_ts`), just batched
-- for a page instead of called once per row.
create or replace function user_active_grants_usd_by_user(target_user_ids uuid[], at_ts timestamptz)
returns table(user_id uuid, total_usd numeric, grant_count integer)
language sql
stable
security invoker
set search_path = public
as $$
  select g.user_id, sum(g.amount_usd) as total_usd, count(*)::integer as grant_count
  from allowance_grants g
  where g.user_id = any(target_user_ids)
    and g.expires_at > at_ts
  group by g.user_id;
$$;

comment on function user_active_grants_usd_by_user is
  'Batched twin of user_active_grants_usd: sum(amount_usd) and count(*) of every unexpired '
  '(expires_at > at_ts) allowance_grants row, grouped by user_id, for every id in target_user_ids. '
  'Backs web/app/(app)/users/page.tsx''s Active grants column — replaces an unbounded fetch-and- '
  'reduce in JS that silently truncated past PostgREST''s max_rows = 1000 (supabase/config.toml). '
  'A user with no active grants has no row in the result (plain GROUP BY, no LEFT JOIN against '
  'target_user_ids) — callers read a missing key as $0/0 grants, same contract as every other '
  'Map-shaped aggregate in web/lib/db-aggregates.ts. security invoker, `language sql`, no special '
  'grant needed — 0007_grants.sql''s default privileges already cover any function this migration''s '
  'role creates, same as user_active_grants_usd.';

-- No new grants needed beyond what 0007_grants.sql's default privileges
-- already cover for this role's functions — same note every migration since
-- 0026 has relied on.
-- =============================================================================
