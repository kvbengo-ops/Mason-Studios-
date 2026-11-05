-- =============================================================================
-- A deleted scene must be recoverable, not just accounted for.
--
-- 0038_preserve_cost_history_on_delete.sql already stopped a scene delete
-- (or the project delete that cascades to it) from destroying the MONEY
-- spent on a scene. It did not preserve the scene itself: `scenes.project_id`
-- is `on delete cascade` (0001_init.sql), and `assets.scene_id`,
-- `scene_versions.scene_id` (0058_scene_versions.sql) and
-- `scene_references.scene_id` (0071_scene_references.sql) are all `on delete
-- cascade` onto scenes. Delete a scene today and the prompt, the reference
-- frame, every version, every reference asset and every scene_references row
-- are gone, unrecoverably, the moment the transaction commits. There is no
-- undo anywhere in this schema for that.
--
-- This migration is the database half of a trash bin: a scene delete copies
-- the scene row and its three families of children into `deleted_scenes` one
-- step ahead of the cascade, so a later restore action has something to
-- restore FROM. Nothing about deleting is changed — the cascades still run
-- exactly as before, and web code needs no knowledge that this table exists
-- to keep deleting scenes exactly the way it already does.
--
-- ---------------------------------------------------------------------------
-- This must NEVER touch `runs` — not the table, not a column, not a join
-- ---------------------------------------------------------------------------
-- 0054_runs_survive_scene_delete.sql DROPPED a BEFORE DELETE trigger on
-- `scenes` (scenes_archive_cost_history) that used to archive that scene's
-- `runs` rows into deleted_project_cost_history. It was dropped, not left in
-- place, because 0054 also changed `runs.scene_id` from `on delete cascade`
-- to `on delete set null` — a deleted scene's runs now SURVIVE in the live
-- `runs` table, still attached to the project via `runs.project_id` (0030),
-- so every one of 0040_include_archived_cost_in_spend_reads.sql's UNION ALL
-- reads keeps counting them exactly once. If a scene-delete trigger archived
-- those same runs a second time — into this table, or anywhere else — every
-- one of those unions would double-count the spend, because 0040's whole
-- argument for correctness rests on "a given run_id is in exactly one of the
-- two tables, never both" (0054's own header). That invariant does not care
-- which second table the row lands in; it breaks the moment `runs` is
-- touched by anything other than 0038's surviving projects-level trigger.
--
-- So this migration's trigger reads `scenes`, `assets`, `scene_versions`,
-- `scene_references` and `projects` (for the owner snapshot below) and
-- nothing else. It does not select from `runs`, does not join it, and does
-- not archive it. A scene's render history is not part of what this table
-- restores — it already lives on, untouched, in `runs` itself, exactly where
-- 0054 put it. Do not "complete" this migration by adding runs back in; that
-- is 0054's bug, reintroduced.
--
-- ---------------------------------------------------------------------------
-- Why the archive table has no foreign keys, and the columns are snapshots
-- ---------------------------------------------------------------------------
-- Same reasoning as 0038, copied verbatim because nothing about it changes
-- here: the rows this table exists to preserve are, by construction, rows
-- whose parents are being deleted in the very same transaction that writes
-- here. An FK to scenes/projects would either reject the insert outright (a
-- BEFORE DELETE trigger runs before the row is gone, so a `references
-- scenes(id)` FK would still validate against a row that is about to vanish
-- — fine at insert time, but any `on delete cascade` written to match the
-- surrounding schema's style would re-arm the exact bug this migration
-- closes and wipe the archive back out milliseconds later) or, written
-- without cascade, dangle a constraint against a row that no longer exists.
-- Plain uuid columns only. `scene_id` and `project_id` are expected to
-- dangle once the delete completes.
--
-- `scene` is `to_jsonb(OLD)` — the scene's own row, whole — rather than a
-- column copied per column, deliberately: a column added to `scenes` by a
-- future migration is then archived automatically, with no edit needed
-- here. `assets`, `versions` and `refs` are the same idea applied to each
-- child table, gathered with `jsonb_agg(to_jsonb(...))` and coalesced to
-- `'[]'` when a scene had none — a scene with, say, no scene_references yet
-- must not fail to archive for lack of any.
--
-- `user_id` is an owner snapshot, not a join kept live: once the scene (and
-- possibly its project) are gone, there is nothing left to join to. It is
-- read from `projects.user_id` at archive time, while the project can still
-- be read — see the RLS section below for why this table needs it at all,
-- and the trigger's own comment for the one case where that read can come
-- back NULL.
--
-- `scene_idx` is `scenes.idx` at the moment of deletion, for display only
-- (e.g. "restore Scene 3"); a restore action does not reuse it; a scene
-- created since could already occupy that slot, and `scenes` still enforces
-- `unique (project_id, idx)`.
--
-- `scene_id` is the PRIMARY KEY, exactly as `run_id` is 0038's: it is what
-- makes archiving idempotent. A scene can only ever be deleted once, so
-- uniqueness on its original id is exactly the right key, and
-- `on conflict (scene_id) do nothing` is what turns a second attempt to
-- archive the same scene into a no-op rather than an error or a duplicate
-- row. (Unlike 0038, this migration adds only the one trigger below — on
-- `scenes` — so unlike run_id there is no second, independent entry point
-- that is expected to race it in the ordinary case; the conflict guard is
-- there on the same principle 0038 documents, not because a project-cascade
-- delete is known to invoke this trigger twice for the same scene.)
-- =============================================================================

create table deleted_scenes (
  scene_id    uuid primary key,
  project_id  uuid,
  user_id     uuid,
  scene_idx   int,
  deleted_at  timestamptz not null default now(),
  scene       jsonb not null,
  assets      jsonb not null default '[]',
  versions    jsonb not null default '[]',
  refs        jsonb not null default '[]'
);

comment on table deleted_scenes is
  'A scene and its children, rescued from ON DELETE CASCADE one step ahead of the cascade by a '
  'BEFORE DELETE trigger on scenes (0001_init.sql''s cascades from scenes to assets/scene_versions/'
  'scene_references). Exists so a deleted scene can be RESTORED, not merely accounted for — contrast '
  'deleted_project_cost_history (0038), which exists only so the money survives. Deliberately has NO '
  'foreign keys: the scene and project this table names are, by construction, being deleted in the '
  'same transaction that writes here, so an FK would either reject the insert or (if written on '
  'delete cascade, matching the surrounding style) cascade-wipe the archive the instant it is '
  'written. scene_id/project_id are bare uuids that are EXPECTED to dangle; user_id is an owner '
  'snapshot taken from projects while the project could still be read, not a live join. '
  'archive_deleted_scene(), the trigger that writes this table, does not read or reference `runs` '
  'in any way — see this migration''s header for why that is load-bearing, not an oversight.';

comment on column deleted_scenes.scene is
  'to_jsonb(OLD) — the deleted scenes row, whole, rather than one column at a time, so a column '
  'added to scenes by a later migration is archived automatically with no edit needed here.';

comment on column deleted_scenes.scene_idx is
  'scenes.idx at the moment of deletion. Display only (e.g. "restore Scene 3") — a restore does '
  'NOT reuse it, since scenes still enforces unique (project_id, idx) and a new scene may already '
  'occupy that slot.';

comment on column deleted_scenes.user_id is
  'The owning project''s user_id, snapshotted at archive time from projects (RLS below reads this '
  'column, not a live join, since the project may be gone by the time anyone selects from here). '
  'See archive_deleted_scene()''s comment for the one path — a scene torn down by its own project''s '
  'cascade — where this can come back NULL.';

-- This migration used to say "no indexes beyond the primary key ... the
-- first list-style reader should add the index its own query actually
-- needs," matching 0038's identical call for deleted_project_cost_history.
-- That reader has arrived, in the same PR: web/app/(app)/ugc/[id]/page.tsx's
-- "Recently deleted" section filters on project_id and orders by
-- deleted_at desc, with no .limit(). Same shape 0040 added for
-- deleted_project_cost_history's own first list-style reader.
create index deleted_scenes_project_id_deleted_at_idx
  on deleted_scenes (project_id, deleted_at desc);

-- ---------------------------------------------------------------------------
-- scenes BEFORE DELETE
-- ---------------------------------------------------------------------------
-- BEFORE, not AFTER: an AFTER DELETE trigger fires once the cascade has
-- already destroyed assets/scene_versions/scene_references for this scene,
-- by which point there is nothing left to gather. The whole mechanism
-- depends on getting in front of the cascade, exactly as 0038's triggers do.
--
-- security definer, set search_path = public: matches 0038 and
-- 0004_profile_trigger.sql for the same reason — the function must be able
-- to write the archive regardless of who is doing the deleting, including
-- an authenticated user deleting their own scene through their session
-- client, where (per the RLS block below) `authenticated` has no INSERT
-- policy on this table at all. Running as the table owner, who is exempt
-- from RLS, is what lets the trigger write rows nobody else may write
-- directly.
--
-- This single trigger covers both ways a scene is removed: a standalone
-- scene delete (project untouched) and a project delete that cascades down
-- to it. Unlike 0038 this migration does NOT add a second, project-level
-- trigger — 0038 needed one because deleting a project's runs requires
-- reading OLD.title and the owner's email from the projects row itself
-- before it disappears, and that read has to happen at the project's own
-- BEFORE DELETE to be reliable. This table only ever archives ONE scene at
-- a time, keyed by that scene's own id, and every scene torn down by a
-- project's cascade still fires its own BEFORE DELETE on scenes regardless
-- — so one trigger, scoped to OLD, already reaches every scene either path
-- deletes.
--
-- That said: when this trigger fires because a PROJECT delete cascaded down
-- to the scene (rather than the scene being deleted on its own), the
-- `select ... from projects where id = OLD.project_id` below can find
-- nothing. 0038's header documents exactly this timing for its own
-- scenes-level trigger: the ON DELETE CASCADE that tears down scenes runs as
-- an internal AFTER-row action on projects, and by the time it reaches this
-- trigger the projects row is no longer visible to a plain SELECT in this
-- transaction. In that path, user_id is archived as NULL rather than the
-- owner's real id — the scene and its children are still fully preserved
-- (nothing above depends on projects), but RLS's owner-select policy below
-- cannot match a NULL to anyone's auth.uid(), so only an admin can read that
-- particular row back until a future migration gives it another way to
-- learn the owner. Recorded here rather than silently accepted: a reader
-- extending this table's RLS or its restore path needs to know the owner
-- snapshot is not guaranteed on every row.
create or replace function public.archive_deleted_scene()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid;
  v_assets   jsonb;
  v_versions jsonb;
  v_refs     jsonb;
begin
  select p.user_id into v_user_id
  from projects p
  where p.id = OLD.project_id;

  select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb)
    into v_assets
  from assets a
  where a.scene_id = OLD.id;

  select coalesce(jsonb_agg(to_jsonb(sv)), '[]'::jsonb)
    into v_versions
  from scene_versions sv
  where sv.scene_id = OLD.id;

  select coalesce(jsonb_agg(to_jsonb(sr)), '[]'::jsonb)
    into v_refs
  from scene_references sr
  where sr.scene_id = OLD.id;

  insert into deleted_scenes (
    scene_id, project_id, user_id, scene_idx, scene, assets, versions, refs
  )
  values (
    OLD.id, OLD.project_id, v_user_id, OLD.idx, to_jsonb(OLD), v_assets, v_versions, v_refs
  )
  on conflict (scene_id) do nothing;

  return OLD;
end;
$$;

comment on function public.archive_deleted_scene is
  'BEFORE DELETE on scenes: copies the scene row (to_jsonb(OLD)) and its assets/scene_versions/'
  'scene_references (each gathered by scene_id, jsonb_agg''d, coalesced to ''[]'') into '
  'deleted_scenes before ON DELETE CASCADE destroys them, so a later restore has something to '
  'restore from. Does NOT read, join, or archive `runs` — see this migration''s header for why '
  'touching runs here would double-count spend against 0040''s unions, which is exactly the bug '
  '0054_runs_survive_scene_delete.sql closed. user_id is snapshotted from projects and can be NULL '
  'when this fires as part of a project-level cascade delete rather than a standalone scene delete '
  '— see the trigger''s own comment above for why.';

create trigger scenes_archive_deleted_scene
  before delete on scenes
  for each row execute function public.archive_deleted_scene();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Owner-readable, NOT admin-only — the one deliberate difference from
-- 0038's deleted_project_cost_history. That table is a cost ledger read by
-- the same audience as /spend and /users (admins only, via guard.ts's
-- requireAdmin()). This table exists so the editor who deleted their own
-- scene can restore it themselves, without needing an admin in the loop —
-- so the policy has to admit that editor, not just is_admin(). Shape
-- mirrors elements_select (0065_elements.sql): `user_id = auth.uid() or
-- is_admin()`. Reads the snapshot column, not a live join to projects —
-- by the time anyone selects from this table the project may well be gone.
--
-- No insert/update/delete policy at all, which under RLS means `deny` for
-- `authenticated` even though 0007_grants.sql's `alter default privileges`
-- grants the table-level privilege. This is append-only from the outside;
-- the one thing that may write it is the trigger above, which is security
-- definer and runs as the table owner — exempt from RLS (no `force row
-- level security` here) — so it is unaffected by the absence of an insert
-- policy. service_role likewise bypasses RLS by design (0007_grants.sql),
-- so the Go worker and Server Actions reach this table unrestricted; a
-- future restore action is expected to run through that same service-role
-- path rather than through a client-side UPDATE/DELETE this table has no
-- policy for.
alter table deleted_scenes enable row level security;

create policy deleted_scenes_select on deleted_scenes
  for select
  using (user_id = auth.uid() or is_admin());
