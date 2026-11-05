-- =============================================================================
-- scene_versions — one row per attempt at a scene, bundling the three things
-- that have to agree: the prompt, the reference frame, and the clip rendered
-- from them. scenes.active_version_id says which one the delivery uses.
-- =============================================================================
-- Why one row and not three histories.
--
-- The three are not independently meaningful. A clip is rendered FROM a
-- specific frame AND a specific prompt; a frame is generated FROM a specific
-- prompt. Versioning them separately would let an operator pick frame v3 with
-- prompt v1 and a clip that was rendered from neither, which is not a state
-- anyone can reason about and is exactly the silent mismatch the Character
-- and Product screens already have staleness banners for. So a version is
-- the triple, taken together, and switching versions switches all three.
--
-- What already existed, and what did not:
--
--   - Reference frames were ALREADY append-only. generateSceneFrame
--     (web/actions/frames.ts) inserts a new `ref_frame` asset every time and
--     repoints scenes.ref_frame_asset_id; it has never deleted one. Every
--     frame an operator has ever paid for is still in `assets`.
--   - Clips were NOT. rerenderScene (web/actions/enqueue.ts) deletes the
--     scene's clip and poster assets before queueing the new render, so the
--     $1.89 that produced the previous clip bought something that no longer
--     exists. That delete has to become "leave it attached to its version".
--   - Prompts were never kept at all: scenes.video_prompt is overwritten in
--     place by the autosave, by Rewrite with AI, and by a recompile.
--
-- So this table is the first place any of it is readable as a set, and the
-- clip column is the only one of the three whose history has to be RESCUED
-- rather than merely exposed.
--
-- Cost note, deliberately left as a decision rather than a policy: nothing
-- here prunes old versions. A clip is the expensive artifact and Supabase
-- storage is billed by the gigabyte, so a project re-rendered twenty times
-- keeps twenty clips. That is the correct default for now — the whole point
-- is that a paid-for clip stops vanishing — but a retention rule (keep the
-- active version plus the last N) is the obvious follow-up once real usage
-- says what N is.
create table scene_versions (
  id uuid primary key default gen_random_uuid(),

  scene_id uuid not null references scenes (id) on delete cascade,

  -- 1, 2, 3 … per scene, shown to the operator as "v1", "v2". Not a
  -- timestamp ordering: an operator reading "Scene 1 · A-roll · v2" needs a
  -- number they can say out loud, and created_at ordering is an
  -- implementation detail that breaks the moment two rows share an instant.
  n integer not null,

  -- The prompt AS IT WAS when this version was made. A copy, not a
  -- reference: scenes.video_prompt keeps being overwritten in place by the
  -- autosave, and a version that pointed at it would silently change its own
  -- history every time the operator typed.
  video_prompt text,

  -- on delete set null, not cascade: losing the asset row must not delete
  -- the record that this version existed and what it cost. The runs table
  -- keeps the spend either way (0054 made runs survive a scene delete for
  -- the same reason).
  ref_frame_asset_id uuid references assets (id) on delete set null,
  clip_asset_id uuid references assets (id) on delete set null,

  created_at timestamptz not null default now(),

  unique (scene_id, n)
);

comment on table scene_versions is
  'One attempt at a scene: the prompt, the frame generated from it, and the clip rendered from that frame. Switching versions switches all three together — see this migration''s header for why they are not versioned separately.';

comment on column scene_versions.n is
  'Per-scene counter starting at 1, shown as "v1"/"v2". Unique per scene.';

comment on column scene_versions.video_prompt is
  'A COPY of scenes.video_prompt at the moment this version was created, not a reference to it — the live column is overwritten in place by the autosave.';

-- Which version this scene currently IS: the frame shown, the clip played,
-- and the clip the assembled cut uses. Nullable so every existing scene is
-- valid before the backfill below runs, and so a scene whose only version is
-- deleted degrades to "no version selected" rather than to a dangling id.
alter table scenes
  add column active_version_id uuid references scene_versions (id) on delete set null;

comment on column scenes.active_version_id is
  'The scene_versions row this scene currently shows and delivers. Null means no version has been recorded yet (a scene created before 0058 and never re-rendered since).';

-- Backfill: every scene that has anything worth versioning gets v1 built
-- from its current state. Scenes with no prompt and no frame get nothing —
-- there is no attempt to record.
insert into scene_versions (scene_id, n, video_prompt, ref_frame_asset_id, clip_asset_id)
select
  s.id,
  1,
  s.video_prompt,
  s.ref_frame_asset_id,
  (
    select a.id
    from assets a
    where a.scene_id = s.id
      and a.kind = 'clip'
    order by a.created_at desc
    limit 1
  )
from scenes s
where s.video_prompt is not null
   or s.ref_frame_asset_id is not null;

update scenes s
set active_version_id = v.id
from scene_versions v
where v.scene_id = s.id
  and v.n = 1;

-- ---------------------------------------------------------------------------
-- RLS — inherited through the parent scene's project, exactly mirroring the
-- scenes policies in 0002_rls.sql: admins read, owners write.
-- ---------------------------------------------------------------------------
alter table scene_versions enable row level security;

create policy scene_versions_select on scene_versions
  for select
  using (
    exists (
      select 1
      from scenes s
      join projects p on p.id = s.project_id
      where s.id = scene_versions.scene_id
        and (p.user_id = auth.uid() or is_admin())
    )
  );

create policy scene_versions_insert on scene_versions
  for insert
  with check (
    exists (
      select 1
      from scenes s
      join projects p on p.id = s.project_id
      where s.id = scene_versions.scene_id
        and p.user_id = auth.uid()
    )
  );

create policy scene_versions_update on scene_versions
  for update
  using (
    exists (
      select 1
      from scenes s
      join projects p on p.id = s.project_id
      where s.id = scene_versions.scene_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from scenes s
      join projects p on p.id = s.project_id
      where s.id = scene_versions.scene_id
        and p.user_id = auth.uid()
    )
  );

create policy scene_versions_delete on scene_versions
  for delete
  using (
    exists (
      select 1
      from scenes s
      join projects p on p.id = s.project_id
      where s.id = scene_versions.scene_id
        and p.user_id = auth.uid()
    )
  );

-- The one index the read path needs: every screen that shows a scene loads
-- its versions newest-first.
create index scene_versions_scene_idx on scene_versions (scene_id, n desc);
