-- The last of fal, and the only part of it that was still load-bearing.
--
-- fal was decommissioned as a vendor, but its name stayed on the columns
-- that hold kie's task ids and on the table that records kie credit
-- top-ups. That is not cosmetic. The whole reason fal was hard to remove
-- was that its vocabulary had become the schema's vocabulary: `endpoint`
-- held fal paths, `pricePerSecondUsd` was fal's rate, and every unmeasured
-- number fell back to a fal number. A column called fal_request_id holding
-- a kie task id is the same mistake still running, and the next person to
-- read it has to be told that the name is a lie before they can use it.
--
-- Renames only. No data moves, no semantics change: every value in these
-- columns is already a kie task id, written by the kie client.
--
-- On the name: kie_task_id, not vendor_request_id. The mistake with fal was
-- never that the name said "fal" — it was that the name kept saying "fal"
-- after fal was gone. The worker already calls this a kie task id in its
-- logs and its Go field (SubmitRequest/KieTaskID), so this makes the
-- database agree with the code rather than inventing a third vocabulary.

-- ---------------------------------------------------------------------------
-- scenes
-- ---------------------------------------------------------------------------
alter table public.scenes rename column fal_request_id to kie_task_id;
alter index public.scenes_fal_request_id_key rename to scenes_kie_task_id_key;

-- ---------------------------------------------------------------------------
-- runs
-- ---------------------------------------------------------------------------
alter table public.runs rename column fal_request_id to kie_task_id;
alter index public.runs_fal_request_id_idx rename to runs_kie_task_id_idx;

-- ---------------------------------------------------------------------------
-- deleted_project_cost_history
-- ---------------------------------------------------------------------------
alter table public.deleted_project_cost_history
  rename column fal_request_id to kie_task_id;
alter index public.deleted_project_cost_history_fal_request_id_idx
  rename to deleted_project_cost_history_kie_task_id_idx;

-- ---------------------------------------------------------------------------
-- fal_topups -> kie_topups
--
-- Renaming a table carries its policies, constraints and indexes with it,
-- but not their NAMES, so each is renamed explicitly. A constraint still
-- called fal_topups_amount_usd_check is the same lie in a smaller font, and
-- it is the string an operator sees in the error when the check fires.
-- ---------------------------------------------------------------------------
alter table public.fal_topups rename to kie_topups;

alter table public.kie_topups rename constraint fal_topups_pkey to kie_topups_pkey;
alter table public.kie_topups
  rename constraint fal_topups_recorded_by_fkey to kie_topups_recorded_by_fkey;
alter table public.kie_topups
  rename constraint fal_topups_amount_usd_check to kie_topups_amount_usd_check;

alter index public.fal_topups_topped_up_at_idx rename to kie_topups_topped_up_at_idx;

alter policy fal_topups_select_admin on public.kie_topups rename to kie_topups_select_admin;
alter policy fal_topups_insert_admin on public.kie_topups rename to kie_topups_insert_admin;

-- ---------------------------------------------------------------------------
-- archive_project_cost_history
--
-- THE reason this migration is not just a sequence of renames.
--
-- This trigger builds its INSERT as a dynamic SQL string, and a column
-- rename does not reach inside a string literal. Postgres would have
-- accepted every statement above and left this function referring to a
-- column that no longer exists — failing not at migration time but the next
-- time somebody deleted a project, which is precisely when the function's
-- job is to preserve that project's cost history before it is gone.
--
-- Recreated verbatim apart from the two renamed identifiers. The
-- information_schema probe for runs.project_id is deliberately preserved:
-- it is what lets this function run against databases on either side of
-- that column being added.
-- ---------------------------------------------------------------------------
create or replace function public.archive_project_cost_history()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_owner_email    text;
  project_id_where text := '';
begin
  select email into v_owner_email from profiles where id = OLD.user_id;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'runs'
      and column_name = 'project_id'
  ) then
    project_id_where := ' or r.project_id = $1';
  end if;

  execute
    'insert into deleted_project_cost_history (
       run_id, scene_id, project_id, kie_task_id, vendor, model, cost_usd,
       latency_ms, error, run_created_at, project_title, owner_email, user_id
     )
     select r.id, r.scene_id, $1, r.kie_task_id, r.vendor, r.model,
            r.cost_usd, r.latency_ms, r.error, r.created_at, $2, $3, $4
     from runs r
     where r.scene_id in (select id from scenes where project_id = $1)'
    || project_id_where ||
    ' on conflict (run_id) do nothing'
  using OLD.id, OLD.title, v_owner_email, OLD.user_id;

  return OLD;
end;
$function$;
