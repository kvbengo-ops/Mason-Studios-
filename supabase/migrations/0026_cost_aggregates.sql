-- =============================================================================
-- SQL-side aggregates for two reads that were doing the sum in application
-- code instead of the database — see docs/architecture.md's cost model and
-- the audit that prompted this migration (.claude/aug-14/SMN-feature-spec.md
-- §3.1/§7 gap analysis).
--
-- ---------------------------------------------------------------------------
-- 1. project_cost_totals (view) — fixes /projects
-- ---------------------------------------------------------------------------
-- The projects list used to embed `scenes ( runs ( cost_usd ) )` for every
-- project on the page just to sum one column in a JS .reduce() (see the old
-- costToDate() in web/app/(app)/projects/page.tsx). Per AGENTS.md, "runs
-- gets a row per attempt, not per success" — so that embed fetched every
-- retry of every scene of every project on the page, every time the list
-- rendered, to produce a single dollar figure per row. This view does the
-- sum where it belongs.
--
-- ---------------------------------------------------------------------------
-- 2. spend_total_usd / spend_totals_by_user (functions) — fixes /spend
-- ---------------------------------------------------------------------------
-- /spend pulled every `runs` row ever, unordered by any limit, into
-- application code and reduced cost_usd in JS to get both the Today/This
-- month tiles and the per-user totals table. PostgREST's own
-- `max_rows = 1000` (supabase/config.toml) caps that select at 1000 rows —
-- silently: no error, no truncation flag, just a query that stops summing
-- the moment the table passes 1000 runs. Every dollar spent by attempt 1001
-- onward (ordered created_at DESC, so this is exactly "every run before
-- some cutoff date", not a random sample) was already missing from every
-- number on that page. These two functions aggregate with SUM()/GROUP BY in
-- Postgres, which has no equivalent cap — correct regardless of table size —
-- and hand back one row per user (or one row, period) instead of one row
-- per run. web/app/(app)/spend/page.tsx also adds a date range on top of
-- this so the underlying "Runs" browse table stays bounded the same way the
-- projects list and Character Library both are now (see this migration's
-- sibling comments there and in web/lib/pagination.ts) — that bound is a
-- pagination concern, not this migration's; nothing here changes because of
-- it.
--
-- ---------------------------------------------------------------------------
-- Both are read through the anon/authenticated-scoped client
-- (web/lib/supabase/server.ts's createClient(), never createAdminClient()) —
-- same client web/app/(app)/projects/page.tsx and spend/page.tsx already
-- read through — so both must keep respecting RLS exactly the way the
-- queries they replace did:
--
--   * project_cost_totals is created `with (security_invoker = true)`
--     (Postgres 15+ — supabase/config.toml pins major_version = 15).
--     Without it, a view runs with ITS OWNER's privileges by default, and
--     the owner here is the migration role, not whoever queries it — an
--     invoker-less view would hand every signed-in user every other user's
--     project costs. security_invoker re-checks runs_select / scenes_select
--     (0002_rls.sql) against the ACTUAL calling role on every query,
--     identically to the embedded select it replaces.
--   * spend_total_usd / spend_totals_by_user are plain `language sql` with
--     no `security definer` — Postgres functions default to SECURITY
--     INVOKER (the opposite default from views), so they already run with
--     the calling role's own RLS without needing an equivalent flag; it is
--     spelled out below anyway to make the choice a decision on record, not
--     a default nobody checked. An admin sees every user's spend the same
--     way admins already do everywhere else (0002_rls.sql's is_admin()
--     read-all policies apply transitively through the join); a non-admin
--     calling either function would only ever see their own runs. /spend
--     itself still gates on isAdmin() in application code first — defence
--     in depth, same as every other admin surface (AGENTS.md: "Every Server
--     Action calls a guard.ts helper first; RLS is the second line, not the
--     first").
--
-- No new grants needed. 0007_grants.sql's `alter default privileges ...
-- grant execute on functions to authenticated` / `... on tables to
-- authenticated` already cover anything this migration's role creates —
-- Postgres treats a view as a "table" for default-privilege purposes, and
-- 0020_characters.sql's header already leaned on this same fact for a plain
-- table. Re-verified live per this repo's "Verifying your work" rule before
-- this migration is applied (AGENTS.md) — NOT done by this agent: per this
-- task's constraints, this migration is written but deliberately not
-- pushed.
--
-- web/types/db.ts (hand-maintained, regenerated from `supabase gen types`
-- and then hand-patched — see its own "Hand-maintained enum aliases"
-- header) does NOT know about either of these yet; it is owned by another
-- agent while this migration is in flight, so it is not hand-edited here.
-- web/lib/db-aggregates.ts carries a local, structural extension of
-- `Database` that stands in until someone regenerates db.ts and folds a
-- real `project_cost_totals` view entry and `spend_total_usd` /
-- `spend_totals_by_user` function entries into it — see that file's header
-- for the exact patch and why it's scoped to one file instead of a cast at
-- every call site.
-- =============================================================================

create view project_cost_totals
with (security_invoker = true) as
select
  s.project_id,
  coalesce(sum(r.cost_usd), 0) as total_cost_usd
from scenes s
join runs r on r.scene_id = s.id
group by s.project_id;

comment on view project_cost_totals is
  'Per-project sum of runs.cost_usd, computed in SQL instead of embedding every run app-side — see '
  'this migration''s header. A project with zero runs has no row here at all (inner join): callers '
  'read a missing project_id as $0, not as an error (web/lib/db-aggregates.ts getProjectCostTotals).';

create or replace function spend_total_usd(from_ts timestamptz, to_ts timestamptz)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(r.cost_usd), 0)
  from runs r
  where r.created_at >= from_ts and r.created_at < to_ts;
$$;

comment on function spend_total_usd is
  'Total cost_usd for runs created in [from_ts, to_ts). Replaces summing an unbounded, max_rows-'
  'capped select in application code (see this migration''s header) — backs /spend''s Today and '
  'This month tiles.';

create or replace function spend_totals_by_user(from_ts timestamptz, to_ts timestamptz)
returns table(user_id uuid, email text, total_usd numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select
    p.user_id,
    prof.email,
    coalesce(sum(r.cost_usd), 0) as total_usd
  from runs r
  join scenes s on s.id = r.scene_id
  join projects p on p.id = s.project_id
  left join profiles prof on prof.id = p.user_id
  where r.created_at >= from_ts and r.created_at < to_ts
  group by p.user_id, prof.email
  order by total_usd desc;
$$;

comment on function spend_totals_by_user is
  'Per-user total cost_usd for runs created in [from_ts, to_ts), grouped in SQL. Replaces /spend''s '
  'old in-memory reduce() over an unbounded select — see this migration''s header for the exact bug '
  '(silent under-report past max_rows = 1000 runs).';
