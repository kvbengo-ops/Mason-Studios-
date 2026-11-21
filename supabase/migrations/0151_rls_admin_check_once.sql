-- Evaluate is_admin() once per query in the four hot read policies.
--
-- A bare `is_admin()` in a policy runs per row; `(select is_admin())` takes
-- no row argument, so Postgres runs it once as an InitPlan. Same meaning,
-- same STABLE function. Measured as an admin (2026-11-21): a week of runs
-- 61 ms vs 4 ms with RLS off, all assets 208 ms vs 25 ms.
--
-- Only the SELECT policies of the big tables. The other ~30 policies that
-- call is_admin()/is_active() are writes or small tables, where the per-row
-- cost does not show.
alter policy runs_select on public.runs using (
  (user_id = (select auth.uid()))
  or ((user_id is not null) and (select is_admin()))
  or exists (
    select 1 from projects p
    where p.id = runs.project_id
      and ((p.user_id = (select auth.uid())) or (select is_admin()))
  )
);

alter policy assets_select on public.assets using (
  (user_id = (select auth.uid()))
  or ((user_id is not null) and (select is_admin()))
  or exists (
    select 1 from projects p
    where p.id = assets.project_id
      and ((p.user_id = (select auth.uid())) or (select is_admin()))
  )
  or exists (
    select 1 from elements e
    where e.asset_id = assets.id
      and e.deleted_at is null
      and (e.is_shared or (e.user_id = (select auth.uid())) or (select is_admin()))
      and account_owns_asset(e.user_id, assets.id)
  )
);

alter policy projects_select on public.projects using (
  (user_id = (select auth.uid())) or (select is_admin())
);

alter policy scenes_select on public.scenes using (
  exists (
    select 1 from projects p
    where p.id = scenes.project_id
      and ((p.user_id = (select auth.uid())) or (select is_admin()))
  )
);
