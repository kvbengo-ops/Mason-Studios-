-- =============================================================================
-- Cost history must outlive the project it was spent on
--
-- Deleting one project today destroys that project's entire spend record.
-- Not "hides", not "detaches" — destroys. `scenes.project_id` and
-- `assets.project_id` are `on delete cascade` (0001_init.sql), `runs.scene_id`
-- is `on delete cascade` onto scenes, and 0030_runs_project_id.sql added
-- `runs.project_id` with `on delete cascade` as well. So a single
-- `delete from projects where id = ?` fans out to scenes, then to every
-- `runs` row hanging off those scenes, plus every scene-less run attributed
-- straight to the project. web/actions/project.ts's deleteProject documents
-- this in its own doc comment ("and, via ON DELETE CASCADE, its
-- scenes/assets/runs") — it is doing exactly what the schema told it to do.
-- The schema is what is wrong.
--
-- What goes with those rows is the money: vendor, model, cost_usd, latency,
-- the error text, and the timestamp of every render attempt that project ever
-- paid for. 0001_init.sql's own comment on `runs` states the contract this
-- breaks — "One row per render attempt, not per success. Retries and failures
-- are where the budget actually goes — this is how a month's spend gets
-- explained." A ledger any user can silently zero out by deleting a project
-- does not explain a month's spend; it explains whatever is left of it.
--
-- ---------------------------------------------------------------------------
-- Why this matters more since 0031/0032
-- ---------------------------------------------------------------------------
-- These numbers stopped being merely informational. 0031_account_allowances
-- and 0032_allowance_requests built an approval workflow on top of them: an
-- approver reads a user's spend to decide whether to grant more budget, and
-- 0030_runs_project_id.sql's header already made the point that "a `runs`
-- total that is missing real spend is not a reporting bug, it is an approval
-- granted against a number smaller than the truth." Cascade deletion is that
-- same failure with a sharper edge, because it is reachable on purpose: a
-- user who has burned through their allowance can delete the projects that
-- burned it, and every aggregate reading `runs` — the per-user daily cap
-- (web/lib/spend.ts getDailySpend), the global cap (getGlobalDailySpend),
-- spend_total_usd / spend_totals_by_user / project_cost_totals (0026),
-- user_directory (0028), project_directory (0029) — reports the smaller
-- number, honestly and immediately. Nothing in the codebase logs that the
-- rows ever existed. There is no soft delete anywhere in this schema and no
-- audit table; once the cascade runs, the only record that the spend ever
-- happened is the vendor's invoice.
--
-- ---------------------------------------------------------------------------
-- The fix: archive before the cascade, not instead of it
-- ---------------------------------------------------------------------------
-- Deliberately NOT changed here: the cascades themselves, and not one line of
-- web code. Delete must keep meaning delete — the project disappears from
-- /projects, its scenes and assets go with it, deleteProject keeps its single
-- `delete from projects` and needs no knowledge that any of this exists. The
-- requirement is only that the *cost* survives, so this migration copies the
-- runs out one step ahead of the cascade with BEFORE DELETE triggers, and
-- lets the cascade proceed untouched. Anything else — flipping the FKs to
-- `on delete set null`, or a soft-delete flag — would leave the orphaned runs
-- inside the live `runs` table, where all seven aggregates above would keep
-- summing them into a project that no longer exists: a disappearing-money bug
-- turned into a phantom-money bug.
--
-- ---------------------------------------------------------------------------
-- Why the archive table has no foreign keys at all
-- ---------------------------------------------------------------------------
-- This is the whole point of the table and the one thing not to "clean up"
-- later. A tidier-looking `run_id uuid references runs(id)` or
-- `project_id uuid references projects(id)` would be self-defeating in the
-- most literal way: the rows this table exists to preserve are, by
-- construction, rows whose parents are being deleted in the very same
-- transaction that writes here. An FK would either fail the insert outright
-- (the parent is gone by commit) or — if written `on delete cascade`, matching
-- the surrounding style — re-arm the exact bug this migration closes and
-- cascade-wipe the archive milliseconds after it was populated. Plain columns
-- only. `project_id` and `scene_id` are kept as bare uuids for correlation,
-- and they are expected to point at rows that no longer exist.
--
-- The same reasoning drives project_title and owner_email being *snapshots*
-- rather than joins: after the delete there is no projects row to read a
-- title from and, if the owning account is ever removed, no profiles row to
-- read an email from either. A cost ledger nobody can attribute to a human is
-- only marginally better than no ledger, so the human-readable identity is
-- copied in at archive time and frozen. Both are intentionally redundant with
-- project_id/scene_id, and intentionally not kept in sync afterwards — a
-- later project rename does not rewrite history here, which is the correct
-- behaviour for an archive.
--
-- run_id is the PRIMARY KEY, which is what makes archiving idempotent, and
-- that is load-bearing rather than decorative. Deleting a project fires the
-- projects trigger (which archives every run reachable from the project,
-- including those reached through its scenes) and then, as the cascade tears
-- down each scene, fires the scenes trigger for the same rows all over again.
-- Both triggers are wanted — the scenes one has to stand alone for a
-- single-scene delete — so the second insert is simply allowed to lose, via
-- `on conflict (run_id) do nothing`. A runs row can only ever be deleted
-- once, so uniqueness on the original id is exactly the right key. Note the
-- ordering consequence: during a project delete the projects trigger writes
-- its row first, and that is the copy carrying the correct title and email
-- (see the scenes function below for why the cascade-fired copy cannot).
--
-- ---------------------------------------------------------------------------
-- Both entry points, because both are reachable
-- ---------------------------------------------------------------------------
-- A trigger on projects alone would leave the other half open. Scenes are
-- deletable on their own, without their project going anywhere, and a scene
-- that has been rendered several times carries the most expensive history in
-- the schema. So the same archiving runs BEFORE DELETE on scenes, scoped to
-- that one scene. Covering only the project case would fix the loud version
-- of this bug and leave the quiet one, which is worse — it reads as fixed.
--
-- What is deliberately NOT covered: a direct `delete from runs`. Nothing in
-- web or worker does that (runs are insert-only in both services), so a
-- trigger there would guard a caller that does not exist; if one is ever
-- written, the honest fix is to not write it.
-- =============================================================================

create table deleted_project_cost_history (
  -- The original runs.id. PRIMARY KEY, not a plain column: see the header —
  -- a project delete archives the same run twice (once via the projects
  -- trigger, once as the cascade fires the scenes trigger) and this is what
  -- makes the second one a no-op instead of a duplicate charge in the
  -- archive. No FK to runs(id); the referent is gone by design.
  run_id         uuid primary key,

  -- Correlation only. Both are expected to dangle — the scene and project
  -- they name are deleted in the same transaction that writes this row.
  -- scene_id is null for a scene-less run (0030: compiles, character and
  -- composite image generation).
  scene_id       uuid,
  project_id     uuid,

  -- Copied verbatim from runs. numeric(10,4) matches runs.cost_usd exactly
  -- (0001_init.sql) so an archived dollar reads identically to a live one;
  -- widening or narrowing it here would quietly re-round the history.
  vendor         text,
  model          text,
  cost_usd       numeric(10, 4),
  latency_ms     int,
  error          text,

  -- The ORIGINAL runs.created_at — when the money was actually spent. Named
  -- distinctly from deleted_at because the two answer different questions,
  -- and conflating them would put every archived attempt in the wrong month.
  run_created_at timestamptz,

  -- Snapshots, frozen at archive time. See the header: after the delete there
  -- is nothing left to join to for either of these.
  project_title  text,
  owner_email    text,

  -- When the archiving happened, i.e. when the project or scene was deleted.
  deleted_at     timestamptz not null default now()
);

comment on table deleted_project_cost_history is
  'Spend history rescued from ON DELETE CASCADE. Every runs row reachable from a project or scene is '
  'copied here by a BEFORE DELETE trigger, one step ahead of the cascade that is about to destroy it '
  '(0001_init.sql''s cascades; web/actions/project.ts deleteProject). Deliberately has NO foreign keys '
  'to projects/scenes/runs: the rows it preserves are precisely the ones whose parents are being '
  'deleted in the same transaction, so an FK would either reject the insert or cascade-wipe the '
  'archive itself. project_id/scene_id are bare uuids that are EXPECTED to dangle; project_title and '
  'owner_email are snapshots frozen at delete time, not live joins, and are not kept in sync '
  'afterwards. Append-only: nothing in web or worker writes here except these triggers.';

comment on column deleted_project_cost_history.run_created_at is
  'The original runs.created_at — when the spend happened. Distinct from deleted_at (when the row was '
  'archived); using deleted_at as a spend date would misdate every archived attempt.';

-- No indexes beyond the primary key. Nothing reads this table yet — it exists
-- so the history is *recoverable*, and the first reader (a /spend view that
-- includes deleted projects, say) should add the index its own query actually
-- needs rather than one guessed at here.

-- ---------------------------------------------------------------------------
-- projects BEFORE DELETE
-- ---------------------------------------------------------------------------
-- BEFORE, not AFTER: an AFTER DELETE trigger on projects fires once the
-- cascade has already run, by which point there is nothing left in `runs` to
-- copy. The whole mechanism depends on getting in front of it.
--
-- security definer, matching 0004_profile_trigger.sql: the function must be
-- able to write the archive regardless of who is doing the deleting. In
-- practice deleteProject uses the service-role client (which bypasses RLS
-- anyway), but an authenticated user deleting their own project through their
-- session client must not silently fail to archive — and, per the RLS block
-- at the end of this file, `authenticated` is given no insert path here on
-- purpose. Running as the table owner is what lets the trigger write rows
-- nobody else may write. `set search_path = public` for the usual reason a
-- security-definer function needs one.
--
-- The dynamic EXECUTE exists for exactly one reason: runs.project_id is added
-- by 0030_runs_project_id.sql, whose own header records that it was written
-- but deliberately NOT applied. A plpgsql function body is parsed on first
-- execution, not at create time, so a static reference to a column that isn't
-- there yet would not fail here at migration time — it would fail at 3am, on
-- a user's delete, with the archiving already half-skipped. Checking the
-- catalog and splicing the predicate keeps this migration correct against a
-- database at either revision. The cost is one catalog lookup per deleted
-- project, which is not a hot path by any measure.
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

  -- $1 = project id, $2 = title snapshot, $3 = owner email snapshot.
  -- The two predicates are OR'd and there is no AND anywhere in the WHERE, so
  -- the concatenated clause means what it reads as without parenthesisation.
  execute
    'insert into deleted_project_cost_history (
       run_id, scene_id, project_id, vendor, model, cost_usd, latency_ms,
       error, run_created_at, project_title, owner_email
     )
     select r.id, r.scene_id, $1, r.vendor, r.model, r.cost_usd, r.latency_ms,
            r.error, r.created_at, $2, $3
     from runs r
     where r.scene_id in (select id from scenes where project_id = $1)'
    || project_id_where ||
    ' on conflict (run_id) do nothing'
  using OLD.id, OLD.title, v_owner_email;

  return OLD;
end;
$$;

comment on function public.archive_project_cost_history is
  'BEFORE DELETE on projects: copies every runs row reachable from the project — through '
  'runs.scene_id -> scenes.project_id, and through runs.project_id directly where 0030 has been '
  'applied — into deleted_project_cost_history before the ON DELETE CASCADE destroys it. Title and '
  'owner email are snapshotted from OLD/profiles at this moment because neither is readable once the '
  'delete completes.';

create trigger projects_archive_cost_history
  before delete on projects
  for each row execute function public.archive_project_cost_history();

-- ---------------------------------------------------------------------------
-- scenes BEFORE DELETE
-- ---------------------------------------------------------------------------
-- Standalone scene deletion, which the projects trigger above cannot see.
-- Scoped to OLD.id: a scene's runs are exactly `runs.scene_id = OLD.id`.
-- No dynamic SQL here — runs.scene_id has existed since 0001_init.sql, and a
-- scene-less run is by definition not reachable from any scene.
--
-- This also fires for every scene taken down by a project's cascade, which is
-- redundant but harmless: the projects trigger has already archived those
-- rows and `on conflict (run_id) do nothing` drops this second copy. That
-- ordering matters for the snapshot columns. FK cascade deletion runs as an
-- AFTER trigger on projects, so by the time the cascade reaches scenes the
-- projects row is already gone from this transaction's view and the lookup
-- below finds nothing — this function would archive a NULL title and email.
-- It never gets to, because the projects trigger's row is already there and
-- wins the conflict. Left as-is deliberately rather than "fixed" with a
-- lookup that cannot succeed: for the case this trigger actually exists to
-- serve — a scene deleted on its own — the project is still very much there
-- and both snapshots populate normally.
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
  -- into a runtime failure inside a DELETE — the worst place to find it.
  v_project_title text;
  v_owner_email   text;
begin
  select p.title, prof.email
    into v_project_title, v_owner_email
  from projects p
  left join profiles prof on prof.id = p.user_id
  where p.id = OLD.project_id;

  insert into deleted_project_cost_history (
    run_id, scene_id, project_id, vendor, model, cost_usd, latency_ms,
    error, run_created_at, project_title, owner_email
  )
  select r.id, r.scene_id, OLD.project_id, r.vendor, r.model, r.cost_usd,
         r.latency_ms, r.error, r.created_at, v_project_title, v_owner_email
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
  'ON CONFLICT (run_id) DO NOTHING.';

create trigger scenes_archive_cost_history
  before delete on scenes
  for each row execute function public.archive_scene_cost_history();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Admin-only reads, and no write path for anyone but the triggers.
--
-- select is gated on is_admin() alone rather than the usual
-- `p.user_id = auth.uid() or is_admin()` shape used everywhere else
-- (0002_rls.sql, 0030's runs policies): that shape needs a live projects row
-- to check ownership against, and this table's entire premise is that the
-- projects row is gone. There is nothing left to join to, so ownership cannot
-- be established here at all — and this data (what a named account spent,
-- with their email) belongs to the same audience as /spend and /users, which
-- are already admin-only via guard.ts's requireAdmin().
--
-- No insert/update/delete policies at all, which under RLS means `deny` for
-- `authenticated` even though 0007_grants.sql grants it the table-level
-- privilege. That is the intent: this is an append-only audit table, and the
-- one thing that may append to it is a trigger. The triggers are unaffected —
-- they are security definer and run as the table owner, who is exempt from
-- RLS (there is no `force row level security` here). service_role likewise
-- bypasses RLS by design (0007_grants.sql), so the Go worker and the Server
-- Actions are unaffected too.
--
-- 0007_grants.sql's `alter default privileges` already covers this table's
-- grants for service_role and authenticated, so no explicit grant is needed.
alter table deleted_project_cost_history enable row level security;

create policy deleted_project_cost_history_select on deleted_project_cost_history
  for select
  using (is_admin());
