-- The project studio (/ugc/[id]) gets organised: a scene can be named,
-- dragged into a different place in the strip, and commented on.
--
-- scenes.title — an optional name. Null means "not named"; the tile then
-- shows the scene number alone, as before.
--
-- scenes.position — DISPLAY ORDER ONLY. Null means "never dragged", and the
-- strip orders by coalesce(position, idx). idx is NOT renumbered (owner's
-- decision, 2026-11-13): download filenames, billing history and the
-- (project_id, idx) unique key all hang off it, so "scene 3" stays scene 3
-- wherever it sits. No unique constraint on position: a reorder rewrites
-- several rows, and a transient duplicate must not fail it.
--
-- scene_comments — a thread per scene. The project's owner and admins read
-- and post (an admin is otherwise read-only on a project; a comment is how
-- they leave feedback on it).
--
-- READ ONLY UNDER RLS, like scene_references (0098): every write goes
-- through the service-role client in actions/scene-organize.ts, behind a
-- guard. With RLS enabled and no insert/update/delete policy, an
-- authenticated client reads its own projects' threads and writes nothing.

alter table scenes
  add column title text check (title is null or char_length(title) between 1 and 80),
  add column position integer;

comment on column scenes.title is
  'Optional name shown on the studio strip. Null = unnamed. See 0142.';
comment on column scenes.position is
  'Display order on the studio strip; null = never dragged. Order by coalesce(position, idx). '
  'idx is never renumbered. See 0142.';

create table scene_comments (
  id uuid primary key default gen_random_uuid(),
  scene_id uuid not null references scenes(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

comment on table scene_comments is
  'Comment thread per scene on the project studio. Owner and admins read (RLS) and post (service '
  'role, behind a guard). See 0142_scene_title_position_comments.sql.';

create index scene_comments_scene_id_created_at_idx on scene_comments (scene_id, created_at);

alter table scene_comments enable row level security;

create policy scene_comments_select on scene_comments
  for select
  using (
    exists (
      select 1
      from scenes s
      join projects p on p.id = s.project_id
      where s.id = scene_comments.scene_id
        and (p.user_id = (select auth.uid()) or (select is_admin()))
    )
  );
