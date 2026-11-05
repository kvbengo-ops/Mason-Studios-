-- Preserve the fal queue request that belongs to each worker-side paid
-- attempt. scenes.fal_request_id is only the current attempt and is cleared
-- or overwritten when an operator retries, while runs is the immutable
-- per-attempt ledger.
--
-- fal's usage API does not expose request ids, so this is not an automatic
-- join to an invoice line. It makes our own ledger self-sufficient: a support
-- investigation can follow the exact request named in worker logs and fal's
-- queue APIs instead of finding only the scene's most recent request.
--
-- Nullable on purpose. Existing rows, non-fal vendors, failures before a
-- request id was returned, and ambiguous submissions whose response was lost
-- have no trustworthy id to persist. It is not unique: idempotency is enforced
-- by the scene status guards around MarkDone/MarkFailed, and the request id is
-- evidence rather than a second concurrency mechanism.

alter table runs
  add column fal_request_id text;

comment on column runs.fal_request_id is
  'The fal queue request id for this individual attempt. Unlike scenes.fal_request_id, which holds '
  'only the current attempt and may be cleared or overwritten on retry, this value is immutable with '
  'the runs row. Null means no trustworthy request id is available (including pre-column rows, '
  'pre-submission failures, non-fal vendors, and billing-unknown submissions). fal usage line items '
  'do not expose request ids, so this supports internal traceability and vendor investigation rather '
  'than an automatic per-line invoice join.';

create index runs_fal_request_id_idx
  on runs (fal_request_id)
  where fal_request_id is not null;

-- A deleted project must not erase the request identity while preserving the
-- rest of the run as cost history. Keep the archive in lockstep and replace
-- both trigger functions from 0040 with the additional copied column.
alter table deleted_project_cost_history
  add column fal_request_id text;

comment on column deleted_project_cost_history.fal_request_id is
  'Snapshot of runs.fal_request_id, preserved when its project or scene is deleted.';

create index deleted_project_cost_history_fal_request_id_idx
  on deleted_project_cost_history (fal_request_id)
  where fal_request_id is not null;

create or replace function public.archive_project_cost_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
       run_id, scene_id, project_id, fal_request_id, vendor, model, cost_usd,
       latency_ms, error, run_created_at, project_title, owner_email, user_id
     )
     select r.id, r.scene_id, $1, r.fal_request_id, r.vendor, r.model,
            r.cost_usd, r.latency_ms, r.error, r.created_at, $2, $3, $4
     from runs r
     where r.scene_id in (select id from scenes where project_id = $1)'
    || project_id_where ||
    ' on conflict (run_id) do nothing'
  using OLD.id, OLD.title, v_owner_email, OLD.user_id;

  return OLD;
end;
$$;

comment on function public.archive_project_cost_history is
  'BEFORE DELETE on projects: copies every runs row reachable from the project into '
  'deleted_project_cost_history before cascades remove it. Identity, ownership, cost, and '
  'fal_request_id are snapshotted because none can be recovered from the deleted live rows.';

create or replace function public.archive_scene_cost_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_title text;
  v_owner_email   text;
  v_owner_user_id uuid;
begin
  select p.title, prof.email, p.user_id
    into v_project_title, v_owner_email, v_owner_user_id
  from projects p
  left join profiles prof on prof.id = p.user_id
  where p.id = OLD.project_id;

  insert into deleted_project_cost_history (
    run_id, scene_id, project_id, fal_request_id, vendor, model, cost_usd,
    latency_ms, error, run_created_at, project_title, owner_email, user_id
  )
  select r.id, r.scene_id, OLD.project_id, r.fal_request_id, r.vendor, r.model,
         r.cost_usd, r.latency_ms, r.error, r.created_at, v_project_title,
         v_owner_email, v_owner_user_id
  from runs r
  where r.scene_id = OLD.id
  on conflict (run_id) do nothing;

  return OLD;
end;
$$;

comment on function public.archive_scene_cost_history is
  'BEFORE DELETE on scenes: copies each runs row for the scene into deleted_project_cost_history '
  'before the cascade, including its immutable fal_request_id. The project-delete trigger may have '
  'already archived the same run; ON CONFLICT (run_id) DO NOTHING makes that overlap harmless.';
