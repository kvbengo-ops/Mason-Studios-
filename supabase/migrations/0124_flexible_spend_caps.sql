-- Move the team cap into editable settings and enforce an optional rolling-hour account cap.
alter table public.app_settings
  add column global_spend_cap_enabled boolean not null default true,
  add column global_spend_cap_usd numeric not null default 100 check (global_spend_cap_usd >= 0),
  add column global_spend_cap_period text not null default 'daily'
    check (global_spend_cap_period in ('daily', 'weekly'));

alter table public.profiles
  add column hourly_cap_override_usd numeric check (hourly_cap_override_usd is null or hourly_cap_override_usd >= 0);
-- The prior signature is DROPPED rather than left beside this
-- one. An overload set where the two differ only by a trailing parameter is
-- how a caller that forgets the new argument silently keeps the old behaviour;
-- there is one caller (lib/runs.ts's reserveImageAttempt) and it moves with
-- this file.
drop function if exists public.reserve_image_attempt(
  uuid, uuid, text, numeric, text, timestamptz, timestamptz, timestamptz,
  numeric, numeric, numeric, boolean
);

create or replace function public.reserve_image_attempt(
  p_project_id            uuid,
  p_user_id               uuid,
  p_idempotency_key       text,
  p_estimate_usd          numeric,
  p_model                 text,
  p_day_start_ts          timestamptz,
  p_week_start_ts         timestamptz,
  p_now_ts                timestamptz,
  p_global_cap_usd       numeric,
  p_global_cap_enabled    boolean,
  p_global_cap_period     text,
  p_weekly_cap_usd        numeric,
  p_daily_cap_usd         numeric,
  p_daily_cap_enabled     boolean,
  p_hourly_cap_usd        numeric
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
  -- Trust boundary. This function is service_role-only and the Server Action is
  -- its only caller, but it is the last thing standing between a bad argument
  -- and a charge, so it validates rather than assuming.
  --
  -- A NULL cap is the dangerous one: `spent + estimate > NULL` is NULL, which is
  -- not true, so a forgotten env var would silently disable a ceiling instead of
  -- failing. A negative estimate would manufacture headroom the same way.
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

  -- LOCK ORDER: global first, owner second. ALWAYS. Two callers taking these in
  -- opposite orders deadlock, and the only thing preventing that is that this is
  -- the single place either lock is taken.
  --
  -- The global lock is what makes the company-wide daily cap safe against two
  -- DIFFERENT accounts arriving together with room for one -- a per-owner lock
  -- would let both through. Held for this function only, never across the kie
  -- call.
  --
  -- Scope, stated honestly: this coordinates only paths that take the same lock,
  -- and no other paid path in this repository takes any advisory lock. Image vs
  -- image is now impossible; image vs a simultaneous video render still races
  -- exactly as it does today.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('image-generator:global-daily')
  );

  if p_project_id is not null then
    -- The owner is derived from the LOCKED project row, never passed in: a
    -- caller must not be able to name whose budget is spent. requireProject
    -- has already checked ownership in the app; this is the seam that does
    -- not depend on it.
    select p.user_id into v_owner_id
    from public.projects p
    where p.id = p_project_id
    for update;

    if not found then
      raise exception 'reserve_image_attempt: project % not found', p_project_id
        using errcode = 'no_data_found';
    end if;
  else
    -- No project, so nothing to derive from and nothing to lock. The owner is
    -- the caller's argument, established by requireUser() in the Server
    -- Action; see this section's header for why that is acceptable here and
    -- was not for the project case.
    --
    -- Still verified to EXIST: a typo'd or deleted owner would otherwise
    -- reserve, generate, charge, and only fail on the runs insert's foreign
    -- key -- after the money was gone.
    select p.id into v_owner_id
    from public.profiles p
    where p.id = p_user_id;

    if not found then
      raise exception 'reserve_image_attempt: user % not found', p_user_id
        using errcode = 'no_data_found';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('image-generator:owner:' || v_owner_id::text)
  );

  -- Idempotency is checked BEFORE the ceilings, so a retry of an attempt that
  -- already exists is never refused by a cap it already passed.
  --
  -- Two namespaces, matching the two unique indexes (0085 section 1): a
  -- project's keys, or an owner's project-less keys. Each branch tests only
  -- the columns its own index constrains, and the project-less branch states
  -- `project_id is null` explicitly -- without it, an owner who reused a key
  -- across a project image and a personal one would resolve the second to the
  -- first and be told it already completed.
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

  -- THE UPPER BOUND OF EVERY SPEND READ, and why it is not simply p_now_ts.
  --
  -- p_now_ts is computed in TypeScript when the request starts -- which is
  -- BEFORE this transaction blocks on the lock above. Consider two requests
  -- racing for the last of a cap: A takes the lock, inserts its reservation with
  -- created_at = now(), and commits. B then acquires the lock and reads with
  -- to_ts = its own p_now_ts, computed before any of that happened. A's row is
  -- newer than that bound, so B does not see it, and both reserve. The lock
  -- would have serialized them correctly and the timestamps would have thrown
  -- it away.
  --
  -- clock_timestamp() is evaluated here, after the lock is held, so it is always
  -- later than the commit of any transaction that queued ahead of this one.
  -- greatest() keeps the caller's value when it is further ahead, so a caller
  -- asking about a wider window still gets one.
  -- greatest() is a SQL construct, not a schema-qualifiable function, and is
  -- unaffected by search_path.
  v_to_ts := greatest(p_now_ts, pg_catalog.clock_timestamp());

  -- Spend comes from the canonical functions, never from re-summing public.runs.
  -- Since 0040 both union in deleted_project_cost_history, and a re-sum would
  -- under-count anyone who has deleted a project -- letting them past their cap.
  -- Since 0085 user_spend_usd also counts project-less runs against their owner,
  -- which is what makes the reservation this function is about to write visible
  -- to the NEXT one. Same rule sidebar_budget_snapshot follows: call them, never
  -- reimplement them.
  --
  -- Ceilings are compared with `>`, not `>=`, and the reads happen before the
  -- insert. An account with room for exactly one image therefore gets it:
  -- spent + estimate = cap is not over the cap. This is the double-count bug
  -- this whole function exists to avoid, reduced to one operator.
  --
  -- Checked global -> weekly -> hourly -> daily, and the FIRST breach is what blocked_by
  -- names. Order matters for the message, not the outcome: reporting a personal
  -- weekly cap when it is the company-wide budget that is exhausted would send
  -- someone to request an allowance that cannot help them.
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

  -- Reserved: cost_usd is the ESTIMATE and settled_at is NULL, so this attempt
  -- counts against every cap from now until it settles. vendor is 'kie' because
  -- that is the only vendor this path has (web/lib/kie.ts:132 types it as the
  -- literal). created_at takes the column default rather than p_now_ts, so the
  -- row is stamped when it is actually written -- see the v_to_ts note above for
  -- why a caller-supplied time must not decide what counts.
  -- settled_at is passed explicitly as NULL against the column default of
  -- now(): this is the one writer in either service that means "not settled".
  --
  -- user_id is written on BOTH branches, not only the project-less one. On the
  -- project branch it is the same answer projects.user_id already gives, so it
  -- changes no aggregate (coalesce prefers it and they agree) -- and it is what
  -- keeps the attempt attributed if that project is later deleted mid-flight,
  -- when the row's project_id cascades away before the sweep can settle it.
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

comment on function public.reserve_image_attempt(
  uuid, uuid, text, numeric, text, timestamptz, timestamptz, timestamptz,
  numeric, boolean, text, numeric, numeric, boolean, numeric
) is
  'Checks the optional global, weekly, optional hourly and optional daily ceilings and creates '
  'the reservation in ONE transaction, under a global-then-owner advisory lock. Returns exactly '
  'one of reserved / duplicate / blocked; only reserved writes a row. spent_usd is the spend '
  'ceiling named by blocked_by, and NULL otherwise. Exactly one of p_project_id / p_user_id '
  'identifies the attempt: with a project the owner is derived from the LOCKED project row and '
  'p_user_id is ignored (0083''s rule, unchanged); without one the owner is p_user_id, established '
  'by requireUser() in the Server Action, and idempotency is looked up in that owner''s '
  'project-less namespace instead (0085). Callers must NOT also call assertWithinSpendCaps: that '
  'would count the reservation twice.';

-- =============================================================================
-- 6. Lock the new signature down. The default is wide open.
-- =============================================================================
-- 0007_grants.sql grants execute on all functions in schema public to
-- `authenticated` AND sets the same as a DEFAULT PRIVILEGE for functions created
-- later -- which includes this one, newly created under a new signature. The
-- revoke from 0083 applied to the old function signature and does not
-- carry over; without repeating it here, any signed-in browser client could
-- call this directly and spend money against an account it is not.
revoke execute on function public.reserve_image_attempt(
  uuid, uuid, text, numeric, text, timestamptz, timestamptz, timestamptz,
  numeric, boolean, text, numeric, numeric, boolean, numeric
) from public, anon, authenticated;

grant execute on function public.reserve_image_attempt(
  uuid, uuid, text, numeric, text, timestamptz, timestamptz, timestamptz,
  numeric, boolean, text, numeric, numeric, boolean, numeric
) to service_role;
