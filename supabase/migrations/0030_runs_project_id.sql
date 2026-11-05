-- =============================================================================
-- runs.project_id — the missing attribution that let two whole classes of
-- spend go unrecorded, found while wiring the spend ledger up to feed an
-- approval-workflow feature (docs/Account_Usage_and_Cost_Control_Plan_
-- Proposal.md): an approver reads these numbers to decide whether to grant
-- more budget, so a `runs` total that is missing real spend is not a
-- reporting bug, it is an approval granted against a number smaller than
-- the truth.
--
-- ---------------------------------------------------------------------------
-- The gap this closes
-- ---------------------------------------------------------------------------
-- Before this migration, every cost aggregate in the schema — the per-user
-- daily cap (web/lib/spend.ts's getDailySpend), the per-project total
-- (project_cost_totals, 0026), the per-user breakdown (spend_totals_by_user,
-- 0026), and the two sortable directory views (user_directory 0028,
-- project_directory 0029) — attributes a `runs` row to a user/project by
-- joining runs -> scenes -> projects on runs.scene_id. That is correct for
-- every video render (the Go worker's dispatch/webhook/reconcile paths,
-- worker/internal/store/store.go's MarkDone/MarkFailed), which always has a
-- scene. It silently drops every run that doesn't: runs.scene_id has been
-- nullable since 0001_init.sql, specifically as the hook for a paid call
-- with no scene to attach to — a full-script Claude compile
-- (web/actions/compile.ts), a single-scene Apply/Split compile before the
-- scene exists yet in some flows (web/actions/brief.ts), a character
-- reference or product-composite image generation
-- (web/actions/character.ts, web/actions/character-library.ts). Those are
-- project-level costs, not scene-level ones, and this schema had no way to
-- say "this run belongs to project X" without a scene in between. A run
-- with scene_id NULL doesn't fail those joins loudly — `s.id = runs.scene_id`
-- with scene_id NULL is simply never true, so the row is quietly absent
-- from every SUM(), exactly the "reads as $0" failure mode this whole
-- change exists to close (see the sibling change to web/actions/*.ts and
-- worker/internal/store/store.go's MarkFailed in the same commit for the
-- other half of this: recording those calls at all).
--
-- runs.scene_id -> scenes.project_id -> projects.user_id is also two hops
-- for something every one of the five queries above needs directly: "which
-- project (and therefore which user) does this dollar belong to." Adding
-- project_id lets every one of them join runs -> projects in one step,
-- correctly counting scene-having AND scene-less runs alike, instead of
-- teaching five different queries a second, parallel "or scene_id IS NULL,
-- so also check ??? " special case that has no scene to fall back to.
--
-- ---------------------------------------------------------------------------
-- Why nullable, not NOT NULL
-- ---------------------------------------------------------------------------
-- Every writer of `runs` after this migration sets project_id EXCEPT one:
-- web/actions/character-library.ts's createCharacterFromDescription
-- generates a Character Library entry's reference photo, and the library is
-- deliberately shared across every project (0020_characters.sql) rather
-- than owned by one — there is no project to attribute that cost to, the
-- same way a library character's photo has no project-scoped storage path
-- either. Forcing NOT NULL here would mean either inventing a fake project
-- to hang the row off of (a lie the schema would then treat as truth
-- everywhere else that reads project_id) or leaving that one call site
-- unrecorded again — the exact gap this migration exists to close, just
-- moved one call site over. Nullable, mirroring runs.scene_id's own
-- nullability one level up: most runs have a project, some legitimately
-- don't, and the column says so honestly instead of every reader having to
-- learn the exception by reading application code.
--
-- The real cost of leaving it nullable: a project-less run is invisible to
-- the PER-USER daily cap (web/lib/spend.ts's getDailySpend, which — after
-- this migration — finds a user by joining runs -> projects on
-- runs.project_id; nothing to join to project-less means nothing to find)
-- and to the per-project/per-user breakdown views below. It is NOT invisible
-- to the GLOBAL daily cap or to /spend's Today/This month tiles
-- (spend_total_usd, unaffected by this migration — see below): that
-- function has never joined through anything, so a project-less run's cost
-- is counted there like any other. Documented here plainly, and at
-- createCharacterFromDescription's own call site, rather than left for the
-- next person to discover: this is a real, scoped, honestly-labeled gap on
-- one admin-only, library-wide action — not a claim that every dollar this
-- migration touches is now airtight-attributed to a specific editor.
--
-- ---------------------------------------------------------------------------
-- The four aggregates updated to use it
-- ---------------------------------------------------------------------------
-- project_cost_totals (view, 0026), spend_totals_by_user (function, 0026),
-- user_directory's spend subquery (view, 0028), and project_directory's cost
-- subquery (view, 0029) are all `create or replace`d here to join
-- runs -> projects directly on runs.project_id instead of runs -> scenes ->
-- projects. Output columns (names, order, types) are unchanged in all four,
-- so this is a body-only replace — no dependent view/function signature
-- changes, no need to drop-and-recreate anything that references them.
-- spend_total_usd (0026) is NOT touched: it already sums runs.cost_usd with
-- no join at all (a pure date-range filter), so it never had this bug — it
-- was already counting every run, scene or no scene. That is worth stating
-- explicitly: the global daily cap (web/lib/spend.ts's getGlobalDailySpend)
-- was already correct before this migration; only the PER-USER cap
-- (getDailySpend) and the per-project/per-user breakdowns were undercounting.
--
-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- 0002_rls.sql's runs_select/insert/update/delete policies all gate through
-- `scenes s join projects p on p.id = s.project_id where s.id = runs.scene_id`
-- — the exact same scene-shaped hole as the aggregates above, but for row
-- visibility instead of a sum: a non-admin querying `runs` through their own
-- session client (RLS-scoped, not the admin/service-role client) could never
-- see, insert, update, or delete their own scene-less run, because
-- `s.id = NULL` never matches. In practice every write in this codebase (web
-- and worker alike) goes through the service-role/admin client, which
-- bypasses RLS entirely — so this was latent, not actively wrong for any
-- shipped code path — but it is still a correctness bug in the policies
-- themselves, and would bite the moment anything reads `runs` through a
-- plain session client (spend_totals_by_user and project_cost_totals are
-- SECURITY INVOKER precisely so an admin's own RLS-visible rows cover
-- everyone's — see 0026's header — which only works if runs_select itself
-- is correct). All four policies are dropped and recreated here to check
-- `p.id = runs.project_id` directly against `projects`, which now covers a
-- scene-less run exactly the same as a scene-having one, and is simpler
-- besides — one join instead of two.
--
-- One row shape these four policies still cannot admit through a plain
-- session client: a project-less run (project_id NULL — the Character
-- Library exception; see "Why nullable, not NOT NULL" above), since
-- `p.id = NULL` is never true no matter who's asking. That is fine in
-- practice — web/actions/character-library.ts's
-- createCharacterFromDescription, the one writer of such a row, is
-- admin-only and already writes through the service-role/admin client like
-- every other mutation in that file, which bypasses RLS entirely — but it
-- is worth naming rather than leaving for the next person to wonder why a
-- library-character run "shouldn't" be readable by its own RLS policy.
--
-- ---------------------------------------------------------------------------
-- Per this task's constraints, this migration is written but deliberately
-- NOT applied. web/types/db.ts is hand-patched to describe runs.project_id
-- ahead of that application — see that file's own header for the general
-- policy on hand-patching, and the `runs` entry there for the exact patch.
-- =============================================================================

alter table runs add column project_id uuid references projects(id) on delete cascade;

-- Backfill the table's entire history (27 rows as of this writing, all of
-- them scene-having video renders — the scene-less paid call sites this
-- migration exists for did not record ANY run before this task's sibling
-- application-code change) via the same scene_id -> project_id hop the
-- queries above used to require on every read. One-time cost, paid here
-- instead of on every future query.
update runs
set project_id = scenes.project_id
from scenes
where runs.scene_id = scenes.id
  and runs.project_id is null;

-- Left nullable — see this migration's header ("Why nullable, not NOT
-- NULL") for the one legitimate case (a Character Library entry has no
-- project) that rules out enforcing it here.

-- Every aggregate above already filters/groups by project_id (indirectly,
-- via scene_id -> scenes.project_id) or by date; a direct index on the new
-- column is what keeps `project_cost_totals`/`project_directory`'s GROUP BY
-- and `spend_totals_by_user`/`user_directory`'s join cheap now that they no
-- longer route through scenes' own (already-indexed) project_id.
create index runs_project_id_idx on runs (project_id);

-- ---------------------------------------------------------------------------
-- project_cost_totals (0026) — drop the scenes hop
-- ---------------------------------------------------------------------------
create or replace view project_cost_totals
with (security_invoker = true) as
select
  r.project_id,
  coalesce(sum(r.cost_usd), 0) as total_cost_usd
from runs r
group by r.project_id;

comment on view project_cost_totals is
  'Per-project sum of runs.cost_usd, computed in SQL instead of embedding every run app-side — see '
  '0026_cost_aggregates.sql''s header. Joins runs -> projects via runs.project_id directly (not '
  'through scenes) since 0030_runs_project_id.sql, so a scene-less run (character/composite image '
  'generation, a full-script or per-scene compile) counts here too. A project with zero runs has no '
  'row here at all (inner join): callers read a missing project_id as $0, not as an error '
  '(web/lib/db-aggregates.ts getProjectCostTotals).';

-- ---------------------------------------------------------------------------
-- spend_totals_by_user (0026) — drop the scenes hop
-- ---------------------------------------------------------------------------
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
  join projects p on p.id = r.project_id
  left join profiles prof on prof.id = p.user_id
  where r.created_at >= from_ts and r.created_at < to_ts
  group by p.user_id, prof.email
  order by total_usd desc;
$$;

comment on function spend_totals_by_user is
  'Per-user total cost_usd for runs created in [from_ts, to_ts), grouped in SQL. Replaces /spend''s '
  'old in-memory reduce() over an unbounded select — see 0026_cost_aggregates.sql''s header for the '
  'exact bug (silent under-report past max_rows = 1000 runs). Joins runs -> projects via '
  'runs.project_id directly (not through scenes) since 0030_runs_project_id.sql, so a scene-less run '
  'counts toward its owner''s total too.';

-- ---------------------------------------------------------------------------
-- user_directory (0028) — drop the scenes hop in its spend subquery
-- ---------------------------------------------------------------------------
create or replace view user_directory
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
  join projects pr on pr.id = r.project_id
  group by pr.user_id
) spend on spend.user_id = p.id;

comment on view user_directory is
  'profiles LEFT JOINed to per-user project counts and all-time spend, both computed in SQL — see '
  '0028_user_directory.sql''s header. LEFT JOIN + COALESCE(...,0): a user with zero projects and zero '
  'spend MUST still appear as a 0/0 row. spend subquery joins runs -> projects via runs.project_id '
  'directly (not through scenes) since 0030_runs_project_id.sql, so a scene-less run counts toward '
  'its owner''s total too.';

-- ---------------------------------------------------------------------------
-- project_directory (0029) — drop the scenes hop in its cost subquery
-- ---------------------------------------------------------------------------
create or replace view project_directory
with (security_invoker = true) as
-- Column list must match 0029's EXACTLY. `create or replace view` cannot
-- rename or reorder columns, and a first attempt at this migration failed
-- on precisely that (SQLSTATE 42P16) — it had quietly dropped product_name
-- and added updated_at. product_name is a rendered column on /projects, so
-- the drop would also have taken the Product column off the page. Only the
-- cost subquery below changes.
select
  p.id,
  p.title,
  p.product_name,
  p.status,
  p.created_at,
  p.user_id,
  prof.email as owner_email,
  coalesce(scene_counts.scene_count, 0) as scene_count,
  coalesce(cost.total_cost_usd, 0) as total_cost_usd
from projects p
left join profiles prof on prof.id = p.user_id
left join (
  select project_id, count(*) as scene_count
  from scenes
  group by project_id
) scene_counts on scene_counts.project_id = p.id
left join (
  select r.project_id, coalesce(sum(r.cost_usd), 0) as total_cost_usd
  from runs r
  group by r.project_id
) cost on cost.project_id = p.id;

comment on view project_directory is
  'projects LEFT JOINed to owner email, per-project scene count and all-time cost, both aggregates '
  'computed in SQL — see 0029_project_directory.sql''s header. LEFT JOIN + COALESCE(...,0): a project '
  'with zero scenes and zero spend MUST still appear as a 0/$0 row. cost subquery joins runs -> '
  'projects via runs.project_id directly (not through scenes) since 0030_runs_project_id.sql, so a '
  'scene-less run (character/composite image generation, a full-script or per-scene compile) counts '
  'toward its project''s total too.';

-- ---------------------------------------------------------------------------
-- 0002_rls.sql's runs policies — drop the scenes hop
-- ---------------------------------------------------------------------------
drop policy if exists runs_select on runs;
drop policy if exists runs_insert on runs;
drop policy if exists runs_update on runs;
drop policy if exists runs_delete on runs;

create policy runs_select on runs
  for select
  using (
    exists (
      select 1 from projects p
      where p.id = runs.project_id
        and (p.user_id = auth.uid() or is_admin())
    )
  );

create policy runs_insert on runs
  for insert
  with check (
    exists (
      select 1 from projects p
      where p.id = runs.project_id
        and p.user_id = auth.uid()
    )
  );

create policy runs_update on runs
  for update
  using (
    exists (
      select 1 from projects p
      where p.id = runs.project_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from projects p
      where p.id = runs.project_id
        and p.user_id = auth.uid()
    )
  );

create policy runs_delete on runs
  for delete
  using (
    exists (
      select 1 from projects p
      where p.id = runs.project_id
        and p.user_id = auth.uid()
    )
  );
