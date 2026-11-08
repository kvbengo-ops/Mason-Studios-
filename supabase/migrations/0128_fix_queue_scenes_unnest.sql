-- 0128_fix_queue_scenes_unnest.sql
-- 0127's queue_scenes_if_within_caps called pg_catalog.unnest(a, b). Multi-array
-- unnest is FROM-clause syntax that Postgres only recognizes UNQUALIFIED, so the
-- qualified call failed at runtime ("function pg_catalog.unnest(uuid[], numeric[])
-- does not exist") and every queue through it errored. ROWS FROM keeps the
-- schema-qualified calls that `search_path = ''` wants. Same signature, so
-- CREATE OR REPLACE keeps 0127's revoke/grant.

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
  from rows from (pg_catalog.unnest(p_scene_ids), pg_catalog.unnest(p_scene_estimates_usd)) as u(scene_id, estimate_usd)
  where s.id = u.scene_id
    and s.project_id = p_project_id;

  update public.projects
  set status = 'rendering',
      updated_at = v_to_ts
  where id = p_project_id;

  return query select 'queued'::text, null::text, null::numeric, null::numeric;
end;
$$;
