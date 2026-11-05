-- =============================================================================
-- profiles.status — an admin decides before a new account can use the app
--
-- Self-serve signup (web/actions/auth.ts, opened up by the change 0031's
-- header describes) mints a working account the moment the form is
-- submitted: 'editor' role, that role's DAILY_CAP_USD/WEEKLY_CAP_USD render
-- budget (web/lib/spend.ts) live from the first request. SIGNUP_ALLOWED_
-- DOMAINS was the only lever standing between "anyone who can reach the
-- form" and "an account spending against the render budget", and it is a
-- domain filter, not a decision — it cannot tell a new hire apart from
-- anyone else holding an address at the same domain.
--
-- This column is that decision. 'pending' until an admin approves it
-- (web/actions/account.ts's decideAccountApproval, from /users).
--
-- ---------------------------------------------------------------------------
-- Why the default flips mid-migration
-- ---------------------------------------------------------------------------
-- The two statements below are not one statement with a tidier spelling.
-- `add column ... default 'active'` backfills every row that already exists
-- in the same pass, which is the whole point: this must not lock out the
-- accounts already using the app, and in particular must not lock out the
-- admins who would be the ones to approve anybody. Flipping the default to
-- 'pending' immediately afterwards is what makes every FUTURE row pending.
-- Adding the column with `default 'pending'` and then UPDATEing the existing
-- rows back to 'active' would reach the same end state, but there is a
-- window inside that transaction where every account in the system is
-- pending — and if the UPDATE is ever separated from the ADD (a split
-- migration, a partial re-run), that window becomes the permanent state.
--
-- ---------------------------------------------------------------------------
-- handle_new_user() is deliberately NOT touched
-- ---------------------------------------------------------------------------
-- The trigger (0004, extended by 0015) names the columns it inserts, so a
-- row it creates takes this column's default like any other insert. That
-- covers both paths into auth.users — self-serve signUp and an account
-- hand-created in the Supabase dashboard — without the trigger having to
-- know this column exists.
--
-- ---------------------------------------------------------------------------
-- text + CHECK, not an enum
-- ---------------------------------------------------------------------------
-- Same rule every enum-ish column in this schema follows — see
-- 0012_render_settings.sql's header. Widening this to a fourth status later
-- ('suspended', say) is a one-line ALTER rather than a type migration.
-- =============================================================================

alter table profiles
  add column status text not null default 'active'
  check (status in ('pending', 'active', 'rejected'));

alter table profiles
  alter column status set default 'pending';

comment on column profiles.status is
  'Admin approval state for this account. New accounts are ''pending'' (the column default) and are '
  'held at /pending by requireUser() (web/actions/guard.ts) until an admin approves them from '
  '/users; ''rejected'' is terminal. Accounts predating 0052_account_approval.sql were backfilled '
  'to ''active'' — see that migration''s header for why the default flips after the backfill.';

-- =============================================================================
-- is_active() — the second line, mirroring is_admin()
--
-- web/actions/guard.ts's requireUser() is the FIRST line and the one that
-- produces the user-visible behaviour (a redirect to /pending). This exists
-- because a pending account still holds a real, unexpired access token: the
-- one thing signUp cannot take back is the JWT it already issued (jwt_expiry
-- = 3600, supabase/config.toml), and that token addresses PostgREST directly
-- with the anon key, where no amount of app-side guarding applies. RLS is
-- the second line, not the first (0002_rls.sql) — this is that second line.
--
-- Added to projects_insert_own ONLY, and that is a deliberate scope, not an
-- oversight. Every scenes/assets/runs insert policy in 0002_rls.sql
-- (lines 77, 129, 182) authorises through an `exists (select 1 from projects
-- where ... user_id = auth.uid())` subquery, so an account that cannot own a
-- project cannot reach any of them either — one policy closes the whole
-- spend chain, and adding is_active() to the other three would only
-- re-check, per row, a fact the project row already settles.
--
-- Reads (projects_select and friends) are deliberately left alone: a pending
-- account owns nothing, so those policies already return it nothing, and
-- widening the write guard into a read guard would mean a REJECTED account
-- loses the ability to see its own profile row — which is exactly the row
-- /pending has to read to tell that account why it is stuck there.
--
-- security definer, `stable`, `set search_path = public`: identical posture
-- to is_admin() directly above it in 0002, and for the same reason — a
-- policy on a table that has to consult `profiles` would otherwise recurse
-- through profiles' own RLS.
-- =============================================================================

create or replace function is_active()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and status = 'active'
  );
$$;

comment on function is_active() is
  'True when the calling account has been approved by an admin (profiles.status = ''active''). '
  'Mirrors is_admin() (0002_rls.sql). Used by projects_insert_own as the RLS second line behind '
  'requireUser()''s /pending redirect — see 0052_account_approval.sql''s header for why this one '
  'policy is enough to cover scenes/assets/runs too.';

drop policy projects_insert_own on projects;

create policy projects_insert_own on projects
  for insert
  with check (user_id = auth.uid() and is_active());

-- =============================================================================
-- user_directory (0028, last replaced by 0030_runs_project_id.sql) — carry
-- status so /users can render and act on it in the query it already makes.
--
-- Byte-for-byte 0030's definition with `p.status` appended. Appended, not
-- slotted in profiles-column order next to `role`, because CREATE OR REPLACE
-- VIEW may only add columns at the END of the select list — moving an
-- existing column, or inserting a new one between two of them, is a drop and
-- recreate, which would take every dependent object with it.
-- =============================================================================

create or replace view user_directory
with (security_invoker = true) as
select
  p.id,
  p.email,
  p.username,
  p.role,
  p.created_at,
  coalesce(counts.project_count, 0) as project_count,
  coalesce(spend.spend_usd, 0) as spend_usd,
  p.status
from profiles p
left join (
  select user_id, count(*) as project_count
  from projects
  group by user_id
) counts on counts.user_id = p.id
left join (
  select pr.user_id, coalesce(sum(r.cost_usd), 0) as spend_usd
  from runs r
  join projects pr on pr.id = r.project_id
  group by pr.user_id
) spend on spend.user_id = p.id;

comment on view user_directory is
  'profiles LEFT JOINed to per-user project counts and all-time spend, both computed in SQL — see '
  '0028_user_directory.sql''s header. LEFT JOIN + COALESCE(...,0): a user with zero projects and zero '
  'spend MUST still appear as a 0/0 row. spend subquery joins runs -> projects via runs.project_id '
  'directly (not through scenes) since 0030_runs_project_id.sql, so a scene-less run counts toward '
  'its owner''s total too. Carries profiles.status since 0052_account_approval.sql, appended last '
  'because CREATE OR REPLACE VIEW can only add columns at the end.';
