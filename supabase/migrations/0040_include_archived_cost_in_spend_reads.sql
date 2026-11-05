-- =============================================================================
-- The read side of 0038_preserve_cost_history_on_delete.sql
--
-- 0038 stopped a deleted project's spend from being destroyed: it archives
-- every reachable `runs` row into `deleted_project_cost_history` one step
-- ahead of the cascade. But every aggregate that answers "how much has this
-- account/the team spent" still only sums `runs` — 0038's own header lists
-- them (spend_total_usd / spend_totals_by_user / project_cost_totals, plus
-- lib/spend.ts's daily/weekly/global caps) and says plainly "the read side
-- was never updated." That is what this migration does. An editor who
-- deletes a finished project must not get their daily/weekly ceiling back —
-- the archive already has the dollars, they just weren't being read.
--
-- ---------------------------------------------------------------------------
-- 1. deleted_project_cost_history gets a real user_id
-- ---------------------------------------------------------------------------
-- The archive only ever stored owner_email (0038: "there is ... no profiles
-- row to read an email from either" after the delete, so email was
-- snapshotted). Four of the six reads below are PER-USER
-- (user_spend_usd, spend_totals_by_user, spend_category_totals_by_user,
-- account_spend_windows) and none of them has anything to join an email
-- against — every other per-user read in this schema (user_spend_usd,
-- 0031; RLS's runs_select, 0030) keys on profiles.id, never on email, and
-- for good reason: email can change, and it is denormalised, not identity.
--
-- user_id uuid, no FK — same reasoning 0038's header gives for project_id/
-- scene_id having none: a FK to profiles(id) would either reject the
-- insert (irrelevant here, the profile is very much still alive at archive
-- time) or, worse, invite an `on delete cascade` that wipes archived cost
-- history the moment the ACCOUNT is later deleted — re-arming a smaller
-- version of the exact bug 0038 closed. Bare uuid, expected to dangle if
-- the account is ever removed, exactly like project_id/scene_id are
-- expected to dangle once the project/scene is gone.
--
-- Going forward (both triggers, see below), user_id is set directly from
-- the project row being deleted — projects.user_id is `not null`
-- (0001_init.sql), so it is always available at archive time and needs no
-- email round-trip at all. The email-based backfill below is ONLY for rows
-- archived before this column existed.
alter table deleted_project_cost_history add column user_id uuid;

comment on column deleted_project_cost_history.user_id is
  'The deleted project''s owning account (profiles.id), snapshotted at archive time directly from '
  'projects.user_id (not null) -- see this migration''s header for why this exists (four of the six '
  'spend reads are per-user and had nothing to join owner_email against) and why it has no FK (same '
  'reasoning as project_id/scene_id: the referent may legitimately be gone later). Rows archived '
  'before this column existed are backfilled from profiles by email where exactly one match exists; '
  'left NULL where none does -- that is honest, not a bug, and those rows still count in every '
  'TEAM-WIDE total (spend_total_usd, spend_category_totals) even though they cannot appear in a '
  'PER-USER breakdown.';

-- Backfill: email is not unique-constrained in this schema (profiles has no
-- `unique (email)`), so this is a best-effort match, not a guaranteed one --
-- `limit 1` picks an arbitrary row on a duplicate rather than failing the
-- migration. Every row written from here on gets an authoritative user_id
-- straight from projects.user_id (see the trigger changes below), so this
-- update only ever touches history that predates this column.
update deleted_project_cost_history h
set user_id = (
  select p.id
  from profiles p
  where p.email = h.owner_email
  limit 1
)
where h.user_id is null
  and h.owner_email is not null;

-- Decision on owner_email: KEEP it. It stays the only human-readable trace
-- once a profiles row itself is gone (account deleted after the project),
-- and 0038's header already made this argument for project_title/
-- owner_email as snapshots. What changes here is that it stops being
-- treated as a key -- every read below joins/filters on user_id, never on
-- owner_email; owner_email is display-only from this migration forward.

-- Indexes for the reads added below: a per-user, time-windowed filter
-- (user_spend_usd, spend_totals_by_user, spend_category_totals_by_user,
-- account_spend_windows) and a team-wide, time-windowed filter
-- (spend_total_usd, spend_category_totals). 0038 deliberately added no
-- indexes beyond the primary key ("nothing reads this table yet ... the
-- first reader should add the index its own query actually needs") -- this
-- migration is that first reader.
create index deleted_project_cost_history_user_id_run_created_at_idx
  on deleted_project_cost_history (user_id, run_created_at);

create index deleted_project_cost_history_run_created_at_idx
  on deleted_project_cost_history (run_created_at);

-- ---------------------------------------------------------------------------
-- 2. Both triggers now set user_id, going forward
-- ---------------------------------------------------------------------------
-- Both, not one: 0038's header is explicit that a projects-only fix "reads
-- as fixed" while leaving the scene-only-delete path quiet and broken.
-- Missing user_id on one of the two would produce an archive that is
-- correct for one delete path and silently useless for the other -- the
-- exact failure shape this whole file exists to close, one level down.

create or replace function public.archive_project_cost_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_email    text;
  project_id_where text := '';
begin
  select email into v_owner_email from profiles where id = OLD.user_id;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'runs'
      and column_name = 'project_id'
  ) then
    -- 0030's scene-less runs: compiles, character/composite image generation.
    -- They hang off the project directly and are unreachable via scenes.
    project_id_where := ' or r.project_id = $1';
  end if;

  -- $1 = project id, $2 = title snapshot, $3 = owner email snapshot,
  -- $4 = owner user_id snapshot (projects.user_id, not null -- no lookup
  -- needed, unlike v_owner_email above which has to go through profiles).
  -- The two predicates are OR'd and there is no AND anywhere in the WHERE, so
  -- the concatenated clause means what it reads as without parenthesisation.
  execute
    'insert into deleted_project_cost_history (
       run_id, scene_id, project_id, vendor, model, cost_usd, latency_ms,
       error, run_created_at, project_title, owner_email, user_id
     )
     select r.id, r.scene_id, $1, r.vendor, r.model, r.cost_usd, r.latency_ms,
            r.error, r.created_at, $2, $3, $4
     from runs r
     where r.scene_id in (select id from scenes where project_id = $1)'
    || project_id_where ||
    ' on conflict (run_id) do nothing'
  using OLD.id, OLD.title, v_owner_email, OLD.user_id;

  return OLD;
end;
$$;

comment on function public.archive_project_cost_history is
  'BEFORE DELETE on projects: copies every runs row reachable from the project -- through '
  'runs.scene_id -> scenes.project_id, and through runs.project_id directly where 0030 has been '
  'applied -- into deleted_project_cost_history before the ON DELETE CASCADE destroys it. Title, '
  'owner email and owner user_id are snapshotted from OLD/profiles at this moment because none is '
  'readable once the delete completes. user_id added by 0040_include_archived_cost_in_spend_reads.sql '
  '-- taken directly from OLD.user_id (projects.user_id is not null), no profiles lookup needed.';

create or replace function public.archive_scene_cost_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- v_ prefixed on purpose: unprefixed `project_title`/`owner_email` locals
  -- would shadow the identically-named columns in the INSERT below, and
  -- plpgsql's default variable_conflict = error turns that class of shadowing
  -- into a runtime failure inside a DELETE -- the worst place to find it.
  v_project_title text;
  v_owner_email   text;
  v_owner_user_id uuid;
begin
  select p.title, prof.email, p.user_id
    into v_project_title, v_owner_email, v_owner_user_id
  from projects p
  left join profiles prof on prof.id = p.user_id
  where p.id = OLD.project_id;

  insert into deleted_project_cost_history (
    run_id, scene_id, project_id, vendor, model, cost_usd, latency_ms,
    error, run_created_at, project_title, owner_email, user_id
  )
  select r.id, r.scene_id, OLD.project_id, r.vendor, r.model, r.cost_usd,
         r.latency_ms, r.error, r.created_at, v_project_title, v_owner_email,
         v_owner_user_id
  from runs r
  where r.scene_id = OLD.id
  on conflict (run_id) do nothing;

  return OLD;
end;
$$;

comment on function public.archive_scene_cost_history is
  'BEFORE DELETE on scenes: the same archiving as archive_project_cost_history but scoped to one '
  'scene, so deleting a scene on its own (without its project) cannot erase its render history '
  'either. Also fires redundantly for scenes removed by a project cascade; that duplicate loses to '
  'ON CONFLICT (run_id) DO NOTHING -- see that trigger''s own comment for why the SAME reasoning '
  'means this trigger''s v_owner_user_id lookup below would fail (NULL) for a cascade-fired scene '
  'delete, and why that is fine: the projects trigger''s row already won the conflict by then. '
  'user_id added by 0040_include_archived_cost_in_spend_reads.sql, read from projects.user_id '
  'alongside the existing title/email lookup -- one extra column, no extra query.';

-- ---------------------------------------------------------------------------
-- Why no union below can ever double-count a run
-- ---------------------------------------------------------------------------
-- Every query below UNION ALLs "live runs in range" with "archived runs in
-- range". This is safe -- a run_id can never appear on both sides -- for two
-- separate, both load-bearing reasons:
--
--   1. Within the archive itself: deleted_project_cost_history.run_id is the
--      PRIMARY KEY (0038), and both triggers insert with
--      `on conflict (run_id) do nothing`. A project delete fires the
--      projects trigger AND (via the cascade) the scenes trigger for the
--      same runs; the second write is always a no-op. So the archive itself
--      holds each run_id at most once, verified unchanged by this migration
--      -- neither trigger's INSERT ... ON CONFLICT clause was touched above,
--      only the column list grew by one.
--   2. Between `runs` and the archive: both triggers are BEFORE DELETE, so a
--      row is copied into the archive in the same transaction that goes on
--      to delete it from `runs`. By the time either transaction commits, a
--      given run_id is in exactly one of the two tables, never both, and
--      nothing in this codebase ever re-inserts into `runs` with a
--      previously-used id (`runs.id` is `gen_random_uuid() primary key`,
--      0001_init.sql). So "live runs in range" and "archived runs in range"
--      are, at every instant after commit, disjoint sets, and UNION ALL
--      (which does not itself deduplicate) never needs to -- there is
--      nothing to deduplicate.
--
-- ---------------------------------------------------------------------------
-- 3. The six reads
-- ---------------------------------------------------------------------------
-- Every filter below uses run_created_at, never deleted_at -- see 0038's own
-- column comment: deleted_at is when the row was archived (i.e. when the
-- project/scene was deleted), and using it as a spend date would move a
-- cost to the day it was deleted, corrupting every historical figure. Only
-- run_created_at answers "when was this money actually spent."
--
-- Signature, return type, STABLE, SECURITY setting and grants are
-- byte-for-byte unchanged from each function/view's current definition
-- (0026/0030/0031/0037) below -- only the query body gains a UNION ALL
-- branch. web/lib/db-aggregates.ts's callers need no changes.

-- spend_total_usd (0026) -- team-wide, SECURITY INVOKER (unchanged: see
-- 0026's header for why INVOKER is correct here, not DEFINER). Because this
-- runs as the CALLER, and deleted_project_cost_history's RLS is
-- admin-select-only (0038), a non-admin caller sees zero archive rows here
-- -- exactly the same posture 0026's header already describes for live
-- runs ("a non-admin calling either function would only ever see their own
-- runs"; archived rows belong to the admin-only audience 0038 defines).
create or replace function spend_total_usd(from_ts timestamptz, to_ts timestamptz)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(t.cost_usd), 0)
  from (
    -- Live runs in range.
    select r.cost_usd
    from runs r
    where r.created_at >= from_ts and r.created_at < to_ts

    union all

    -- Runs whose project/scene was later deleted, rescued by 0038's
    -- triggers. See the double-count comment above for why this can never
    -- overlap the branch above.
    select h.cost_usd
    from deleted_project_cost_history h
    where h.run_created_at >= from_ts and h.run_created_at < to_ts
  ) t;
$$;

comment on function spend_total_usd is
  'Total cost_usd for runs created in [from_ts, to_ts), including runs whose project/scene was '
  'since deleted (archived by 0038_preserve_cost_history_on_delete.sql; unioned in by '
  '0040_include_archived_cost_in_spend_reads.sql). Replaces summing an unbounded, max_rows-capped '
  'select in application code (see 0026_cost_aggregates.sql''s header) -- backs /spend''s Today and '
  'This month tiles.';

-- user_spend_usd (0031) -- per user, SECURITY INVOKER (unchanged).
create or replace function user_spend_usd(target_user_id uuid, from_ts timestamptz, to_ts timestamptz)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(t.cost_usd), 0)
  from (
    -- Live runs, this user's projects only.
    select r.cost_usd
    from runs r
    join projects p on p.id = r.project_id
    where p.user_id = target_user_id
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
  'burst guard and the weekly allowance (lib/spend.ts). Joins runs -> projects via runs.project_id '
  'directly, matching 0030_runs_project_id.sql''s runs_select RLS policy and lib/spend.ts''s '
  'getDailySpend.';

-- spend_totals_by_user (0026, redefined by 0030) -- per user, SECURITY
-- INVOKER (unchanged). Archived rows with no resolved user_id (pre-0040
-- history with no matching profiles email -- see part 1 above) cannot be
-- attributed to any user and are excluded from this breakdown; they still
-- count in spend_total_usd's team-wide figure above, so the money is never
-- lost, only unattributed at the per-user grain. max(t.email): the archive
-- side re-resolves email from the CURRENT profiles row (matching the live
-- side's own `left join profiles`) rather than trusting the frozen
-- owner_email snapshot, so a renamed/re-emailed account reads consistently
-- across both branches; max() is just how to carry a single-valued column
-- through a GROUP BY it isn't grouped on.
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
    select p.user_id, prof.email, r.cost_usd
    from runs r
    join projects p on p.id = r.project_id
    left join profiles prof on prof.id = p.user_id
    where r.created_at >= from_ts and r.created_at < to_ts

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
  '0040_include_archived_cost_in_spend_reads.sql). Archived rows with no resolved user_id are '
  'excluded from this per-user breakdown (still counted team-wide by spend_total_usd) -- see that '
  'migration''s header. Joins runs -> projects via runs.project_id directly (not through scenes) '
  'since 0030_runs_project_id.sql, so a scene-less run counts toward its owner''s total too.';

-- spend_category_totals (0037) -- team-wide, SECURITY INVOKER (unchanged;
-- see 0037's header for why total_usd = iterate_usd + render_usd is
-- guaranteed by construction -- same FILTER-over-one-scan shape preserved
-- here, just over the unioned row set instead of a bare `runs` scan).
-- Category split: vendor/model are exactly what 0037's CASE already keys
-- on (`vendor = 'fal' and model like '%image-to-video%'`), and
-- deleted_project_cost_history carries both columns verbatim from runs
-- (0038) -- so the identical predicate reproduces the identical split with
-- no new classification logic.
create or replace function spend_category_totals(from_ts timestamptz, to_ts timestamptz)
returns table(iterate_usd numeric, render_usd numeric, total_usd numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(sum(t.cost_usd) filter (
      where not (t.vendor = 'fal' and t.model like '%image-to-video%')
    ), 0) as iterate_usd,
    coalesce(sum(t.cost_usd) filter (
      where t.vendor = 'fal' and t.model like '%image-to-video%'
    ), 0) as render_usd,
    coalesce(sum(t.cost_usd), 0) as total_usd
  from (
    select r.cost_usd, r.vendor, r.model
    from runs r
    where r.created_at >= from_ts and r.created_at < to_ts

    union all

    select h.cost_usd, h.vendor, h.model
    from deleted_project_cost_history h
    where h.run_created_at >= from_ts and h.run_created_at < to_ts
  ) t;
$$;

comment on function spend_category_totals is
  'Team-wide iterate-vs-render split for runs created in [from_ts, to_ts), including archived runs '
  'from deleted projects/scenes (0038; unioned in by 0040_include_archived_cost_in_spend_reads.sql) '
  '-- see 0037_spend_category_totals.sql''s header for the category rule (vendor/model, carried '
  'verbatim into the archive, so the same predicate applies unchanged) and why total_usd is '
  'guaranteed to equal iterate_usd + render_usd. Backs /spend''s breakdown tile.';

-- spend_category_totals_by_user (0037) -- per user, SECURITY INVOKER
-- (unchanged). Same category predicate and same user_id-only attribution
-- as spend_totals_by_user above.
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
      where not (t.vendor = 'fal' and t.model like '%image-to-video%')
    ), 0) as iterate_usd,
    coalesce(sum(t.cost_usd) filter (
      where t.vendor = 'fal' and t.model like '%image-to-video%'
    ), 0) as render_usd,
    coalesce(sum(t.cost_usd), 0) as total_usd
  from (
    select p.user_id, prof.email, r.cost_usd, r.vendor, r.model
    from runs r
    join projects p on p.id = r.project_id
    left join profiles prof on prof.id = p.user_id
    where r.created_at >= from_ts and r.created_at < to_ts

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
  'archived runs from deleted projects/scenes (0038; unioned in by '
  '0040_include_archived_cost_in_spend_reads.sql). Archived rows with no resolved user_id are '
  'excluded from this per-user breakdown, same reasoning as spend_totals_by_user. Joins runs -> '
  'projects directly (matching user_spend_usd and RLS''s own runs_select) rather than through '
  'scenes. Backs /spend''s Per-user totals table.';

-- account_spend_windows (0031, view) -- per user, security_invoker
-- (unchanged). Same Asia/Manila day/week boundaries as before (see 0031's
-- header for the timezone reasoning, mirrored exactly in lib/spend.ts) --
-- only the LATERAL subqueries gain an archive branch each.
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
    join projects pr on pr.id = r.project_id
    where pr.user_id = p.id
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
    join projects pr on pr.id = r.project_id
    where pr.user_id = p.id
      and r.created_at >= (date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')

    union all

    select h.cost_usd
    from deleted_project_cost_history h
    where h.user_id = p.id
      and h.run_created_at >= (date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')
  ) x
) week on true;

comment on view account_spend_windows is
  'Per-account spend for the current Asia/Manila day and the current Asia/Manila calendar week '
  '(Monday start), including archived runs from that account''s deleted projects/scenes (0038; '
  'unioned in by 0040_include_archived_cost_in_spend_reads.sql) -- see 0031_account_allowances.sql''s '
  'header for why the two windows use Asia/Manila and calendar-week boundaries, matching '
  'lib/spend.ts exactly, and this migration''s header for why run_created_at (not deleted_at) is the '
  'correct filter column. Caps are NOT in this view -- /users resolves those in application code via '
  'lib/spend.ts''s resolveAccountCaps(profile).';

-- ---------------------------------------------------------------------------
-- Deliberately left alone: user_active_grants_usd, user_active_grants_usd_
-- by_user (0032/0033), outstanding_allowance_usd (0035). All three read
-- allowance_grants, not runs -- they answer "how much has been GRANTED,"
-- not "how much has been SPENT," so 0038's archive has nothing they need.
-- =============================================================================
