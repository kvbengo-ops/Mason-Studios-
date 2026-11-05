-- =============================================================================
-- The Image Generator stops needing a project.
-- =============================================================================
--
-- 0083/0084 built a standalone image console and then hung it off a project of
-- its own kind, because two NOT NULLs said it had to: `assets.project_id` gave
-- a generated image somewhere to live, and `runs.project_id` gave its cost
-- somebody to belong to (runs -> projects -> projects.user_id is how every
-- per-user spend read in this schema attributes a dollar). The console was
-- therefore preceded by a picker: choose an image project, or start one.
--
-- That project buys nothing. It has no script, no scenes, no cut and no
-- delivery; it exists so two foreign keys have a target. What it costs is a
-- step in front of every image, a projects row per session for anyone who does
-- not want to reuse one, and a /projects list filling with workspaces nobody
-- opens.
--
-- This migration removes the requirement by giving both tables the column they
-- were routing around: an OWNER. A generated image and its charge belong to a
-- person; a project was only ever how we found that person.
--
-- -----------------------------------------------------------------------------
-- The rule this migration must not break, and how it does not
-- -----------------------------------------------------------------------------
-- 0030_runs_project_id.sql named the real hazard plainly: a run with no
-- project is INVISIBLE to every per-user aggregate, because `p.id =
-- runs.project_id` is never true for a NULL. It accepted that gap for exactly
-- one admin-only writer (the Character Library's reference photo) and wrote
-- the cost down.
--
-- Making the Image Generator a project-less writer without closing that gap
-- would turn a documented one-call-site exception into the main path for a
-- paid feature: an editor's whole week of images would read $0 against their
-- weekly allowance, and an approver would grant more against a number smaller
-- than the truth -- 0030's own words for why it exists at all.
--
-- So attribution moves from "join to the project" to "the run's own owner,
-- falling back to the project's":
--
--     join projects p on p.id = r.project_id        -- was
--     where p.user_id = target
--
--     left join projects p on p.id = r.project_id   -- is
--     where coalesce(r.user_id, p.user_id) = target
--
-- LEFT, and coalesce in that order, are both load-bearing. LEFT keeps the
-- project-less row in the result at all. coalesce(r.user_id, p.user_id) --
-- run first -- makes the new column authoritative where it is set and leaves
-- every existing row, which has no user_id, attributed exactly as it is today.
-- That is why NOTHING IS BACKFILLED: a historical project-backed run already
-- resolves to the same person through the fallback, and writing the same
-- answer into a new column would only create a second copy to keep in
-- agreement with `projects.user_id` when a project changes hands.
--
-- Six per-user reads carry that join and are all replaced below. The team-wide
-- reads (spend_total_usd, spend_category_totals) never joined anything and
-- have always counted project-less rows; they are untouched, and that is why
-- GLOBAL_DAILY_CAP_USD needed no change here.
--
-- -----------------------------------------------------------------------------
-- NOT APPLIED. Written, reviewed, staged -- not run against production, per
-- the task that added it. web/lib/version.ts's EXPECTED_DB_VERSION moves to
-- 0085 with it.
-- =============================================================================

-- =============================================================================
-- 1. runs.user_id -- who this attempt is billed to when no project says
-- =============================================================================
-- `on delete set null`, NOT cascade, and the difference matters more here than
-- anywhere else this pattern appears. runs is the cost ledger; deleting an
-- account must not delete the record that the money was spent. The row stays,
-- keeps counting in the team-wide total, and simply stops being attributable
-- to anybody -- the same shape 0040 already gives an archived run whose
-- user_id cannot be resolved.
--
-- Contrast runs.project_id, which IS cascade (0030): a deleted project's runs
-- are copied into deleted_project_cost_history by the 0038/0040 trigger before
-- they go, so that history survives the cascade. There is no equivalent
-- archive for a deleted profile, so the row itself has to survive.
alter table runs add column if not exists user_id uuid references profiles(id) on delete set null;

comment on column runs.user_id is
  'Who this attempt is billed to, set by writers that have no project to attribute through -- the '
  'project-less Image Generator (0085) is the first. NULL for every run written before 0085 and '
  'for every project-backed writer since, which is correct and deliberate: every per-user read in '
  'this schema resolves the owner as coalesce(runs.user_id, projects.user_id), so an unset value '
  'falls back to the project owner exactly as it always did. Never backfilled -- a second copy of '
  'projects.user_id would only be a thing to keep in agreement when a project changes hands.';

-- Every per-user read below filters on this column for the project-less half
-- of its scan. Partial, because ~every existing row is NULL and none of them
-- is ever found this way.
create index if not exists runs_user_id_created_at_idx
  on runs (user_id, created_at)
  where user_id is not null;

-- -----------------------------------------------------------------------------
-- Duplicate protection for a project-less attempt
-- -----------------------------------------------------------------------------
-- 0083's index is `unique (project_id, idempotency_key) where idempotency_key
-- is not null`. Postgres treats NULLs as DISTINCT in a unique index, so with
-- project_id NULL that index constrains NOTHING: every project-less retry of
-- the same Generate press would insert a new reservation and charge again.
-- The whole point of the key is defeated silently, by a rule about NULL that
-- has nothing to do with the feature.
--
-- A second partial index, scoped to exactly the rows the first one cannot
-- cover, restores it. Two narrow indexes rather than one on
-- coalesce(project_id, user_id): they are different namespaces, and an
-- expression index would let a project id and a user id collide in principle
-- while being harder to read, for no gain.
create unique index if not exists runs_user_idempotency_key_uniq
  on runs (user_id, idempotency_key)
  where project_id is null and idempotency_key is not null;

-- =============================================================================
-- 2. assets: project_id becomes optional, user_id appears
-- =============================================================================
-- Dropping NOT NULL widens; no existing row changes, and no reader that
-- assumes a project on a project-backed asset is affected. The CHECK is what
-- stops the widening from admitting an asset belonging to nothing at all -- a
-- row no policy could scope, no page could list, and no cleanup could find.
alter table assets alter column project_id drop not null;

-- Cascade here, unlike runs above, because the trade runs the other way: a
-- personal asset is a FILE belonging to one person, not a financial record.
-- When the account goes, the rows pointing at their storage objects should go
-- with it rather than linger as keys nothing can attribute or clean up.
alter table assets add column if not exists user_id uuid references profiles(id) on delete cascade;

alter table assets drop constraint if exists assets_owner_present_check;
alter table assets
  add constraint assets_owner_present_check
  check (project_id is not null or user_id is not null);

comment on column assets.user_id is
  'The account this asset belongs to directly, for assets that have no project -- the project-less '
  'Image Generator (0085) is the first writer. NULL for every project-backed asset, which is still '
  'scoped through projects.user_id exactly as before. assets_owner_present_check makes "neither" '
  'impossible: an asset with no project AND no user is unreachable by every policy and every page.';

comment on column assets.project_id is
  'The project this asset belongs to, or NULL for one owned directly by an account (user_id, '
  '0085). NOT NULL until 0085, when the Image Generator stopped requiring a project -- see that '
  'migration''s header for why a project existed here at all.';

-- Backs the personal image history read (one user's generated images, newest
-- first). Partial for the same reason runs' is: ~every existing row is NULL.
create index if not exists assets_user_id_kind_created_at_idx
  on assets (user_id, kind, created_at desc)
  where user_id is not null;

-- =============================================================================
-- 3. RLS: both tables gain the owner branch their new column describes
-- =============================================================================
-- `alter policy` where only the predicate moves, per 0074's note on 0033's
-- SQLSTATE 42P16 incident: same object, same privilege, broader using.
--
-- These policies are the second line, not the first (0002_rls.sql's header) --
-- every write in this app goes through the service-role client, which bypasses
-- them. They are corrected anyway for the reason 0030 corrected them: a policy
-- that cannot admit a row shape the schema now produces is a bug in the
-- policy, and spend_totals_by_user / project_cost_totals are SECURITY INVOKER
-- precisely so an admin's own RLS-visible rows cover everyone's.

alter policy assets_select on assets
  using (
    assets.user_id = auth.uid()
    or (assets.user_id is not null and is_admin())
    or exists (
      select 1 from projects p
      where p.id = assets.project_id
        and (p.user_id = auth.uid() or is_admin())
    )
  );

alter policy assets_insert on assets
  with check (
    assets.user_id = auth.uid()
    or exists (
      select 1 from projects p
      where p.id = assets.project_id
        and p.user_id = auth.uid()
    )
  );

alter policy assets_update on assets
  using (
    assets.user_id = auth.uid()
    or exists (
      select 1 from projects p
      where p.id = assets.project_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    assets.user_id = auth.uid()
    or exists (
      select 1 from projects p
      where p.id = assets.project_id
        and p.user_id = auth.uid()
    )
  );

alter policy assets_delete on assets
  using (
    assets.user_id = auth.uid()
    or exists (
      select 1 from projects p
      where p.id = assets.project_id
        and p.user_id = auth.uid()
    )
  );

comment on policy assets_select on assets is
  'Own project-backed assets (through projects.user_id) OR own personal assets (assets.user_id, '
  '0085); an admin reads both. The owner branch is stated first because it is the cheap one -- no '
  'subquery -- and short-circuits for every personal image.';

alter policy runs_select on runs
  using (
    runs.user_id = auth.uid()
    or (runs.user_id is not null and is_admin())
    or exists (
      select 1 from projects p
      where p.id = runs.project_id
        and (p.user_id = auth.uid() or is_admin())
    )
  );

alter policy runs_insert on runs
  with check (
    runs.user_id = auth.uid()
    or exists (
      select 1 from projects p
      where p.id = runs.project_id
        and p.user_id = auth.uid()
    )
  );

alter policy runs_update on runs
  using (
    runs.user_id = auth.uid()
    or exists (
      select 1 from projects p
      where p.id = runs.project_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    runs.user_id = auth.uid()
    or exists (
      select 1 from projects p
      where p.id = runs.project_id
        and p.user_id = auth.uid()
    )
  );

alter policy runs_delete on runs
  using (
    runs.user_id = auth.uid()
    or exists (
      select 1 from projects p
      where p.id = runs.project_id
        and p.user_id = auth.uid()
    )
  );

comment on policy runs_select on runs is
  'Own project-backed runs (through projects.user_id) OR own project-less runs (runs.user_id, '
  '0085); an admin reads both. The one unreadable shape left is a run with NEITHER -- the '
  'Character Library''s reference photo, 0030''s documented exception -- which is written and read '
  'only through the service-role client.';

-- =============================================================================
-- 4. The six per-user reads, re-attributed
-- =============================================================================
-- Each is its latest definition with ONE edit: `join projects` becomes `left
-- join projects`, and the owner expression becomes coalesce(r.user_id,
-- p.user_id). Signatures, column lists, order and every other predicate are
-- byte-for-byte unchanged, so these stay `create or replace` and take no
-- dependent object with them.
--
-- Ordered as a reader would ask about them: the one that decides money first,
-- the ones that report it after.

-- -----------------------------------------------------------------------------
-- 4a. user_spend_usd (0031, redefined 0040) -- THE per-account spend read.
-- Backs the daily burst guard, the weekly allowance, sidebar_budget_snapshot
-- (0044/0075, which calls this rather than re-summing) and reserve_image_
-- attempt's own weekly/daily checks below. Fixing this one function is what
-- makes a project-less image count against its owner's caps at all.
-- -----------------------------------------------------------------------------
create or replace function user_spend_usd(target_user_id uuid, from_ts timestamptz, to_ts timestamptz)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(t.cost_usd), 0)
  from (
    -- Live runs this user owns: their projects' runs, plus runs attributed
    -- straight to them (0085).
    select r.cost_usd
    from runs r
    left join projects p on p.id = r.project_id
    where coalesce(r.user_id, p.user_id) = target_user_id
      and r.created_at >= from_ts
      and r.created_at < to_ts

    union all

    -- This user's archived runs. Filtered on the archive's own user_id
    -- (0040), not on a join to profiles/projects -- both are gone by the
    -- time a row lands here.
    select h.cost_usd
    from deleted_project_cost_history h
    where h.user_id = target_user_id
      and h.run_created_at >= from_ts
      and h.run_created_at < to_ts
  ) t;
$$;

comment on function user_spend_usd is
  'Total cost_usd for one user''s runs created in [from_ts, to_ts), including archived runs from '
  'that user''s deleted projects/scenes (0038; unioned in by '
  '0040_include_archived_cost_in_spend_reads.sql) -- the per-account spend read for both the daily '
  'burst guard and the weekly allowance (lib/spend.ts). Since 0085 the owner is '
  'coalesce(runs.user_id, projects.user_id) over a LEFT join, so a project-less run (the personal '
  'Image Generator) counts against its owner''s caps instead of being silently invisible to them.';

-- -----------------------------------------------------------------------------
-- 4b. spend_totals_by_user (0026, redefined 0030/0040) -- /spend's per-user
-- table.
-- -----------------------------------------------------------------------------
create or replace function spend_totals_by_user(from_ts timestamptz, to_ts timestamptz)
returns table(user_id uuid, email text, total_usd numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select
    t.user_id,
    max(t.email) as email,
    coalesce(sum(t.cost_usd), 0) as total_usd
  from (
    select coalesce(r.user_id, p.user_id) as user_id, prof.email, r.cost_usd
    from runs r
    left join projects p on p.id = r.project_id
    left join profiles prof on prof.id = coalesce(r.user_id, p.user_id)
    where r.created_at >= from_ts and r.created_at < to_ts
      -- The Character Library's project-less, user-less run (0030) would
      -- otherwise group under a NULL key and render as a nameless row. It
      -- still counts team-wide in spend_total_usd, exactly as before.
      and coalesce(r.user_id, p.user_id) is not null

    union all

    select h.user_id, prof.email, h.cost_usd
    from deleted_project_cost_history h
    left join profiles prof on prof.id = h.user_id
    where h.user_id is not null
      and h.run_created_at >= from_ts
      and h.run_created_at < to_ts
  ) t
  group by t.user_id
  order by total_usd desc;
$$;

comment on function spend_totals_by_user is
  'Per-user total cost_usd for runs created in [from_ts, to_ts), including each user''s archived '
  'runs from deleted projects/scenes (0038; unioned in by '
  '0040_include_archived_cost_in_spend_reads.sql). Owner is coalesce(runs.user_id, '
  'projects.user_id) since 0085, so project-less Image Generator spend appears against its owner. '
  'Rows attributable to nobody -- an archived row with no resolved user_id, or the Character '
  'Library''s project-less run -- are excluded from this breakdown and still counted team-wide by '
  'spend_total_usd, so the money is never lost, only unattributed at the per-user grain.';

-- -----------------------------------------------------------------------------
-- 4c. spend_category_totals_by_user (0037, redefined 0040/0056/0066) --
-- /spend's iterate-vs-render split per user. The category predicate is
-- carried over verbatim from 0066; lib/spend-category-sql.test.ts reads this
-- file's model list and fails if it drifts from worker/internal/kie/models.go.
-- -----------------------------------------------------------------------------
create or replace function spend_category_totals_by_user(from_ts timestamptz, to_ts timestamptz)
returns table(user_id uuid, email text, iterate_usd numeric, render_usd numeric, total_usd numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select
    t.user_id,
    max(t.email) as email,
    coalesce(sum(t.cost_usd) filter (
      where t.model is null or t.model <> all (array[
        'bytedance/seedance-2-5', 'bytedance/seedance-2', 'bytedance/seedance-2-fast',
        'kling-3.0/video', 'hailuo/2-3-image-to-video-pro'
      ])
    ), 0) as iterate_usd,
    coalesce(sum(t.cost_usd) filter (
      where t.model = any (array[
        'bytedance/seedance-2-5', 'bytedance/seedance-2', 'bytedance/seedance-2-fast',
        'kling-3.0/video', 'hailuo/2-3-image-to-video-pro'
      ])
    ), 0) as render_usd,
    coalesce(sum(t.cost_usd), 0) as total_usd
  from (
    select coalesce(r.user_id, p.user_id) as user_id, prof.email, r.cost_usd, r.vendor, r.model
    from runs r
    left join projects p on p.id = r.project_id
    left join profiles prof on prof.id = coalesce(r.user_id, p.user_id)
    where r.created_at >= from_ts and r.created_at < to_ts
      and coalesce(r.user_id, p.user_id) is not null

    union all

    select h.user_id, prof.email, h.cost_usd, h.vendor, h.model
    from deleted_project_cost_history h
    left join profiles prof on prof.id = h.user_id
    where h.user_id is not null
      and h.run_created_at >= from_ts
      and h.run_created_at < to_ts
  ) t
  group by t.user_id
  order by total_usd desc;
$$;

comment on function spend_category_totals_by_user is
  'Per-user iterate-vs-render split for runs created in [from_ts, to_ts), including each user''s '
  'archived runs from deleted projects/scenes (0038). Owner is coalesce(runs.user_id, '
  'projects.user_id) since 0085. Category predicate is an exact-match list of kie''s video wire ids '
  'as of 0080_seedance_2_fast_counts_as_render.sql -- a generated image is not on it, so personal '
  'image spend lands in iterate_usd, which is what it is. Backs /spend''s Per-user totals table.';

-- -----------------------------------------------------------------------------
-- 4d. account_spend_windows (0031, redefined 0040) -- /users' today/this-week
-- columns. Same Manila boundaries as lib/spend.ts, unchanged.
-- -----------------------------------------------------------------------------
create or replace view account_spend_windows
with (security_invoker = true) as
select
  p.id as user_id,
  coalesce(today.spend_usd, 0) as spent_today_usd,
  coalesce(week.spend_usd, 0) as spent_this_week_usd
from profiles p
left join lateral (
  select coalesce(sum(x.cost_usd), 0) as spend_usd
  from (
    select r.cost_usd
    from runs r
    left join projects pr on pr.id = r.project_id
    where coalesce(r.user_id, pr.user_id) = p.id
      and r.created_at >= (date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')

    union all

    select h.cost_usd
    from deleted_project_cost_history h
    where h.user_id = p.id
      and h.run_created_at >= (date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')
  ) x
) today on true
left join lateral (
  select coalesce(sum(x.cost_usd), 0) as spend_usd
  from (
    select r.cost_usd
    from runs r
    left join projects pr on pr.id = r.project_id
    where coalesce(r.user_id, pr.user_id) = p.id
      and r.created_at >= (date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')

    union all

    select h.cost_usd
    from deleted_project_cost_history h
    where h.user_id = p.id
      and h.run_created_at >= (date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')
  ) x
) week on true;

-- -----------------------------------------------------------------------------
-- 4e. outstanding_allowance_usd (0035, redefined 0075) -- /users' "what the
-- team could still spend this week" figure.
-- -----------------------------------------------------------------------------
create or replace function outstanding_allowance_usd(
  editor_weekly_default numeric,
  trusted_weekly_default numeric
)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    sum(
      greatest(
        0,
        (
          coalesce(
            p.weekly_cap_override_usd,
            case p.role
              when 'trusted_editor' then trusted_weekly_default
              else editor_weekly_default
            end
          )
          + coalesce(grants.total_usd, 0)
        )
        - coalesce(spent.spend_usd, 0)
      )
    ),
    0
  )
  from profiles p
  left join lateral (
    select sum(g.amount_usd) as total_usd
    from allowance_grants g
    where g.user_id = p.id
      and g.expires_at > now()
      and g.revoked_at is null
  ) grants on true
  left join lateral (
    select sum(r.cost_usd) as spend_usd
    from runs r
    left join projects pr on pr.id = r.project_id
    where coalesce(r.user_id, pr.user_id) = p.id
      and r.created_at >= (date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')
  ) spent on true
  where p.role <> 'admin';
$$;

comment on function outstanding_allowance_usd is
  'Sum over non-admin accounts, for the current Manila calendar week, of max(0, effective weekly '
  'allowance - spent this week) -- what could still be spent if every editor/trusted_editor used '
  'their full weekly allowance. See 0035_outstanding_allowance.sql for why admins are excluded and '
  'why the role defaults arrive as parameters. Spend side re-attributed in 0085 to '
  'coalesce(runs.user_id, projects.user_id), so a project-less image reduces the figure the way '
  'any other spend does.';

-- -----------------------------------------------------------------------------
-- 4f. user_directory (0028, redefined 0030/0052) -- /users' all-time spend
-- column. Column list unchanged, so this stays a body-only replace (see
-- 0052's note on CREATE OR REPLACE VIEW only being able to append).
-- -----------------------------------------------------------------------------
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
  select coalesce(r.user_id, pr.user_id) as user_id, coalesce(sum(r.cost_usd), 0) as spend_usd
  from runs r
  left join projects pr on pr.id = r.project_id
  where coalesce(r.user_id, pr.user_id) is not null
  group by coalesce(r.user_id, pr.user_id)
) spend on spend.user_id = p.id;

comment on view user_directory is
  'profiles LEFT JOINed to per-user project counts and all-time spend, both computed in SQL -- see '
  '0028_user_directory.sql''s header. LEFT JOIN + COALESCE(...,0): a user with zero projects and '
  'zero spend MUST still appear as a 0/0 row. The spend subquery attributes a run to '
  'coalesce(runs.user_id, projects.user_id) since 0085, so both a scene-less run (0030) and a '
  'project-less one (0085) count toward their owner''s total. Carries profiles.status since '
  '0052_account_approval.sql, appended last because CREATE OR REPLACE VIEW can only add columns '
  'at the end.';

-- =============================================================================
-- 5. reserve_image_attempt learns the project-less shape
-- =============================================================================
-- Same lock order, same three ceilings, same reserved/duplicate/blocked
-- contract. Two changes, and the first is the one that carries the security
-- property:
--
--   - p_project_id may now be NULL, and p_user_id joins it. When a project IS
--     given the owner is still derived from the LOCKED project row and
--     p_user_id is ignored entirely -- 0083's rule that "a caller must not be
--     able to name whose budget is spent" is preserved exactly where it
--     applied. When there is no project there is no row to derive from, so the
--     owner is the caller's argument, and the Server Action's requireUser() is
--     the seam that establishes it. That is a real reduction in defence in
--     depth for the project-less path and is stated rather than glossed: the
--     function is service-role-only (section 6 below is re-asserted for the
--     new signature), so naming another owner requires the service-role key,
--     which is already full compromise.
--
--   - idempotency is looked up in the matching namespace: by project when
--     there is one, by owner when there is not. The unique indexes in section
--     1 back both, so a lost race still fails at the database rather than
--     charging twice.
--
-- The 11-argument signature from 0083 is DROPPED rather than left beside this
-- one. An overload set where the two differ only by a trailing parameter is
-- how a caller that forgets the new argument silently keeps the old behaviour;
-- there is one caller (lib/runs.ts's reserveImageAttempt) and it moves with
-- this file.
drop function if exists public.reserve_image_attempt(
  uuid, text, numeric, text, timestamptz, timestamptz, timestamptz,
  numeric, numeric, numeric, boolean
);

create or replace function public.reserve_image_attempt(
  p_project_id            uuid,
  p_user_id               uuid,
  p_idempotency_key       text,
  p_estimate_usd          numeric,
  p_model                 text,
  p_day_start_ts          timestamptz,
  p_week_start_ts         timestamptz,
  p_now_ts                timestamptz,
  p_global_daily_cap_usd  numeric,
  p_weekly_cap_usd        numeric,
  p_daily_cap_usd         numeric,
  p_daily_cap_enabled     boolean
)
returns table (
  outcome    text,
  run_id     uuid,
  blocked_by text,
  spent_usd  numeric
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner_id     uuid;
  v_existing_id  uuid;
  v_to_ts        timestamptz;
  v_spent        numeric;
  v_new_id       uuid;
begin
  -- Trust boundary. This function is service_role-only and the Server Action is
  -- its only caller, but it is the last thing standing between a bad argument
  -- and a charge, so it validates rather than assuming.
  --
  -- A NULL cap is the dangerous one: `spent + estimate > NULL` is NULL, which is
  -- not true, so a forgotten env var would silently disable a ceiling instead of
  -- failing. A negative estimate would manufacture headroom the same way.
  if p_project_id is null and p_user_id is null then
    raise exception 'reserve_image_attempt: one of project_id or user_id is required'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_idempotency_key is null or p_idempotency_key = '' then
    raise exception 'reserve_image_attempt: idempotency_key is required'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_estimate_usd is null or p_estimate_usd < 0 then
    raise exception 'reserve_image_attempt: estimate_usd must be >= 0, got %', p_estimate_usd
      using errcode = 'invalid_parameter_value';
  end if;
  if p_global_daily_cap_usd is null or p_weekly_cap_usd is null then
    raise exception 'reserve_image_attempt: global and weekly caps are required'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_daily_cap_enabled and p_daily_cap_usd is null then
    raise exception 'reserve_image_attempt: daily cap is enabled but was not supplied'
      using errcode = 'invalid_parameter_value';
  end if;

  -- LOCK ORDER: global first, owner second. ALWAYS. Two callers taking these in
  -- opposite orders deadlock, and the only thing preventing that is that this is
  -- the single place either lock is taken.
  --
  -- The global lock is what makes the company-wide daily cap safe against two
  -- DIFFERENT accounts arriving together with room for one -- a per-owner lock
  -- would let both through. Held for this function only, never across the kie
  -- call.
  --
  -- Scope, stated honestly: this coordinates only paths that take the same lock,
  -- and no other paid path in this repository takes any advisory lock. Image vs
  -- image is now impossible; image vs a simultaneous video render still races
  -- exactly as it does today.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('image-generator:global-daily')
  );

  if p_project_id is not null then
    -- The owner is derived from the LOCKED project row, never passed in: a
    -- caller must not be able to name whose budget is spent. requireProject
    -- has already checked ownership in the app; this is the seam that does
    -- not depend on it.
    select p.user_id into v_owner_id
    from public.projects p
    where p.id = p_project_id
    for update;

    if not found then
      raise exception 'reserve_image_attempt: project % not found', p_project_id
        using errcode = 'no_data_found';
    end if;
  else
    -- No project, so nothing to derive from and nothing to lock. The owner is
    -- the caller's argument, established by requireUser() in the Server
    -- Action; see this section's header for why that is acceptable here and
    -- was not for the project case.
    --
    -- Still verified to EXIST: a typo'd or deleted owner would otherwise
    -- reserve, generate, charge, and only fail on the runs insert's foreign
    -- key -- after the money was gone.
    select p.id into v_owner_id
    from public.profiles p
    where p.id = p_user_id;

    if not found then
      raise exception 'reserve_image_attempt: user % not found', p_user_id
        using errcode = 'no_data_found';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('image-generator:owner:' || v_owner_id::text)
  );

  -- Idempotency is checked BEFORE the ceilings, so a retry of an attempt that
  -- already exists is never refused by a cap it already passed.
  --
  -- Two namespaces, matching the two unique indexes (0085 section 1): a
  -- project's keys, or an owner's project-less keys. Each branch tests only
  -- the columns its own index constrains, and the project-less branch states
  -- `project_id is null` explicitly -- without it, an owner who reused a key
  -- across a project image and a personal one would resolve the second to the
  -- first and be told it already completed.
  if p_project_id is not null then
    select r.id into v_existing_id
    from public.runs r
    where r.project_id = p_project_id
      and r.idempotency_key = p_idempotency_key
    limit 1;
  else
    select r.id into v_existing_id
    from public.runs r
    where r.project_id is null
      and r.user_id = v_owner_id
      and r.idempotency_key = p_idempotency_key
    limit 1;
  end if;

  if found then
    return query select 'duplicate'::text, v_existing_id, null::text, null::numeric;
    return;
  end if;

  -- THE UPPER BOUND OF EVERY SPEND READ, and why it is not simply p_now_ts.
  --
  -- p_now_ts is computed in TypeScript when the request starts -- which is
  -- BEFORE this transaction blocks on the lock above. Consider two requests
  -- racing for the last of a cap: A takes the lock, inserts its reservation with
  -- created_at = now(), and commits. B then acquires the lock and reads with
  -- to_ts = its own p_now_ts, computed before any of that happened. A's row is
  -- newer than that bound, so B does not see it, and both reserve. The lock
  -- would have serialized them correctly and the timestamps would have thrown
  -- it away.
  --
  -- clock_timestamp() is evaluated here, after the lock is held, so it is always
  -- later than the commit of any transaction that queued ahead of this one.
  -- greatest() keeps the caller's value when it is further ahead, so a caller
  -- asking about a wider window still gets one.
  -- greatest() is a SQL construct, not a schema-qualifiable function, and is
  -- unaffected by search_path.
  v_to_ts := greatest(p_now_ts, pg_catalog.clock_timestamp());

  -- Spend comes from the canonical functions, never from re-summing public.runs.
  -- Since 0040 both union in deleted_project_cost_history, and a re-sum would
  -- under-count anyone who has deleted a project -- letting them past their cap.
  -- Since 0085 user_spend_usd also counts project-less runs against their owner,
  -- which is what makes the reservation this function is about to write visible
  -- to the NEXT one. Same rule sidebar_budget_snapshot follows: call them, never
  -- reimplement them.
  --
  -- Ceilings are compared with `>`, not `>=`, and the reads happen before the
  -- insert. An account with room for exactly one image therefore gets it:
  -- spent + estimate = cap is not over the cap. This is the double-count bug
  -- this whole function exists to avoid, reduced to one operator.
  --
  -- Checked global -> weekly -> daily, and the FIRST breach is what blocked_by
  -- names. Order matters for the message, not the outcome: reporting a personal
  -- weekly cap when it is the company-wide budget that is exhausted would send
  -- someone to request an allowance that cannot help them.
  v_spent := public.spend_total_usd(p_day_start_ts, v_to_ts);
  if v_spent + p_estimate_usd > p_global_daily_cap_usd then
    return query select 'blocked'::text, null::uuid, 'global_daily'::text, v_spent;
    return;
  end if;

  v_spent := public.user_spend_usd(v_owner_id, p_week_start_ts, v_to_ts);
  if v_spent + p_estimate_usd > p_weekly_cap_usd then
    return query select 'blocked'::text, null::uuid, 'weekly'::text, v_spent;
    return;
  end if;

  if p_daily_cap_enabled then
    v_spent := public.user_spend_usd(v_owner_id, p_day_start_ts, v_to_ts);
    if v_spent + p_estimate_usd > p_daily_cap_usd then
      return query select 'blocked'::text, null::uuid, 'daily'::text, v_spent;
      return;
    end if;
  end if;

  -- Reserved: cost_usd is the ESTIMATE and settled_at is NULL, so this attempt
  -- counts against every cap from now until it settles. vendor is 'kie' because
  -- that is the only vendor this path has (web/lib/kie.ts:132 types it as the
  -- literal). created_at takes the column default rather than p_now_ts, so the
  -- row is stamped when it is actually written -- see the v_to_ts note above for
  -- why a caller-supplied time must not decide what counts.
  -- settled_at is passed explicitly as NULL against the column default of
  -- now(): this is the one writer in either service that means "not settled".
  --
  -- user_id is written on BOTH branches, not only the project-less one. On the
  -- project branch it is the same answer projects.user_id already gives, so it
  -- changes no aggregate (coalesce prefers it and they agree) -- and it is what
  -- keeps the attempt attributed if that project is later deleted mid-flight,
  -- when the row's project_id cascades away before the sweep can settle it.
  insert into public.runs (
    project_id, user_id, vendor, model, cost_usd, idempotency_key, settled_at
  )
  values (
    p_project_id, v_owner_id, 'kie', p_model, p_estimate_usd, p_idempotency_key, null
  )
  returning id into v_new_id;

  return query select 'reserved'::text, v_new_id, null::text, null::numeric;
end;
$$;

comment on function public.reserve_image_attempt(
  uuid, uuid, text, numeric, text, timestamptz, timestamptz, timestamptz,
  numeric, numeric, numeric, boolean
) is
  'Checks the global, weekly and optional daily ceilings and creates the reservation in ONE '
  'transaction, under a global-then-owner advisory lock. Returns exactly one of reserved / '
  'duplicate / blocked; only reserved writes a row. spent_usd is the spend measured against the '
  'ceiling named by blocked_by, and NULL otherwise. Exactly one of p_project_id / p_user_id '
  'identifies the attempt: with a project the owner is derived from the LOCKED project row and '
  'p_user_id is ignored (0083''s rule, unchanged); without one the owner is p_user_id, established '
  'by requireUser() in the Server Action, and idempotency is looked up in that owner''s '
  'project-less namespace instead (0085). Callers must NOT also call assertWithinSpendCaps: that '
  'would count the reservation twice.';

-- =============================================================================
-- 6. Lock the new signature down. The default is wide open.
-- =============================================================================
-- 0007_grants.sql grants execute on all functions in schema public to
-- `authenticated` AND sets the same as a DEFAULT PRIVILEGE for functions created
-- later -- which includes this one, newly created under a new signature. The
-- revoke from 0083 applied to the dropped 11-argument function and does not
-- carry over; without repeating it here, any signed-in browser client could
-- call this directly and spend money against an account it is not.
revoke execute on function public.reserve_image_attempt(
  uuid, uuid, text, numeric, text, timestamptz, timestamptz, timestamptz,
  numeric, numeric, numeric, boolean
) from public, anon, authenticated;

grant execute on function public.reserve_image_attempt(
  uuid, uuid, text, numeric, text, timestamptz, timestamptz, timestamptz,
  numeric, numeric, numeric, boolean
) to service_role;
