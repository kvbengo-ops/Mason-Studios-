-- =============================================================================
-- user_directory (view) — makes the /users admin list's Projects and Spend
-- columns sortable server-side (web/app/(app)/users/page.tsx).
--
-- ---------------------------------------------------------------------------
-- The problem this exists to avoid
-- ---------------------------------------------------------------------------
-- /users pages through `profiles` with `.range()`, then — for only the users
-- on that one page — fetches project counts from user_project_counts
-- (0027_user_project_counts.sql) and spend totals from spend_totals_by_user
-- (0026_cost_aggregates.sql). That's the right shape for DISPLAYING an
-- aggregate next to a page of profiles: bounded, O(1) round trips regardless
-- of table size. It is the WRONG shape for SORTING by that aggregate — the
-- page of profiles is already decided (by created_at, or whatever `profiles`
-- was ordered by) before either aggregate is even fetched. "Sort by spend"
-- built on top of that sequence could only reorder the 20 rows already on
-- screen, which looks exactly like a real sort while quietly answering a
-- different question — an admin scanning for the biggest spender across the
-- whole user base would read "the biggest spender on this page," silently.
--
-- Ordering by an aggregate that lives in a different relation than the one
-- being paged requires the aggregate to be in the SAME query that does the
-- ORDER BY + LIMIT/OFFSET, so Postgres picks the correct 20 rows out of the
-- full set before either the page or the aggregate is fixed. This view is
-- that single relation: profiles LEFT JOINed to both aggregates, so
-- /users can `.from("user_directory").select(...).order(...).range(...)`
-- once and get a page that is correct for the full user base under any of
-- the six sortable columns (email, username, role, joined, project_count,
-- spend_usd), not just the three that already lived on `profiles`.
--
-- ---------------------------------------------------------------------------
-- LEFT JOIN + COALESCE, not the sibling views' "absence means zero" contract
-- ---------------------------------------------------------------------------
-- user_project_counts and project_cost_totals (0026/0027) both intentionally
-- have NO row for a user/project with nothing to aggregate — a plain
-- GROUP BY / inner JOIN, documented on each as "callers read a missing key
-- as zero, not as an error." That contract is correct for THEIR callers,
-- which already have the full row list (a page of profiles, a page of
-- projects) from somewhere else and are only filling in one column.
--
-- It would be exactly the bug this view exists to fix if repeated here: a
-- user with zero projects and zero spend is precisely the user an admin
-- most wants to find by sorting spend ascending — and an INNER join (or a
-- plain, un-COALESCEd LEFT join) would either drop that row from the result
-- entirely or leave project_count/spend_usd NULL, which sorts before or
-- after every real number depending on NULLS FIRST/LAST and answers a
-- question nobody asked. This view LEFT JOINs both aggregates from
-- `profiles` (so every profile is present regardless of activity) and
-- COALESCEs each to 0, so that user sorts as an ordinary 0, not as absent.
--
-- The two subqueries below duplicate user_project_counts'/spend_totals_by_
-- user's own GROUP BY logic rather than re-querying those relations, to
-- keep this view a single self-contained query plan instead of a view
-- selecting from views (correct under security_invoker either way, since
-- Postgres re-checks RLS at every level for the querying role, but a flat
-- query is one less thing to trace when reading this file next to 0026/0027).
-- spend_usd here is intentionally the all-time total (no from_ts/to_ts
-- window) — that's what /users' "Spend to date" column has always shown
-- (see its own page.tsx comment on the epoch-to-tomorrow range it used to
-- compute the same number); a view can't take query parameters, and an
-- unbounded upper edge is a no-op anyway since `runs.created_at` is never in
-- the future.
--
-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- `with (security_invoker = true)` for the same reason 0026's and 0027's
-- views needed it (Postgres 15+ — supabase/config.toml pins
-- major_version = 15): a view defaults to running with its OWNER's
-- privileges, not the querying role's. /users reads through the session
-- client (web/lib/supabase/server.ts's createClient(), never
-- createAdminClient()), so without security_invoker this view would ignore
-- RLS and hand back every user's directory row to whoever queries it.
-- security_invoker re-checks profiles_select_admin / projects_select /
-- scenes_select / runs_select (0002_rls.sql) against the actual calling
-- role on every query — an admin (the only role /users' requireAdmin() gate
-- lets reach this page at all) sees every user's row, transitively, the
-- same way admins already see every user's spend via spend_totals_by_user
-- and every project via /projects' own owner column. /users itself still
-- gates on requireAdmin() in application code first — defence in depth,
-- same as every other admin surface (AGENTS.md: "Every Server Action calls
-- a guard.ts helper first; RLS is the second line, not the first").
--
-- No new grants needed — 0007_grants.sql's `alter default privileges ...
-- grant ... on tables to authenticated` already covers anything this
-- migration's role creates, the same fact 0026's and 0027's headers leaned
-- on before it.
--
-- Per this task's constraints, this migration is written but deliberately
-- NOT applied. web/types/db.ts is hand-patched to describe this view's
-- shape ahead of that application — see that file's own header for the
-- general policy on hand-patching, and this view's entry there for the
-- exact patch.
-- =============================================================================

create view user_directory
with (security_invoker = true) as
select
  p.id,
  p.email,
  p.username,
  p.role,
  p.created_at,
  coalesce(counts.project_count, 0) as project_count,
  coalesce(spend.spend_usd, 0) as spend_usd
from profiles p
left join (
  select user_id, count(*) as project_count
  from projects
  group by user_id
) counts on counts.user_id = p.id
left join (
  select pr.user_id, coalesce(sum(r.cost_usd), 0) as spend_usd
  from runs r
  join scenes s on s.id = r.scene_id
  join projects pr on pr.id = s.project_id
  group by pr.user_id
) spend on spend.user_id = p.id;

comment on view user_directory is
  'profiles LEFT JOINed to per-user project counts and all-time spend, both computed in SQL, so the '
  '/users admin list can ORDER BY an aggregate that lives in a different relation without first '
  'fetching a page of profiles and reordering only what happened to be on it — see this migration''s '
  'header. LEFT JOIN + COALESCE(...,0), NOT the inner-join "absence means zero, no row" contract '
  'user_project_counts/project_cost_totals use standalone: a user with zero projects and zero spend '
  'MUST still appear as a 0/0 row here, or ORDER BY project_count/spend_usd would silently drop '
  'exactly the users an admin most wants to find.';
