-- =============================================================================
-- Account roles and per-account spend allowances
-- (docs/Account_Usage_and_Cost_Control_Plan_Proposal.md, phases 1 & 2 —
-- phase 3, the approval workflow, is explicitly NOT part of this migration;
-- nothing here should make it harder to add later).
--
-- NOT APPLIED as of this migration being written — per this change's own
-- constraints, it is reviewed and staged, not run. Applying it, backfilling
-- nothing (see "no backfill" below), and wiring render.yaml's new env vars
-- (web/lib/spend.ts) are follow-up steps for whoever ships this.
--
-- =============================================================================
-- 1. Roles: editor / trusted_editor / admin — no new visibility tier
-- =============================================================================
-- profiles.role (0001_init.sql) is a CHECK-constrained text column, not a
-- Postgres enum (0012_render_settings.sql's header explains why this schema
-- uses CHECK for every "enum-ish" column). Adding a third legal value is
-- exactly the kind of change that constraint exists to make safe: widen the
-- CHECK, and every reader that already treats an unrecognized role as "not
-- admin" (the only role branch RLS or application code has ever taken —
-- see below) keeps working with zero other changes.
--
-- 'trusted_editor' is a SPEND tier, not a VISIBILITY tier — the proposal is
-- explicit that a trusted editor gets a higher allowance for normal
-- production work, nothing more. It must see exactly what an 'editor' sees:
-- their own projects/scenes/assets/runs, and nothing belonging to another
-- account.
--
-- Every role branch in this schema, audited for this migration:
--
--   - is_admin() (0002_rls.sql): `role = 'admin'`. This is the ONLY
--     role-branching logic anywhere in RLS. It backs profiles_select_admin,
--     projects_select, scenes_select, assets_select, and runs_select
--     (0002_rls.sql, runs_select redefined by 0030_runs_project_id.sql to
--     join through runs.project_id instead of scenes, but with the exact
--     same `p.user_id = auth.uid() or is_admin()` shape). Every one of
--     these reads `is_admin()`, not `role in (...)` — a role of
--     'trusted_editor' is neither 'admin' nor matched by any special case,
--     so is_admin() returns false for it exactly as it already does for
--     'editor'. No RLS policy needs to change for this migration to be
--     correct: is_admin() already treats "not admin" as one bucket, and
--     'trusted_editor' lands in that bucket unmodified.
--   - project_cost_totals / user_project_counts / user_directory /
--     project_directory (0026/0027/0028/0029, all `security_invoker`)
--     re-check the same underlying table policies at query time for
--     whichever role is actually asking — they carry no role logic of
--     their own, so the same conclusion applies to all four transitively.
--   - guard.ts's isAdmin()/requireAdmin() (application-code, not RLS —
--     the second line of defense the RLS comment at the top of
--     0002_rls.sql calls out): `profile.role === "admin"`. Same shape,
--     same conclusion — a trusted_editor is not an admin and requireAdmin()
--     still throws for one, so /users, /library writes, and every other
--     admin-only Server Action stay exactly as admin-only as before.
--   - lib/spend.ts's old capForRole(role): `role === "admin" ? ... : ...`.
--     This is the ONE place a three-way role split is genuinely needed
--     (trusted_editor gets its own, higher allowance) — see part 2 below
--     for its replacement. This was never a visibility check, only a
--     dollar-ceiling lookup, so widening it carries no RLS implication.
--
-- Net effect: this migration's ALTER on the CHECK constraint is the entire
-- database-level change 'trusted_editor' requires. No policy in 0002_rls.sql
-- or 0030_runs_project_id.sql is touched.
alter table profiles
  drop constraint profiles_role_check;

alter table profiles
  add constraint profiles_role_check
  check (role in ('admin', 'editor', 'trusted_editor'));

comment on column profiles.role is
  'CHECK-constrained, not a Postgres enum — see 0012_render_settings.sql for why. Three values: '
  '''editor'' (default — see handle_new_user(), 0004_profile_trigger.sql; signup can never set '
  'this, only the trigger''s own hard-coded literal does), ''trusted_editor'' (a SPEND tier only — '
  'is_admin() (0002_rls.sql) is the only role branch in RLS and treats it identically to ''editor'', '
  'see this migration''s header for the full audit), and ''admin'' (the only value is_admin() '
  'matches). Adding a role here means updating web/types/db.ts''s hand-maintained ProfileRole alias '
  'in the same commit — see that file''s header.';

-- =============================================================================
-- 2. Per-account allowances — override columns, role default as fallback
-- =============================================================================
-- Today every dollar ceiling comes from a role-keyed env var
-- (DAILY_CAP_USD / ADMIN_DAILY_CAP_USD, lib/spend.ts's capForRole) — fixed
-- at deploy time, identical for every account sharing a role. The proposal
-- needs an admin to vary one account's allowance without touching
-- render.yaml or redeploying (e.g. a trusted editor who's earned a higher
-- ceiling than the trusted_editor default, or an editor temporarily
-- throttled after a run of bad renders).
--
-- Nullable override columns, NOT a NOT NULL column backfilled from the
-- role default at migration time:
--
--   NULL means "use this account's role default" — resolved in application
--   code (lib/spend.ts's resolveAccountCaps), not baked into the row. A
--   backfilled NOT NULL column would freeze every existing account's
--   allowance at whatever the role default happened to be on the day this
--   migration ran; the role default would then be able to drift (a
--   render.yaml env var tuned later) without ever again affecting an
--   account that already has a "default" value physically stored. NULL
--   keeps "no override" and "the role default, whatever that currently is"
--   the same fact, forever, for every account that has never been touched
--   by an admin — which is every existing account today. That is what "no
--   backfill needed, existing accounts keep working" means here: there is
--   nothing to backfill, because absence already means the right thing.
--
-- Two columns, matching lib/spend.ts's two windows (see part 3 below) —
-- a daily BURST GUARD and a weekly ALLOWANCE are different ceilings an
-- admin may want to vary independently (e.g. raise someone's weekly
-- allowance for a big week without also lifting the guard that stops them
-- spending it all in one afternoon).
alter table profiles
  add column daily_cap_override_usd numeric,
  add column weekly_cap_override_usd numeric;

alter table profiles
  add constraint profiles_daily_cap_override_usd_check
  check (daily_cap_override_usd is null or daily_cap_override_usd >= 0);

alter table profiles
  add constraint profiles_weekly_cap_override_usd_check
  check (weekly_cap_override_usd is null or weekly_cap_override_usd >= 0);

comment on column profiles.daily_cap_override_usd is
  'Per-account override for the daily burst guard (lib/spend.ts). NULL (the default for every '
  'account, including every account that predates this column) means "use this account''s role '
  'default" — resolveAccountCaps() in lib/spend.ts is the one place that fallback happens. Set by '
  'an admin; never client-influenced, same as role itself.';

comment on column profiles.weekly_cap_override_usd is
  'Per-account override for the weekly allowance (lib/spend.ts). Same NULL-means-role-default '
  'contract as daily_cap_override_usd above — see that column''s comment.';

-- =============================================================================
-- 3. A new SQL aggregate for the per-user weekly (and now daily) spend read
-- =============================================================================
-- lib/spend.ts's getDailySpend(userId) used to `select("cost_usd, projects!
-- inner(user_id)")` scoped to one user's runs and reduce() the rows in
-- application code. That was tolerable ONLY because it was bounded to one
-- editor's own runs in one day — a small row count in practice — never the
-- unbounded, max_rows-capped pattern that under-reported /spend's team-wide
-- totals (0026_cost_aggregates.sql's header). Adding a SECOND window
-- (weekly) that needs the exact same per-user sum is the point at which
-- "tolerable" stops being a reason not to do this properly: a second
-- fetch-and-reduce call site is a second place that pattern can silently
-- regress into the /spend bug if the row count ever does grow (a heavy
-- trusted_editor with a very active week is exactly the account this whole
-- feature exists to give more headroom to). Aggregating in SQL closes that
-- off entirely, for both windows, with one function.
--
-- Why not reuse an existing function instead of adding one (checked, per
-- this task's own instruction, before writing this):
--
--   - spend_total_usd(from_ts, to_ts) (0026) has no per-user filter at
--     all — it is the team-wide total /spend's tiles use. Wrapping it with
--     a client-side filter would be back to fetching rows.
--   - spend_totals_by_user(from_ts, to_ts) (0026) is per-user, but it
--     groups EVERY user in the range and joins `runs -> scenes -> projects`
--     — the join 0030_runs_project_id.sql replaced everywhere else in this
--     schema (RLS's runs_select included) specifically because it drops any
--     run whose scene_id is null: every image generation and Claude compile
--     this codebase runs (character reference, composite, per-scene and
--     full-script compiles) is exactly such a run, and 0030's own header
--     documents that gap in detail. spend_totals_by_user was not touched by
--     0030 (it fixed RLS and getDailySpend, not this function), so it still
--     has that gap today. Building this feature's per-user cap check on top
--     of it would import a known undercount straight into a control that
--     exists to stop overspend — the opposite of what this migration is
--     for. Fetching every user's row from it just to discard all but one
--     would also violate "aggregate in SQL, don't fetch and filter" as
--     surely as the getDailySpend reduce() it's meant to replace.
--
-- user_spend_usd below is deliberately narrow instead: one user, one range,
-- joining `runs -> projects` directly via runs.project_id — the SAME join
-- 0030_runs_project_id.sql's runs_select policy and getDailySpend already
-- use, so this function and RLS agree on which runs attribute to which
-- user. security invoker, `language sql`, no special grant needed (see
-- 0026's header: 0007_grants.sql's default privileges already cover any
-- function this migration's role creates).
create or replace function user_spend_usd(target_user_id uuid, from_ts timestamptz, to_ts timestamptz)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(r.cost_usd), 0)
  from runs r
  join projects p on p.id = r.project_id
  where p.user_id = target_user_id
    and r.created_at >= from_ts
    and r.created_at < to_ts;
$$;

comment on function user_spend_usd is
  'Total cost_usd for one user''s runs created in [from_ts, to_ts) — the per-account spend read '
  'for both the daily burst guard and the weekly allowance (lib/spend.ts). Joins runs -> projects '
  'via runs.project_id directly, matching 0030_runs_project_id.sql''s runs_select RLS policy and '
  'lib/spend.ts''s getDailySpend — see this migration''s header for why spend_total_usd and '
  'spend_totals_by_user (0026_cost_aggregates.sql) do not fit this instead.';

-- =============================================================================
-- 4. account_spend_windows (view) — the /users admin read of allowance vs.
--    actual usage, computed with the SAME day/week boundary lib/spend.ts
--    enforces (see that file's header for the timezone and calendar-week
--    decisions this view's `at time zone 'Asia/Manila'` arithmetic mirrors).
-- =============================================================================
-- The proposal asks for "clear usage visibility for each editor" and an
-- admin's ability to see each account's allowance alongside its current
-- usage — /users' existing "Spend to date" column is all-time and answers a
-- different question (lifetime cost) than "is this account near either of
-- its current ceilings" does.
--
-- This view intentionally does NOT compute the effective cap (override vs.
-- role default) — that resolution lives in exactly one place,
-- lib/spend.ts's resolveAccountCaps(), which reads role-keyed env vars a
-- SQL view has no access to and was never meant to duplicate. This view
-- supplies only the two SQL-aggregated spend figures; /users' Server
-- Component joins them with resolveAccountCaps(profile) in application
-- code, the same division of labor spend.ts already has everywhere else
-- (SQL sums dollars, TypeScript resolves ceilings).
--
-- Per-profile LEFT JOIN LATERAL, not a plain LEFT JOIN subquery keyed on a
-- pre-aggregated GROUP BY: a lateral join lets each subquery reference the
-- outer profiles.id being joined against, which a bare `group by
-- projects.user_id` subquery — user_directory's own pattern
-- (0028_user_directory.sql) — cannot do once the aggregate needs a
-- per-row-relative time window instead of a single global range. Both
-- windows are computed with `now()` at query time, inside `date_trunc`
-- evaluated `at time zone 'Asia/Manila'` and converted back — this is a
-- LIVE view (like every other view in this schema, it is just a stored
-- query), so "today"/"this week" always mean the instant the admin loads
-- /users, not whatever they meant when this migration ran.
--
-- `security_invoker = true`, same reasoning as project_cost_totals/
-- user_project_counts/user_directory/project_directory (0026/0027/0028):
-- without it this view would run as its owner and leak every account's
-- spend to any authenticated caller. /users already gates on
-- requireAdmin() in application code first (defence in depth, same as
-- every other admin surface) and reads through the session client — an
-- admin's is_admin()-backed RLS (profiles_select_admin, projects_select,
-- runs_select) lets this correctly return every account's row; a
-- non-admin querying it directly would, transitively, only ever see their
-- own (profiles_select_own limits the outer join to their own profile row,
-- so the lateral subqueries never run for anyone else's).
create view account_spend_windows
with (security_invoker = true) as
select
  p.id as user_id,
  coalesce(today.spend_usd, 0) as spent_today_usd,
  coalesce(week.spend_usd, 0) as spent_this_week_usd
from profiles p
left join lateral (
  select coalesce(sum(r.cost_usd), 0) as spend_usd
  from runs r
  join projects pr on pr.id = r.project_id
  where pr.user_id = p.id
    and r.created_at >= (date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')
) today on true
left join lateral (
  select coalesce(sum(r.cost_usd), 0) as spend_usd
  from runs r
  join projects pr on pr.id = r.project_id
  where pr.user_id = p.id
    and r.created_at >= (date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')
) week on true;

comment on view account_spend_windows is
  'Per-account spend for the current Asia/Manila day and the current Asia/Manila calendar week '
  '(Monday start — Postgres date_trunc(''week'', ...) already truncates to Monday), computed live '
  'in SQL — see this migration''s header for why the two windows use Asia/Manila and calendar-week '
  'boundaries, matching lib/spend.ts exactly. Caps are NOT in this view — /users resolves those in '
  'application code via lib/spend.ts''s resolveAccountCaps(profile), the one place override-vs-'
  'role-default logic lives.';

-- No new grants needed — 0007_grants.sql's `alter default privileges ...
-- grant execute on functions to authenticated` / `... on tables to
-- authenticated` already cover anything this migration's role creates,
-- the same fact every migration since 0026 has leaned on.
-- =============================================================================
