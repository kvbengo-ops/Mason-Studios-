-- =============================================================================
-- Row Level Security
--
-- NOTE: the service role key used by Server Actions (web) and the Go worker
-- bypasses RLS entirely. These policies protect the anon/authenticated
-- client paths only — Server Actions and the worker MUST still check
-- ownership in application code; do not rely on RLS alone for those paths.
-- =============================================================================

-- security-definer helper avoids recursive RLS when a `profiles` policy
-- itself needs to query `profiles` to check role.
create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
alter table profiles enable row level security;

create policy profiles_select_own on profiles
  for select
  using (id = auth.uid());

create policy profiles_select_admin on profiles
  for select
  using (is_admin());

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
alter table projects enable row level security;

create policy projects_select on projects
  for select
  using (user_id = auth.uid() or is_admin());

create policy projects_insert_own on projects
  for insert
  with check (user_id = auth.uid());

create policy projects_update_own on projects
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy projects_delete_own on projects
  for delete
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Admins have read-only access; write policies are owner-only on every table.
-- ---------------------------------------------------------------------------
--
-- scenes — inherit via parent project
-- ---------------------------------------------------------------------------
alter table scenes enable row level security;

create policy scenes_select on scenes
  for select
  using (
    exists (
      select 1 from projects p
      where p.id = scenes.project_id
        and (p.user_id = auth.uid() or is_admin())
    )
  );

create policy scenes_insert on scenes
  for insert
  with check (
    exists (
      select 1 from projects p
      where p.id = scenes.project_id
        and p.user_id = auth.uid()
    )
  );

create policy scenes_update on scenes
  for update
  using (
    exists (
      select 1 from projects p
      where p.id = scenes.project_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from projects p
      where p.id = scenes.project_id
        and p.user_id = auth.uid()
    )
  );

create policy scenes_delete on scenes
  for delete
  using (
    exists (
      select 1 from projects p
      where p.id = scenes.project_id
        and p.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- assets — inherit via parent project
-- ---------------------------------------------------------------------------
alter table assets enable row level security;

create policy assets_select on assets
  for select
  using (
    exists (
      select 1 from projects p
      where p.id = assets.project_id
        and (p.user_id = auth.uid() or is_admin())
    )
  );

create policy assets_insert on assets
  for insert
  with check (
    exists (
      select 1 from projects p
      where p.id = assets.project_id
        and p.user_id = auth.uid()
    )
  );

create policy assets_update on assets
  for update
  using (
    exists (
      select 1 from projects p
      where p.id = assets.project_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from projects p
      where p.id = assets.project_id
        and p.user_id = auth.uid()
    )
  );

create policy assets_delete on assets
  for delete
  using (
    exists (
      select 1 from projects p
      where p.id = assets.project_id
        and p.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- runs — inherit via parent project (runs.scene_id -> scenes.project_id)
-- ---------------------------------------------------------------------------
alter table runs enable row level security;

create policy runs_select on runs
  for select
  using (
    exists (
      select 1 from scenes s
      join projects p on p.id = s.project_id
      where s.id = runs.scene_id
        and (p.user_id = auth.uid() or is_admin())
    )
  );

create policy runs_insert on runs
  for insert
  with check (
    exists (
      select 1 from scenes s
      join projects p on p.id = s.project_id
      where s.id = runs.scene_id
        and p.user_id = auth.uid()
    )
  );

create policy runs_update on runs
  for update
  using (
    exists (
      select 1 from scenes s
      join projects p on p.id = s.project_id
      where s.id = runs.scene_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from scenes s
      join projects p on p.id = s.project_id
      where s.id = runs.scene_id
        and p.user_id = auth.uid()
    )
  );

create policy runs_delete on runs
  for delete
  using (
    exists (
      select 1 from scenes s
      join projects p on p.id = s.project_id
      where s.id = runs.scene_id
        and p.user_id = auth.uid()
    )
  );
