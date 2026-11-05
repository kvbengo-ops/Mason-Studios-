-- scene_references gets the SELECT policy it never had.
--
-- THE BUG. On production, RLS is enabled on this table but it has no
-- policies. No migration ever enabled RLS here (0071 did not), so it was
-- switched on outside the repo. Every read through a user-scoped client
-- returned zero rows and no error. /ugc/[id]/page.tsx seeds the scene's
-- References box with exactly that read. After #140, reopening any saved
-- scene showed "0/10" while its rows sat in the table, and Generate stayed
-- disabled behind "not in references" for every tag the prompt already had.
-- Local databases never enabled RLS, so local testing passed.
--
-- READ ONLY, ON PURPOSE. Every write goes through the service-role client:
-- attachSceneReferences and the restore path in actions/ugc.ts, plus the
-- worker. With RLS enabled and no insert/update/delete policy, an
-- authenticated client can read its own scenes' rows and write nothing.
--
-- The rule is inherited through the parent scene's project, mirroring
-- scene_versions_select (0058): owners and admins read.

alter table scene_references enable row level security;

drop policy if exists scene_references_select on scene_references;

create policy scene_references_select on scene_references
  for select
  using (
    exists (
      select 1
      from scenes s
      join projects p on p.id = s.project_id
      where s.id = scene_references.scene_id
        and (p.user_id = auth.uid() or is_admin())
    )
  );
