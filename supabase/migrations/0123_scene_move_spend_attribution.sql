-- Project spend follows the scene when a /create clip is added to another
-- project. Keep runs as the immutable attempt ledger, but move their project
-- attribution with the scene so every project spend read (and project-delete
-- archive) stays attached to the project that now contains the clip.

update public.runs r
set project_id = s.project_id
from public.scenes s
where r.scene_id = s.id
  and r.project_id is distinct from s.project_id;

create or replace function public.sync_run_project_id_from_scene()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.project_id is distinct from old.project_id then
    update public.runs
    set project_id = new.project_id
    where scene_id = new.id
      and project_id is distinct from new.project_id;
  end if;
  return new;
end;
$$;

revoke all on function public.sync_run_project_id_from_scene() from public, anon, authenticated;

create trigger scenes_sync_run_project_id
after update of project_id on public.scenes
for each row
execute function public.sync_run_project_id_from_scene();
