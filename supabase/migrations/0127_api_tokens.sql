-- =============================================================================
-- 0127_api_tokens.sql
-- Personal API tokens, column-scoped RLS grants, fenced scene preparation,
-- and single-transaction spend-cap serialization across browser and API paths.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. public.api_tokens
-- -----------------------------------------------------------------------------
create table public.api_tokens (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  token_hash      text not null unique check (char_length(token_hash) = 64),
  token_prefix    text not null check (char_length(token_prefix) between 8 and 24),
  scopes          text[] not null default array['read', 'upload', 'generate']::text[]
                    check (
                      scopes <@ array['read', 'upload', 'generate']::text[]
                      and cardinality(scopes) >= 1
                    ),
  monthly_cap_usd numeric check (monthly_cap_usd is null or monthly_cap_usd >= 0),
  expires_at      timestamptz,
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

comment on table public.api_tokens is
  'Personal API tokens (ms_live_<64-hex>). Raw tokens are shown once at creation; only the '
  'SHA-256 hex digest is stored in token_hash. Column-level SELECT grants hide token_hash from '
  'authenticated/anon callers.';

create index api_tokens_user_id_created_at_idx
  on public.api_tokens (user_id, created_at desc);

-- 0007_grants.sql sets default table privileges granting SELECT, INSERT, UPDATE, DELETE to
-- authenticated on every new public table. Row-level security filters rows, not columns, so
-- leaving table-level SELECT in place would let a signed-in user or admin SELECT token_hash.
-- Revoke all table privileges and grant column-scoped SELECT on safe metadata columns only.
alter table public.api_tokens enable row level security;

revoke all on table public.api_tokens from public, anon, authenticated;

grant select (
  id,
  user_id,
  name,
  token_prefix,
  scopes,
  monthly_cap_usd,
  expires_at,
  last_used_at,
  revoked_at,
  created_at
) on table public.api_tokens to authenticated;

create policy api_tokens_select_own_or_admin on public.api_tokens
  for select to authenticated
  using (public.is_active() and (user_id = auth.uid() or public.is_admin()));

-- -----------------------------------------------------------------------------
-- 2. public.scenes & public.runs additions for API idempotency, fencing & spend
-- -----------------------------------------------------------------------------
alter table public.scenes
  add column if not exists api_token_id uuid references public.api_tokens(id) on delete set null,
  add column if not exists idempotency_key text
    check (idempotency_key is null or char_length(idempotency_key) between 1 and 128),
  add column if not exists idempotency_hash text,
  add column if not exists estimated_cost_usd numeric
    check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  add column if not exists prepare_token uuid,
  add column if not exists prepare_started_at timestamptz;

create unique index if not exists scenes_project_idempotency_key_uniq
  on public.scenes (project_id, idempotency_key)
  where idempotency_key is not null;

alter table public.runs
  add column if not exists api_token_id uuid references public.api_tokens(id) on delete set null;

create index if not exists runs_api_token_id_created_at_idx
  on public.runs (api_token_id, created_at)
  where api_token_id is not null;

-- Copy scenes.api_token_id onto runs on insert so token spend attribution survives
-- even if the scene is later deleted (0054 sets runs.scene_id = NULL on scene delete)
-- and requires zero Go worker changes.
create or replace function public.runs_inherit_scene_api_token()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if NEW.scene_id is not null and NEW.api_token_id is null then
    select s.api_token_id into NEW.api_token_id
    from public.scenes s
    where s.id = NEW.scene_id;
  end if;
  return NEW;
end;
$$;

revoke all on function public.runs_inherit_scene_api_token() from public, anon, authenticated;
grant execute on function public.runs_inherit_scene_api_token() to service_role;

drop trigger if exists runs_set_api_token_id on public.runs;
create trigger runs_set_api_token_id
  before insert on public.runs
  for each row execute function public.runs_inherit_scene_api_token();

-- -----------------------------------------------------------------------------
-- 3. public.insert_frame_ready_scene — atomic idx allocation + idempotency check
-- -----------------------------------------------------------------------------
create or replace function public.insert_frame_ready_scene(
  p_project_id               uuid,
  p_expected_user_id         uuid,
  p_duration_s               int,
  p_is_talking_head          boolean,
  p_video_prompt             text,
  p_ai_generated_prompt      text,
  p_render_settings_override jsonb,
  p_dev                      boolean,
  p_api_token_id             uuid,
  p_idempotency_key          text,
  p_idempotency_hash         text,
  p_prepare_token            uuid
)
returns table (
  outcome            text,       -- 'inserted' | 'existing'
  scene_id           uuid,
  scene_status       text,
  idempotency_hash   text,
  prepare_token      uuid,
  prepare_started_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner_id           uuid;
  v_existing_id        uuid;
  v_existing_status    text;
  v_existing_hash      text;
  v_existing_token     uuid;
  v_existing_started   timestamptz;
  v_next_idx           int;
  v_new_id             uuid;
  v_now                timestamptz;
begin
  if p_project_id is null or p_expected_user_id is null or p_prepare_token is null then
    raise exception 'insert_frame_ready_scene: project_id, expected_user_id, and prepare_token are required'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_duration_s is null or p_duration_s < 3 then
    raise exception 'insert_frame_ready_scene: duration_s must be >= 3'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Serialize per-project idx allocation and idempotency check.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('project-idx:' || p_project_id::text)
  );

  select p.user_id into v_owner_id
  from public.projects p
  where p.id = p_project_id
  for update;

  if not found or v_owner_id is distinct from p_expected_user_id then
    raise exception 'insert_frame_ready_scene: project % not found for user %',
      p_project_id, p_expected_user_id
      using errcode = 'insufficient_privilege';
  end if;

  if p_idempotency_key is not null then
    select s.id, s.status, s.idempotency_hash, s.prepare_token, s.prepare_started_at
      into v_existing_id, v_existing_status, v_existing_hash, v_existing_token, v_existing_started
    from public.scenes s
    where s.project_id = p_project_id
      and s.idempotency_key = p_idempotency_key
    limit 1;

    if found then
      return query select
        'existing'::text,
        v_existing_id,
        v_existing_status,
        v_existing_hash,
        v_existing_token,
        v_existing_started;
      return;
    end if;
  end if;

  select coalesce(max(s.idx), 0) + 1 into v_next_idx
  from public.scenes s
  where s.project_id = p_project_id;

  v_now := pg_catalog.clock_timestamp();

  insert into public.scenes (
    project_id,
    idx,
    duration_s,
    is_talking_head,
    script_line,
    video_prompt,
    ai_generated_prompt,
    status,
    dev,
    render_settings_override,
    api_token_id,
    idempotency_key,
    idempotency_hash,
    prepare_token,
    prepare_started_at
  )
  values (
    p_project_id,
    v_next_idx,
    p_duration_s,
    coalesce(p_is_talking_head, false),
    null,
    p_video_prompt,
    p_ai_generated_prompt,
    'frame_ready',
    coalesce(p_dev, false),
    p_render_settings_override,
    p_api_token_id,
    p_idempotency_key,
    p_idempotency_hash,
    p_prepare_token,
    v_now
  )
  returning id into v_new_id;

  return query select
    'inserted'::text,
    v_new_id,
    'frame_ready'::text,
    p_idempotency_hash,
    p_prepare_token,
    v_now;
end;
$$;

revoke all on function public.insert_frame_ready_scene(
  uuid, uuid, int, boolean, text, text, jsonb, boolean, uuid, text, text, uuid
) from public, anon, authenticated;

grant execute on function public.insert_frame_ready_scene(
  uuid, uuid, int, boolean, text, text, jsonb, boolean, uuid, text, text, uuid
) to service_role;

-- -----------------------------------------------------------------------------
-- 4. public.attach_scene_references_fenced — fenced reference & asset insertion
-- -----------------------------------------------------------------------------
create or replace function public.attach_scene_references_fenced(
  p_scene_id      uuid,
  p_project_id    uuid,
  p_prepare_token uuid,
  p_refs          jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item          jsonb;
  v_asset_id      uuid;
  v_first_image   uuid := null;
  v_kind          text;
  v_asset_kind    text;
  v_storage_key   text;
  v_duration_s    numeric;
  v_ordinal       int;
  v_category      text;
  v_description   text;
  v_tag           text;
begin
  if p_scene_id is null or p_project_id is null or p_prepare_token is null then
    raise exception 'attach_scene_references_fenced: scene_id, project_id, and prepare_token are required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Lock scene row and verify this attempt still holds the active prepare_token.
  perform 1
  from public.scenes s
  where s.id = p_scene_id
    and s.project_id = p_project_id
    and s.status = 'frame_ready'
    and s.prepare_token = p_prepare_token
  for update;

  if not found then
    return false;
  end if;

  -- Refresh lease timestamp so the 5-minute sweeper sees active progress.
  update public.scenes
  set prepare_started_at = pg_catalog.clock_timestamp()
  where id = p_scene_id;

  if p_refs is null or pg_catalog.jsonb_typeof(p_refs) <> 'array' or pg_catalog.jsonb_array_length(p_refs) = 0 then
    return true;
  end if;

  for v_item in select * from pg_catalog.jsonb_array_elements(p_refs)
  loop
    v_kind        := v_item->>'kind';
    v_asset_kind  := (v_item->>'asset_kind')::text;
    v_storage_key := v_item->>'storage_key';
    v_duration_s  := case
                       when v_item ? 'duration_s' and v_item->>'duration_s' is not null
                       then (v_item->>'duration_s')::numeric
                       else null
                     end;
    v_ordinal     := (v_item->>'ordinal')::int;
    v_category    := v_item->>'category';
    v_description := v_item->>'description';
    v_tag         := v_item->>'tag';

    insert into public.assets (
      project_id,
      scene_id,
      kind,
      storage_key,
      duration_s
    )
    values (
      p_project_id,
      p_scene_id,
      v_asset_kind,
      v_storage_key,
      v_duration_s
    )
    returning id into v_asset_id;

    if v_kind = 'image' and v_first_image is null then
      v_first_image := v_asset_id;
    end if;

    insert into public.scene_references (
      scene_id,
      asset_id,
      kind,
      ordinal,
      category,
      description,
      tag
    )
    values (
      p_scene_id,
      v_asset_id,
      v_kind,
      v_ordinal,
      v_category,
      v_description,
      v_tag
    );
  end loop;

  if v_first_image is not null then
    update public.scenes
    set ref_frame_asset_id = coalesce(ref_frame_asset_id, v_first_image)
    where id = p_scene_id;
  end if;

  return true;
end;
$$;

revoke all on function public.attach_scene_references_fenced(
  uuid, uuid, uuid, jsonb
) from public, anon, authenticated;

grant execute on function public.attach_scene_references_fenced(
  uuid, uuid, uuid, jsonb
) to service_role;

-- -----------------------------------------------------------------------------
-- 5. public.reclaim_stale_frame_ready_scene — exclusive CAS lease takeover
-- -----------------------------------------------------------------------------
create or replace function public.reclaim_stale_frame_ready_scene(
  p_scene_id               uuid,
  p_project_id             uuid,
  p_expected_prepare_token uuid,
  p_new_prepare_token      uuid
)
returns table (
  claimed         boolean,
  superseded_keys text[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claimed_id      uuid;
  v_superseded_keys text[];
begin
  if p_scene_id is null or p_project_id is null or p_new_prepare_token is null then
    raise exception 'reclaim_stale_frame_ready_scene: scene_id, project_id, and new_prepare_token are required'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.scenes s
  set prepare_token = p_new_prepare_token,
      prepare_started_at = pg_catalog.clock_timestamp(),
      ref_frame_asset_id = null
  where s.id = p_scene_id
    and s.project_id = p_project_id
    and s.status = 'frame_ready'
    and s.prepare_token is not distinct from p_expected_prepare_token
    and s.prepare_started_at < pg_catalog.clock_timestamp() - interval '15 seconds'
  returning s.id into v_claimed_id;

  if v_claimed_id is null then
    return query select false, array[]::text[];
    return;
  end if;

  delete from public.scene_references
  where scene_id = p_scene_id;

  with deleted_assets as (
    delete from public.assets
    where scene_id = p_scene_id
      and project_id = p_project_id
    returning storage_key
  )
  select coalesce(pg_catalog.array_agg(storage_key), array[]::text[])
    into v_superseded_keys
  from deleted_assets;

  return query select true, v_superseded_keys;
end;
$$;

revoke all on function public.reclaim_stale_frame_ready_scene(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated;

grant execute on function public.reclaim_stale_frame_ready_scene(
  uuid, uuid, uuid, uuid
) to service_role;

-- -----------------------------------------------------------------------------
-- 5a. public.delete_abandoned_api_scene — DB-clock lease check and safe cleanup
-- -----------------------------------------------------------------------------
create or replace function public.delete_abandoned_api_scene(
  p_scene_id      uuid,
  p_prepare_token uuid
)
returns table (
  scene_id     uuid,
  storage_keys text[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_asset_ids   uuid[];
  v_storage_keys text[];
  v_deleted_id  uuid;
begin
  -- Lock only an abandoned API preparation. An attach call refreshes this row
  -- under the same lock, so either it wins and this sees a fresh lease, or
  -- deletion wins and the attach RPC is fenced out.
  perform 1
  from public.scenes s
  where s.id = p_scene_id
    and s.status = 'frame_ready'
    and s.api_token_id is not null
    and s.prepare_token = p_prepare_token
    and s.prepare_started_at < pg_catalog.clock_timestamp() - interval '5 minutes'
  for update;
  if not found then
    return;
  end if;

  select
    coalesce(pg_catalog.array_agg(a.id), array[]::uuid[]),
    coalesce(pg_catalog.array_agg(a.storage_key), array[]::text[])
  into v_asset_ids, v_storage_keys
  from public.assets a
  where a.scene_id = p_scene_id;

  delete from public.scenes s
  where s.id = p_scene_id
    and s.status = 'frame_ready'
    and s.api_token_id is not null
    and s.prepare_token = p_prepare_token
    and s.prepare_started_at < pg_catalog.clock_timestamp() - interval '5 minutes'
  returning s.id into v_deleted_id;
  if v_deleted_id is null then
    return;
  end if;

  delete from public.assets a where a.id = any(v_asset_ids);
  return query select v_deleted_id, v_storage_keys;
end;
$$;

revoke all on function public.delete_abandoned_api_scene(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_abandoned_api_scene(uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 6. public.queue_scenes_if_within_caps — single-transaction lock, cap check & queue
-- -----------------------------------------------------------------------------
create or replace function public.queue_scenes_if_within_caps(
  p_project_id          uuid,
  p_expected_user_id    uuid,
  p_scene_ids           uuid[],
  p_scene_estimates_usd numeric[],
  p_prepare_token       uuid,
  p_api_token_id        uuid,
  p_dev                 boolean,
  p_override            jsonb,
  p_month_start_ts      timestamptz,
  p_day_start_ts        timestamptz,
  p_week_start_ts       timestamptz,
  p_hour_start_ts       timestamptz,
  p_now_ts              timestamptz,
  p_global_cap_enabled  boolean,
  p_global_cap_usd      numeric,
  p_global_cap_period   text,
  p_weekly_cap_usd      numeric,
  p_hourly_cap_usd      numeric,
  p_daily_cap_enabled   boolean,
  p_daily_cap_usd       numeric
)
returns table (
  outcome    text,
  blocked_by text,
  spent_usd  numeric,
  cap_usd    numeric
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner_id              uuid;
  v_locked_count          int;
  v_batch_estimate_usd    numeric := 0;
  v_token_monthly_cap_usd numeric;
  v_to_ts                 timestamptz;
  v_global_from_ts        timestamptz;
  v_in_flight_global      numeric;
  v_in_flight_owner       numeric;
  v_in_flight_token       numeric;
  v_spent                 numeric;
begin
  if p_project_id is null or p_expected_user_id is null then
    raise exception 'queue_scenes_if_within_caps: project_id and expected_user_id are required'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(pg_catalog.array_length(p_scene_ids, 1), 0) = 0
     or pg_catalog.array_length(p_scene_ids, 1) is distinct from pg_catalog.array_length(p_scene_estimates_usd, 1) then
    raise exception 'queue_scenes_if_within_caps: non-empty matching scene_ids and scene_estimates_usd required'
      using errcode = 'invalid_parameter_value';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(p_scene_estimates_usd) as e
    where e is null or e <= 0 or e = 'NaN'::numeric
  ) then
    raise exception 'queue_scenes_if_within_caps: every scene estimate must be finite and > 0'
      using errcode = 'invalid_parameter_value';
  end if;
  if (p_global_cap_enabled and (p_global_cap_usd is null or p_global_cap_usd < 0))
     or p_weekly_cap_usd is null or p_weekly_cap_usd < 0 then
    raise exception 'queue_scenes_if_within_caps: enabled global and weekly caps must be >= 0'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_global_cap_period is null or p_global_cap_period not in ('daily', 'weekly') then
    raise exception 'queue_scenes_if_within_caps: global cap period must be daily or weekly'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_hourly_cap_usd is not null and p_hourly_cap_usd < 0 then
    raise exception 'queue_scenes_if_within_caps: hourly cap must be >= 0'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_daily_cap_enabled and p_daily_cap_usd is null then
    raise exception 'queue_scenes_if_within_caps: daily cap is enabled but was not supplied'
      using errcode = 'invalid_parameter_value';
  end if;

  select coalesce(sum(e), 0) into v_batch_estimate_usd
  from pg_catalog.unnest(p_scene_estimates_usd) as e;

  -- LOCK ORDER: global first, owner second. ALWAYS.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('spend-cap:global')
  );

  select p.user_id into v_owner_id
  from public.projects p
  where p.id = p_project_id
  for update;

  if not found or v_owner_id is distinct from p_expected_user_id then
    raise exception 'queue_scenes_if_within_caps: project % not found for user %',
      p_project_id, p_expected_user_id
      using errcode = 'insufficient_privilege';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('spend-cap:owner:' || v_owner_id::text)
  );

  v_to_ts := greatest(p_now_ts, pg_catalog.clock_timestamp());

  if p_api_token_id is not null then
    select t.monthly_cap_usd into v_token_monthly_cap_usd
    from public.api_tokens t
    where t.id = p_api_token_id
      and t.user_id = v_owner_id
      and t.revoked_at is null
      and (t.expires_at is null or t.expires_at > v_to_ts);

    if not found then
      raise exception 'queue_scenes_if_within_caps: api_token % invalid, expired, or not owned by user %',
        p_api_token_id, v_owner_id
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  perform s.id
  from public.scenes s
  where s.id = any(p_scene_ids)
    and s.project_id = p_project_id
    and s.duration_s is not null
    and s.duration_s >= 3
  for update;
  get diagnostics v_locked_count = row_count;

  if v_locked_count <> pg_catalog.cardinality(p_scene_ids) then
    raise exception 'queue_scenes_if_within_caps: one or more scenes do not belong to project % or have invalid duration',
      p_project_id
      using errcode = 'invalid_parameter_value';
  end if;

  if exists (
    select 1
    from public.scene_references sr
    join public.assets a on a.id = sr.asset_id
    where sr.scene_id = any(p_scene_ids)
      and sr.kind = 'video'
      and (a.duration_s is null or a.duration_s <= 0)
  ) then
    raise exception 'queue_scenes_if_within_caps: video reference missing valid duration_s'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_prepare_token is not null then
    if exists (
      select 1 from public.scenes s
      where s.id = any(p_scene_ids)
        and (s.status <> 'frame_ready' or s.prepare_token is distinct from p_prepare_token)
    ) then
      return query select 'fenced'::text, null::text, null::numeric, null::numeric;
      return;
    end if;
  else
    if exists (
      select 1 from public.scenes s
      where s.id = any(p_scene_ids)
        and s.status in ('queued', 'rendering')
    ) then
      raise exception 'queue_scenes_if_within_caps: scene already queued or rendering'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  select coalesce(sum(s.estimated_cost_usd), 0) into v_in_flight_global
  from public.scenes s
  where s.status in ('queued', 'rendering')
    and s.dev = coalesce(p_dev, false)
    and not (s.id = any(p_scene_ids));

  select coalesce(sum(s.estimated_cost_usd), 0) into v_in_flight_owner
  from public.scenes s
  join public.projects p on p.id = s.project_id
  where s.status in ('queued', 'rendering')
    and s.dev = coalesce(p_dev, false)
    and p.user_id = v_owner_id
    and not (s.id = any(p_scene_ids));

  if p_global_cap_enabled then
    v_global_from_ts := case when p_global_cap_period = 'weekly' then p_week_start_ts else p_day_start_ts end;
    v_spent := public.spend_total_usd(v_global_from_ts, v_to_ts) + v_in_flight_global;
    if v_spent + v_batch_estimate_usd > p_global_cap_usd then
      return query select 'blocked'::text, 'global'::text, v_spent, p_global_cap_usd;
      return;
    end if;
  end if;

  v_spent := public.user_spend_usd(v_owner_id, p_week_start_ts, v_to_ts) + v_in_flight_owner;
  if v_spent + v_batch_estimate_usd > p_weekly_cap_usd then
    return query select 'blocked'::text, 'weekly'::text, v_spent, p_weekly_cap_usd;
    return;
  end if;

  if p_hourly_cap_usd is not null then
    v_spent := public.user_spend_usd(v_owner_id, coalesce(p_hour_start_ts, v_to_ts - interval '1 hour'), v_to_ts) + v_in_flight_owner;
    if v_spent + v_batch_estimate_usd > p_hourly_cap_usd then
      return query select 'blocked'::text, 'hourly'::text, v_spent, p_hourly_cap_usd;
      return;
    end if;
  end if;

  if p_daily_cap_enabled then
    v_spent := public.user_spend_usd(v_owner_id, p_day_start_ts, v_to_ts) + v_in_flight_owner;
    if v_spent + v_batch_estimate_usd > p_daily_cap_usd then
      return query select 'blocked'::text, 'daily'::text, v_spent, p_daily_cap_usd;
      return;
    end if;
  end if;

  if p_api_token_id is not null and v_token_monthly_cap_usd is not null then
    select coalesce(sum(s.estimated_cost_usd), 0) into v_in_flight_token
    from public.scenes s
    where s.status in ('queued', 'rendering')
      and s.dev = coalesce(p_dev, false)
      and s.api_token_id = p_api_token_id
      and not (s.id = any(p_scene_ids));

    select coalesce(sum(r.cost_usd), 0) + v_in_flight_token into v_spent
    from public.runs r
    left join public.scenes s on s.id = r.scene_id
    where coalesce(r.api_token_id, s.api_token_id) = p_api_token_id
      and r.cost_usd is not null
      and r.created_at >= p_month_start_ts
      and r.created_at <= v_to_ts;

    if v_spent + v_batch_estimate_usd > v_token_monthly_cap_usd then
      return query select 'blocked'::text, 'token_monthly'::text, v_spent, v_token_monthly_cap_usd;
      return;
    end if;
  end if;

  update public.scenes s
  set status = 'queued',
      dev = coalesce(p_dev, false),
      estimated_cost_usd = u.estimate_usd,
      api_token_id = coalesce(p_api_token_id, s.api_token_id),
      prepare_token = null,
      prepare_started_at = null,
      kie_task_id = null,
      submitted_at = null,
      render_settings_override = coalesce(p_override, s.render_settings_override)
  from pg_catalog.unnest(p_scene_ids, p_scene_estimates_usd) as u(scene_id, estimate_usd)
  where s.id = u.scene_id
    and s.project_id = p_project_id;

  update public.projects
  set status = 'rendering',
      updated_at = v_to_ts
  where id = p_project_id;

  return query select 'queued'::text, null::text, null::numeric, null::numeric;
end;
$$;

revoke all on function public.queue_scenes_if_within_caps(
  uuid, uuid, uuid[], numeric[], uuid, uuid, boolean, jsonb,
  timestamptz, timestamptz, timestamptz, timestamptz, timestamptz,
  boolean, numeric, text, numeric, numeric, boolean, numeric
) from public, anon, authenticated;

grant execute on function public.queue_scenes_if_within_caps(
  uuid, uuid, uuid[], numeric[], uuid, uuid, boolean, jsonb,
  timestamptz, timestamptz, timestamptz, timestamptz, timestamptz,
  boolean, numeric, text, numeric, numeric, boolean, numeric
) to service_role;

-- -----------------------------------------------------------------------------
-- 7. Unify reserve_image_attempt advisory lock keys with queue_scenes_if_within_caps
-- -----------------------------------------------------------------------------
create or replace function public.reserve_image_attempt(
  p_project_id         uuid,
  p_user_id            uuid,
  p_idempotency_key    text,
  p_estimate_usd       numeric,
  p_model              text,
  p_day_start_ts       timestamptz,
  p_week_start_ts      timestamptz,
  p_now_ts             timestamptz,
  p_global_cap_usd     numeric,
  p_global_cap_enabled boolean,
  p_global_cap_period  text,
  p_weekly_cap_usd     numeric,
  p_daily_cap_usd      numeric,
  p_daily_cap_enabled  boolean,
  p_hourly_cap_usd     numeric
)
returns table (
  outcome    text,
  run_id     uuid,
  blocked_by text,
  spent_usd  numeric
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner_id     uuid;
  v_existing_id  uuid;
  v_to_ts        timestamptz;
  v_spent        numeric;
  v_global_start timestamptz;
  v_new_id       uuid;
begin
  if p_project_id is null and p_user_id is null then
    raise exception 'reserve_image_attempt: one of project_id or user_id is required'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_idempotency_key is null or p_idempotency_key = '' then
    raise exception 'reserve_image_attempt: idempotency_key is required'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_estimate_usd is null or p_estimate_usd < 0 then
    raise exception 'reserve_image_attempt: estimate_usd must be >= 0, got %', p_estimate_usd
      using errcode = 'invalid_parameter_value';
  end if;
  if (p_global_cap_enabled and (p_global_cap_usd is null or p_global_cap_usd < 0)) or
     p_weekly_cap_usd is null or p_weekly_cap_usd < 0 then
    raise exception 'reserve_image_attempt: enabled global and weekly caps must be >= 0'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_global_cap_period is null or p_global_cap_period not in ('daily', 'weekly') then
    raise exception 'reserve_image_attempt: global cap period must be daily or weekly'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_hourly_cap_usd is not null and p_hourly_cap_usd < 0 then
    raise exception 'reserve_image_attempt: hourly cap must be >= 0'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_daily_cap_enabled and p_daily_cap_usd is null then
    raise exception 'reserve_image_attempt: daily cap is enabled but was not supplied'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Unified lock key shared with queue_scenes_if_within_caps.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('spend-cap:global')
  );

  if p_project_id is not null then
    select p.user_id into v_owner_id
    from public.projects p
    where p.id = p_project_id
    for update;

    if not found then
      raise exception 'reserve_image_attempt: project % not found', p_project_id
        using errcode = 'no_data_found';
    end if;
  else
    select p.id into v_owner_id
    from public.profiles p
    where p.id = p_user_id;

    if not found then
      raise exception 'reserve_image_attempt: user % not found', p_user_id
        using errcode = 'no_data_found';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('spend-cap:owner:' || v_owner_id::text)
  );

  if p_project_id is not null then
    select r.id into v_existing_id
    from public.runs r
    where r.project_id = p_project_id
      and r.idempotency_key = p_idempotency_key
    limit 1;
  else
    select r.id into v_existing_id
    from public.runs r
    where r.project_id is null
      and r.user_id = v_owner_id
      and r.idempotency_key = p_idempotency_key
    limit 1;
  end if;

  if found then
    return query select 'duplicate'::text, v_existing_id, null::text, null::numeric;
    return;
  end if;

  v_to_ts := greatest(p_now_ts, pg_catalog.clock_timestamp());

  if p_global_cap_enabled then
    v_global_start := case when p_global_cap_period = 'weekly' then p_week_start_ts else p_day_start_ts end;
    v_spent := public.spend_total_usd(v_global_start, v_to_ts);
    if v_spent + p_estimate_usd > p_global_cap_usd then
      return query select 'blocked'::text, null::uuid, 'global'::text, v_spent;
      return;
    end if;
  end if;

  v_spent := public.user_spend_usd(v_owner_id, p_week_start_ts, v_to_ts);
  if v_spent + p_estimate_usd > p_weekly_cap_usd then
    return query select 'blocked'::text, null::uuid, 'weekly'::text, v_spent;
    return;
  end if;

  if p_hourly_cap_usd is not null then
    v_spent := public.user_spend_usd(v_owner_id, v_to_ts - interval '1 hour', v_to_ts);
    if v_spent + p_estimate_usd > p_hourly_cap_usd then
      return query select 'blocked'::text, null::uuid, 'hourly'::text, v_spent;
      return;
    end if;
  end if;

  if p_daily_cap_enabled then
    v_spent := public.user_spend_usd(v_owner_id, p_day_start_ts, v_to_ts);
    if v_spent + p_estimate_usd > p_daily_cap_usd then
      return query select 'blocked'::text, null::uuid, 'daily'::text, v_spent;
      return;
    end if;
  end if;

  insert into public.runs (
    project_id, user_id, vendor, model, cost_usd, idempotency_key, settled_at
  )
  values (
    p_project_id, v_owner_id, 'kie', p_model, p_estimate_usd, p_idempotency_key, null
  )
  returning id into v_new_id;

  return query select 'reserved'::text, v_new_id, null::text, null::numeric;
end;
$$;

revoke all on function public.reserve_image_attempt(
  uuid, uuid, text, numeric, text, timestamptz, timestamptz, timestamptz,
  numeric, boolean, text, numeric, numeric, boolean, numeric
) from public, anon, authenticated;

grant execute on function public.reserve_image_attempt(
  uuid, uuid, text, numeric, text, timestamptz, timestamptz, timestamptz,
  numeric, boolean, text, numeric, numeric, boolean, numeric
) to service_role;
