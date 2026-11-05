-- =============================================================================
-- A deleted VERSION must be recoverable too, not just a deleted scene.
--
-- 0088_deleted_scenes.sql rescues a whole scene one step ahead of its own
-- cascade. It says nothing about a scene_versions row deleted on its own —
-- and rerenderScene / reuseSceneVersion / any future "delete this one take"
-- action can do exactly that, independent of the scene ever being deleted at
-- all. Without this migration, deleting a scene_versions row (0058's
-- `on delete cascade` from scenes, or a direct delete of one row) destroys
-- the prompt/frame/clip triple that row bundled, unrecoverably, the moment
-- the transaction commits — same gap 0088 closed for scenes, one level down.
--
-- This migration is that same trash-bin mechanism applied to scene_versions:
-- a BEFORE DELETE trigger copies the version row and its clip asset into
-- `deleted_scene_versions` one step ahead of the delete, so restoreClipVersion
-- has something to restore FROM. Nothing about deleting a version changes —
-- the delete still runs exactly as before.
--
-- ---------------------------------------------------------------------------
-- Why a version deleted BY a scene's own cascade is NOT archived here
-- ---------------------------------------------------------------------------
-- scene_versions.scene_id is `on delete cascade` (0058), so deleting a scene
-- deletes every one of its versions in the same statement. When THAT is what
-- fires this trigger, 0088's own BEFORE DELETE on scenes has already run
-- first — before the scenes row is gone, before the cascade reaches this
-- table — and it already read every one of this scene's scene_versions rows
-- with `jsonb_agg(to_jsonb(sv))` into `deleted_scenes.versions`. Archiving
-- the same row again here, into a second table, would double-store it.
--
-- Worse: it cannot be done correctly even if double-storage were acceptable.
-- By the time the cascade reaches this row's own BEFORE DELETE, the parent
-- `scenes` row is no longer visible to a plain SELECT in this transaction —
-- the exact timing 0088's header already documents for a PROJECT cascading
-- down to `scenes` (projects gone before the scenes-level trigger can read
-- it). One level down, the same thing happens to `scenes` itself once ITS
-- own delete has begun: `select 1 from scenes where id = OLD.scene_id`
-- returns nothing, so there is no project_id to read and, in turn, no
-- projects row to read user_id from either. An archive row written under
-- those conditions would carry NULL project_id AND NULL user_id — the
-- latter is fatal, not just cosmetic, because the RLS policy below is
-- `user_id = auth.uid() or is_admin()`, and NULL never equals anyone's
-- auth.uid(). A row nobody but an admin could ever see is worse than no row
-- at all when 0088 already holds the same data reachably.
--
-- So: `if not exists (select 1 from scenes where id = OLD.scene_id) then
-- return OLD; end if;` at the top of the trigger is not an optimization, it
-- is the ONLY correct behavior for the cascade path — this is empirically
-- proven, not inferred: a standalone scene_versions delete (scene left
-- alive) sees its parent scene row (the `exists` is true, the trigger
-- proceeds); a delete that arrives via the scene's own cascade does not (the
-- `exists` is false, the trigger returns early). Do not replace this check
-- with a session GUC or an application-set flag — the visibility itself is
-- the signal, and it is already reliable.
--
-- A version deleted on its own (scene untouched — the only case this table
-- exists for) still finds its scene, reads project_id from it and user_id
-- from projects via that project_id, and archives normally.
--
-- ---------------------------------------------------------------------------
-- Why hard_deleted_at is a flag on the ARCHIVE rows, and never on the live
-- tables
-- ---------------------------------------------------------------------------
-- purgeDeletedScene and purgeDeletedVersion (web/actions/ugc.ts) need a way
-- to say "forget this bin entry" without literally deleting the archive row
-- (deleting it would throw away the last record that a version ever existed
-- — no better than never having archived it). The obvious-looking
-- alternative is a `deleted` flag on the LIVE tables — mark a scene or
-- version deleted in place, filter it out everywhere, physically remove it
-- later. That alternative is wrong for this schema specifically: `scenes`
-- and `scene_versions` are read in bulk, with no id predicate, in at least
-- 29 places, 5 of which spend real money — including the Go worker's
-- ClaimQueuedScenes (worker/internal/store/store.go), which claims queued
-- scenes for rendering. Every one of those reads would need to learn about
-- the new flag, and a single site that forgot — one skipped WHERE clause
-- among 29 — puts a "deleted" scene back into rendering, or (duplicateProject,
-- web/actions/project.ts, which reads `scenes` by project_id with no other
-- filter) resurrects it as a live draft in a freshly duplicated project.
-- That is not a hypothetical near-miss, it is the default outcome of adding
-- a soft-delete column to a table this many call sites already treat as "if
-- it's in this table, it's live."
--
-- hard_deleted_at/hard_deleted_by sidestep the whole problem by never
-- touching scenes or scene_versions at all. They live only on the archive
-- rows — deleted_scene_versions here, and the two columns 0088's own
-- deleted_scenes gains below — which nothing in the render path, the worker,
-- or duplicateProject ever reads. "Purged" means "hidden from the bin list
-- and no longer restorable," expressed entirely inside a table those 29
-- reads don't know exists. A restore/list query filters
-- `where hard_deleted_at is null`; the money-spending 29 don't have to.
--
-- ---------------------------------------------------------------------------
-- Nothing here ever deletes Storage bytes
-- ---------------------------------------------------------------------------
-- Both the archive trigger below and a future hard-delete/purge action deal
-- exclusively in JSONB snapshots of `assets` ROWS — metadata, not files. No
-- part of this migration calls into Supabase Storage, and setting
-- hard_deleted_at does not remove the underlying object from its bucket
-- either. The clip a purged version once pointed at keeps occupying storage
-- until something else is built to reap it — same as every other table in
-- this trash-bin family; pre-existing, unchanged, not addressed here.
-- =============================================================================

create table deleted_scene_versions (
  version_id      uuid primary key,
  scene_id        uuid,
  project_id      uuid,
  user_id         uuid,
  n               int,
  deleted_at      timestamptz not null default now(),
  hard_deleted_at timestamptz,
  hard_deleted_by uuid,
  version         jsonb not null,
  clip_asset      jsonb
);

comment on table deleted_scene_versions is
  'One scene_versions row, rescued from a standalone delete (never a scene''s own cascade — see '
  'this migration''s header) by a BEFORE DELETE trigger on scene_versions, so restoreClipVersion '
  '(web/actions/ugc.ts) has something to restore from. No foreign keys, same reasoning as '
  'deleted_scenes (0088): version_id/scene_id/project_id are bare uuids expected to dangle once the '
  'delete completes, and an FK written on delete cascade (matching surrounding style) would '
  'cascade-wipe this very archive the instant it is written. hard_deleted_at/hard_deleted_by mark a '
  'bin entry as purged; that flag lives ONLY here, never on the live scenes/scene_versions tables — '
  'see the header for why touching those tables with a soft-delete flag is a live bug, not a style '
  'choice.';

comment on column deleted_scene_versions.version is
  'to_jsonb(OLD) — the deleted scene_versions row, whole, rather than one column at a time, so a '
  'column added to scene_versions by a later migration is archived automatically with no edit '
  'needed here.';

comment on column deleted_scene_versions.clip_asset is
  'The version''s clip asset row (assets, by clip_asset_id), snapshotted at the moment this version '
  'is deleted. Null when the version never had a clip (only a prompt and/or frame were recorded). '
  'A snapshot, not a live join: the assets row itself is untouched by this trigger and may outlive '
  'or be deleted independently of this archive entry.';

comment on column deleted_scene_versions.n is
  'scene_versions.n at the moment of deletion — the "v3" an operator would recognize. Display only; '
  'a restore does not reuse it, since scene_versions still enforces unique (scene_id, n) and a newer '
  'version may already occupy that slot.';

comment on column deleted_scene_versions.user_id is
  'The owning project''s user_id, snapshotted at archive time from projects by way of scenes (RLS '
  'below reads this column, not a live join, since the scene and project may both be gone by the '
  'time anyone selects from here).';

comment on column deleted_scene_versions.hard_deleted_at is
  'Set by purgeDeletedVersion (web/actions/ugc.ts) when an editor empties this entry out of the bin. '
  'Marks the ARCHIVE row as forgotten — never the live scenes/scene_versions tables, and never the '
  'underlying Storage object (see this migration''s header). Null means still sitting in the bin.';

comment on column deleted_scene_versions.hard_deleted_by is
  'auth.uid() of whoever purged this entry, for the same audit reason 0088''s hard_deleted_by (added '
  'below) records it on deleted_scenes. Not an FK — see the no-foreign-keys note on this table''s '
  'own comment.';

create index deleted_scene_versions_project_id_deleted_at_idx
  on deleted_scene_versions (project_id, deleted_at desc);

create index deleted_scene_versions_scene_id_idx
  on deleted_scene_versions (scene_id);

-- ---------------------------------------------------------------------------
-- scene_versions BEFORE DELETE
-- ---------------------------------------------------------------------------
-- BEFORE, not AFTER: by the time an AFTER DELETE trigger fired, the row (and
-- its clip_asset_id) would already be gone, exactly 0088's reasoning for its
-- own scenes-level trigger.
--
-- security definer, set search_path = public: matches 0088 and
-- 0004_profile_trigger.sql — the function must be able to write the archive
-- regardless of who is doing the deleting, including an authenticated user
-- deleting their own version through their session client, where (per the
-- RLS block below) `authenticated` has no INSERT policy on this table at
-- all. Running as the table owner, exempt from RLS, is what lets the
-- trigger write rows nobody else may write directly.
create or replace function public.archive_deleted_scene_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id uuid;
  v_user_id    uuid;
  v_clip_asset jsonb;
begin
  -- The scene's own cascade already archived this row into
  -- deleted_scenes.versions (0088) and, one line down, has no scenes row
  -- left to read project_id from anyway. See this migration's header for
  -- why this check is empirically the whole story, not a heuristic.
  if not exists (select 1 from scenes where id = OLD.scene_id) then
    return OLD;
  end if;

  select s.project_id into v_project_id
  from scenes s
  where s.id = OLD.scene_id;

  select p.user_id into v_user_id
  from projects p
  where p.id = v_project_id;

  select to_jsonb(a) into v_clip_asset
  from assets a
  where a.id = OLD.clip_asset_id;

  insert into deleted_scene_versions (
    version_id, scene_id, project_id, user_id, n, version, clip_asset
  )
  values (
    OLD.id, OLD.scene_id, v_project_id, v_user_id, OLD.n, to_jsonb(OLD), v_clip_asset
  )
  on conflict (version_id) do nothing;

  return OLD;
end;
$$;

comment on function public.archive_deleted_scene_version is
  'BEFORE DELETE on scene_versions: copies the version row (to_jsonb(OLD)) and its clip asset '
  '(assets, by clip_asset_id) into deleted_scene_versions before the delete completes, so '
  'restoreClipVersion has something to restore from. Returns OLD without archiving when this fires '
  'as part of the parent scene''s own cascade — see this migration''s header for why that case is '
  'already covered by 0088''s deleted_scenes.versions and cannot be archived correctly here anyway '
  '(no scenes row left to read project_id/user_id from).';

create trigger scene_versions_archive_deleted_scene_version
  before delete on scene_versions
  for each row execute function public.archive_deleted_scene_version();

-- ---------------------------------------------------------------------------
-- deleted_scenes gains the same purge flag, for the same reason
-- ---------------------------------------------------------------------------
-- purgeDeletedScene needs the identical "forget this bin entry without
-- deleting the archive row" behavior for a whole deleted scene that
-- purgeDeletedVersion above gets for one version. Added here rather than in
-- a 0088 follow-up because the two purge actions ship together — see this
-- migration's header for why the flag belongs on the archive row and not on
-- any live table.
alter table deleted_scenes
  add column hard_deleted_at timestamptz,
  add column hard_deleted_by uuid;

comment on column deleted_scenes.hard_deleted_at is
  'Set by purgeDeletedScene (web/actions/ugc.ts) when an editor empties this entry out of the bin. '
  'Marks the ARCHIVE row as forgotten — never the live scenes table, and never the underlying '
  'Storage object (see 0092_deleted_scene_versions.sql''s header). Null means still sitting in the '
  'bin.';

comment on column deleted_scenes.hard_deleted_by is
  'auth.uid() of whoever purged this entry, for the same audit reason deleted_scene_versions '
  '(0092) records it. Not an FK — deleted_scenes already has no foreign keys, for the same reason '
  'documented on this table above.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Owner-readable, mirroring deleted_scenes (0088) exactly: the editor who
-- deleted their own version can see it in their bin without an admin in the
-- loop. Reads the snapshot column, not a live join — by the time anyone
-- selects from here the scene and project may both be gone.
--
-- No insert/update/delete policy at all, which under RLS means `deny` for
-- `authenticated` even though 0007_grants.sql's `alter default privileges`
-- grants the table-level privilege. This is append-only from the outside;
-- the one thing that may INSERT is the trigger above, security definer and
-- exempt from RLS. restoreClipVersion, purgeDeletedScene and
-- purgeDeletedVersion all run through the service-role admin client, which
-- bypasses RLS by design (0007_grants.sql) — same as every other write path
-- against this table family — so the absence of insert/update/delete
-- policies here does not block them; it only blocks a client session from
-- doing the same thing directly.
alter table deleted_scene_versions enable row level security;

create policy deleted_scene_versions_select on deleted_scene_versions
  for select
  using (user_id = auth.uid() or is_admin());
