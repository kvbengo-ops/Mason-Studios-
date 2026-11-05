-- =============================================================================
-- is_active() on the scenes / assets / runs write policies — the half of the
-- spend chain 0052 left open.
--
-- 0052_account_approval.sql added is_active() to projects_insert_own ONLY,
-- and said so on purpose: "an account that cannot own a project cannot
-- reach any of them either — one policy closes the whole spend chain."
-- That holds for a 'pending' account, which by definition has never owned
-- anything. It does not hold for 'rejected', and rejected is the status
-- that has to bite hardest.
--
-- Every scenes/assets/runs write policy authorises through
-- `exists (select 1 from projects p where p.id = <table>.project_id and
-- p.user_id = auth.uid())` (0002_rls.sql; runs' four were re-pointed at
-- runs.project_id directly by 0030_runs_project_id.sql). That subquery asks
-- exactly one question — does the caller own the parent project — and
-- nothing in it consults profiles.status. So an account that was 'active'
-- long enough to create a project and is then set to 'rejected' still
-- satisfies all nine of them: it can add scenes, write assets, and insert
-- `runs` rows against the projects it already owns. `runs` is the spend
-- table. The JWT it does that with stays valid for up to jwt_expiry (3600s,
-- supabase/config.toml) past the decision, and PostgREST with the anon key
-- never sees requireUser()'s /pending redirect at all — RLS is supposed to
-- be the line that holds there, and on these nine policies it wasn't.
--
-- ---------------------------------------------------------------------------
-- Scope
-- ---------------------------------------------------------------------------
-- Writes only, on the three tables that hang off a project. Adding
-- `and is_active()` costs one more index-lookup-shaped `exists` on a query
-- that already runs one, and is a no-op for every 'active' account — which
-- is every account that can use the app at all.
--
-- Reads (scenes_select / assets_select / runs_select) are deliberately left
-- alone, same reasoning as 0052's: a rejected account seeing its own
-- existing rows costs nothing, and /pending has to stay readable for the
-- account it is holding.
--
-- projects_update_own / projects_delete_own are also left alone. They are
-- writes, but neither one can spend: renaming or deleting a project the
-- caller already owns moves no money. If that changes, this is the file to
-- copy.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- scenes
-- ---------------------------------------------------------------------------
drop policy scenes_insert on scenes;

create policy scenes_insert on scenes
  for insert
  with check (
    is_active()
    and exists (
      select 1 from projects p
      where p.id = scenes.project_id
        and p.user_id = auth.uid()
    )
  );

drop policy scenes_update on scenes;

create policy scenes_update on scenes
  for update
  using (
    is_active()
    and exists (
      select 1 from projects p
      where p.id = scenes.project_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    is_active()
    and exists (
      select 1 from projects p
      where p.id = scenes.project_id
        and p.user_id = auth.uid()
    )
  );

drop policy scenes_delete on scenes;

create policy scenes_delete on scenes
  for delete
  using (
    is_active()
    and exists (
      select 1 from projects p
      where p.id = scenes.project_id
        and p.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- assets
-- ---------------------------------------------------------------------------
drop policy assets_insert on assets;

create policy assets_insert on assets
  for insert
  with check (
    is_active()
    and exists (
      select 1 from projects p
      where p.id = assets.project_id
        and p.user_id = auth.uid()
    )
  );

drop policy assets_update on assets;

create policy assets_update on assets
  for update
  using (
    is_active()
    and exists (
      select 1 from projects p
      where p.id = assets.project_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    is_active()
    and exists (
      select 1 from projects p
      where p.id = assets.project_id
        and p.user_id = auth.uid()
    )
  );

drop policy assets_delete on assets;

create policy assets_delete on assets
  for delete
  using (
    is_active()
    and exists (
      select 1 from projects p
      where p.id = assets.project_id
        and p.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- runs — project_id directly, per 0030_runs_project_id.sql, NOT through
-- scenes. Copied from 0030's definitions, which are the live ones.
-- ---------------------------------------------------------------------------
drop policy runs_insert on runs;

create policy runs_insert on runs
  for insert
  with check (
    is_active()
    and exists (
      select 1 from projects p
      where p.id = runs.project_id
        and p.user_id = auth.uid()
    )
  );

drop policy runs_update on runs;

create policy runs_update on runs
  for update
  using (
    is_active()
    and exists (
      select 1 from projects p
      where p.id = runs.project_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    is_active()
    and exists (
      select 1 from projects p
      where p.id = runs.project_id
        and p.user_id = auth.uid()
    )
  );

drop policy runs_delete on runs;

create policy runs_delete on runs
  for delete
  using (
    is_active()
    and exists (
      select 1 from projects p
      where p.id = runs.project_id
        and p.user_id = auth.uid()
    )
  );

comment on function is_active() is
  'True when the calling account has been approved by an admin (profiles.status = ''active''). '
  'Mirrors is_admin() (0002_rls.sql). Guards every write policy that can start or extend the spend '
  'chain: projects_insert_own (0052_account_approval.sql) plus the scenes/assets/runs '
  'insert/update/delete policies (0053_active_gate_on_child_writes.sql). 0052 gated projects only, '
  'on the reasoning that project ownership covers the children — see 0053''s header for why that '
  'left a rejected account still able to write against projects it ALREADY owned.';
