-- Version the assembled final video, and turn "please assemble" into a row
-- rather than an absence.
--
-- WHAT WAS WRONG
--
-- Every re-assemble destroyed the one before it. reassembleProject
-- (web/actions/deliver.ts) deleted the project's `final` and `poster` asset
-- rows AND their storage objects, and deleteStaleFinalAssets
-- (web/actions/enqueue.ts) deleted the rows on every retry/unfreeze. There
-- was no v1 to go back to, and no way to put two cuts side by side and pick.
--
-- That deletion was not sloppiness — it was the trigger. The worker's
-- ProjectsReadyToAssemble asked "does a `final` asset NOT exist for this
-- project", so the only way to ask for a rebuild was to destroy the last
-- one. Keeping old finals therefore breaks assembly outright unless the
-- trigger changes with it, which is why both happen here.
--
-- Worse, and quieter: StorageKeyForFinal is a FIXED key,
-- projects/{id}/final/final.mp4. Even if the rows were kept, the next
-- assemble would overwrite the object every old row still points at — data
-- loss wearing the shape of success. The worker's key must become
-- per-version alongside this.
--
-- WHAT A VERSION IS
--
-- A final version is a RECIPE first and a file second. The recipe is what
-- explains the difference between two cuts: the scene order, and which
-- scene_version each scene contributed. That is cheap enough to keep
-- forever. The file is 10-30MB and is not.
--
-- Splitting them is what makes a retention rule possible later without
-- losing history: drop `final_asset_id` on an old version and it is still a
-- complete, rebuildable record of what that cut was.

create table final_versions (
  id uuid primary key default gen_random_uuid(),

  project_id uuid not null references projects (id) on delete cascade,

  -- Per-project 1, 2, 3 — the "v2" an operator reads, not a global counter.
  -- Same shape as scene_versions.n.
  n integer not null,

  -- The recipe: an ordered array of { scene_id, scene_version_id }, in cut
  -- order. jsonb rather than a child table because it is written once,
  -- always read whole, and never queried BY its contents — the same reason
  -- render_settings is jsonb.
  --
  -- scene_version_id may be null for a scene whose active version predates
  -- 0058's backfill. A recipe that says "this scene, version unknown" is
  -- still truer than one that guesses.
  recipe jsonb not null default '[]'::jsonb,

  -- The built artifacts. Null in two DIFFERENT situations, which the
  -- built_at column below is what tells apart:
  --   built_at is null  -> not built yet; this row IS the request.
  --   built_at is set   -> built, then the file was pruned. The recipe
  --                        survives and the cut can be rebuilt.
  final_asset_id uuid references assets (id) on delete set null,
  poster_asset_id uuid references assets (id) on delete set null,

  -- When the worker finished this version. NULL is the work queue: the
  -- assemble loop claims rows where built_at is null, which replaces
  -- ProjectsReadyToAssemble's "no final asset exists" inference with an
  -- explicit request. An operator asking for a rebuild now INSERTS a row
  -- instead of deleting the previous one.
  built_at timestamptz,

  -- Set when the worker gives up on this row, so a failed assemble does not
  -- retry forever and does not silently look like a pending one.
  failed_at timestamptz,
  failure_reason text,

  -- The lease. Stamped when a worker takes this row and cleared if it
  -- fails, so a build in progress is not claimable by a second instance.
  --
  -- SKIP LOCKED alone is not enough, and the difference matters: a row lock
  -- only lives as long as the claiming TRANSACTION, while an assemble runs
  -- for minutes outside it. Without this column the row stays claimable for
  -- that whole window and a second worker ticking 30s later builds the same
  -- cut again — two ffmpeg runs, two uploads, one of them overwriting the
  -- other's row. ClaimQueuedScenes does not need a column like this only
  -- because it has `status` to flip; this table has nothing that could say
  -- "being built" without lying (built_at would claim it is finished,
  -- failed_at that it broke).
  --
  -- A worker that dies mid-build leaves this set. The reconcile loop is
  -- where a stale lease should be swept, on the same reasoning
  -- RECONCILE_GIVE_UP_AFTER_MINUTES already applies to a stuck render.
  --
  -- WHEN THAT SWEEP IS WRITTEN: it must release the lease by clearing
  -- claimed_at ALONE, never by also setting failed_at. A slow-but-alive
  -- worker's eventual MarkFinalVersionBuilt is guarded on `failed_at is
  -- null`, so declaring the row failed while its build is still running
  -- strands a final that was genuinely assembled and uploaded — the file
  -- exists in storage with no row pointing at it, which is the one outcome
  -- worse than building it twice.
  claimed_at timestamptz,

  created_at timestamptz not null default now(),

  unique (project_id, n)
);

-- `n` is assigned HERE, not by the caller.
--
-- The obvious alternative — every inserter running `select max(n) + 1` —
-- is a race with a unique constraint at the end of it: two requests for the
-- same project a millisecond apart both read the same max, and the second
-- insert fails on `unique (project_id, n)`. Rare, and exactly the kind of
-- rare that surfaces as a "could not assemble" an operator cannot reproduce.
-- Doing it in a BEFORE INSERT trigger means the read and the write are the
-- same statement, and the unique constraint stays as the backstop it is
-- meant to be rather than the primary defence.
create function final_versions_assign_n() returns trigger
language plpgsql
as $$
begin
  if new.n is null then
    select coalesce(max(n), 0) + 1 into new.n
    from final_versions
    where project_id = new.project_id;
  end if;
  return new;
end;
$$;

create trigger final_versions_assign_n_trigger
  before insert on final_versions
  for each row execute function final_versions_assign_n();

-- Nullable so the trigger can fill it; the unique constraint above still
-- forbids two versions sharing a number.
alter table final_versions alter column n drop not null;

-- The one an operator is looking at, and the one the archive route and the
-- Deliver page resolve. Nullable: a project with no assemble yet has none,
-- and `on delete set null` so pruning a version never orphans the project.
alter table projects
  add column active_final_version_id uuid references final_versions (id) on delete set null;

comment on column projects.active_final_version_id is
  'The final version currently shown and downloaded. Distinct from "the newest": an operator may assemble a v3 and decide v2 was better. Null before the first assemble.';

-- The claim index the assemble loop reads: unclaimed pending rows, oldest
-- first.
create index final_versions_pending_idx
  on final_versions (created_at)
  where built_at is null and failed_at is null and claimed_at is null;

create index final_versions_project_n_idx on final_versions (project_id, n desc);

-- At most ONE outstanding request per project.
--
-- Without this, every press of Assemble — and the auto-rebuild that fires on
-- each reorder drag — queues another pending row, the worker builds every
-- one of them, and the last to finish wins the active pointer. Several
-- minutes of ffmpeg spent producing cuts nobody asked to keep, and a final
-- chosen by whichever build happened to finish last.
--
-- A partial unique index makes the request a queue of one: the second
-- insert fails loudly and the caller decides (re-open the pending row
-- rather than adding to it). Scoped to rows that are still outstanding, so
-- built and failed versions accumulate freely — they are history.
create unique index final_versions_one_pending_idx
  on final_versions (project_id)
  where built_at is null and failed_at is null;

-- ---------------------------------------------------------------- backfill
--
-- One v1 per project that already has a final asset, so nothing that exists
-- today becomes invisible.
--
-- The recipe is reconstructed from the CURRENT scene order and each scene's
-- CURRENT active version, which is a guess: it is what the cut would be if
-- rebuilt now, not provably what was built then. Recorded anyway, because
-- for an untouched project it is right, and because an empty recipe would
-- make an existing final unrebuildable. built_at is taken from the asset's
-- own created_at rather than now(), so the row does not claim to have been
-- built during this migration.
insert into final_versions (project_id, n, recipe, final_asset_id, poster_asset_id, built_at, created_at)
select
  a.project_id,
  1,
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object('scene_id', s.id, 'scene_version_id', s.active_version_id)
        order by s.idx
      )
      from scenes s
      where s.project_id = a.project_id
    ),
    '[]'::jsonb
  ),
  a.id,
  (
    -- Ordered, not just limited. An unordered `limit 1` is the same
    -- arbitrary-winner shape this migration criticises the Deliver page's
    -- `.find()` for two comments below, and it would have picked a poster
    -- at random had a project ever accumulated two.
    select p.id from assets p
    where p.project_id = a.project_id and p.kind = 'poster' and p.scene_id is null
    order by p.created_at desc
    limit 1
  ),
  a.created_at,
  a.created_at
from assets a
where a.kind = 'final'
  -- A project cannot already have a final_versions row here (the table was
  -- just created), but more than one `final` asset per project has never
  -- been forbidden by a constraint — see the Deliver page's `.find()`. Take
  -- the newest and leave any duplicate alone rather than minting two v1s.
  and a.id = (
    select a2.id from assets a2
    where a2.project_id = a.project_id and a2.kind = 'final'
    order by a2.created_at desc
    limit 1
  );

-- Point each project at the version just created for it.
update projects p
set active_final_version_id = v.id
from final_versions v
where v.project_id = p.id
  and v.n = 1
  and p.active_final_version_id is null;

-- --------------------------------------------------------------------- RLS
--
-- Mirrors scene_versions' policies (0058), one join shorter: this table
-- hangs off project_id directly rather than through scenes. Owner does
-- everything to their own; an admin reads everything, same as
-- projects_select.

alter table final_versions enable row level security;

create policy final_versions_select on final_versions
  for select to authenticated
  using (
    exists (
      select 1 from projects p
      where p.id = final_versions.project_id
        -- is_admin() is the project's own helper, the same one 0058's
        -- scene_versions policies use. Spelling the profiles lookup out by
        -- hand here would be a second definition of "admin" to keep in step.
        and (p.user_id = auth.uid() or is_admin())
    )
  );

create policy final_versions_insert on final_versions
  for insert to authenticated
  with check (
    exists (
      select 1 from projects p
      where p.id = final_versions.project_id and p.user_id = auth.uid()
    )
  );

create policy final_versions_update on final_versions
  for update to authenticated
  using (
    exists (
      select 1 from projects p
      where p.id = final_versions.project_id and p.user_id = auth.uid()
    )
  )
  -- `using` gates the row as it was; `with check` gates the row as it will
  -- be. With only the first, an owner could rewrite project_id and move a
  -- version onto another of their projects — every individual check passes
  -- and a cut ends up filed under a project that never built it. 0058's
  -- scene_versions_update carries the same pair for the same reason.
  with check (
    exists (
      select 1 from projects p
      where p.id = final_versions.project_id and p.user_id = auth.uid()
    )
  );

create policy final_versions_delete on final_versions
  for delete to authenticated
  using (
    exists (
      select 1 from projects p
      where p.id = final_versions.project_id and p.user_id = auth.uid()
    )
  );
