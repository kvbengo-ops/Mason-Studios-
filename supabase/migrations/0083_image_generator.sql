-- =============================================================================
-- Image Generator: the atomic reservation that precedes every paid image call.
-- =============================================================================
--
-- See docs/image-generation-route-plan.md. The short version of why a Postgres
-- function exists at all, rather than app code:
--
-- Inserting a `runs` row and THEN calling assertWithinSpendCaps is not atomic
-- and double-counts. Two requests interleave between the insert and the check,
-- and the check adds this request's own estimate to a sum that already contains
-- that same reservation -- refusing at half the real headroom. Both halves have
-- to happen under one lock, in one transaction, and PostgREST commits each
-- request before the ~22s kie call begins, so the app cannot hold that lock.
--
-- Nothing here participates in video rendering or /ugc. Those paths keep using
-- assertWithinSpendCaps and are untouched.

-- -----------------------------------------------------------------------------
-- 1. assets.kind gains 'generated_image'
-- -----------------------------------------------------------------------------
--
-- Drop-and-recreate, the way 0022 added 'poster' and 0081 widened the element
-- categories. This widens; it does not narrow, so no existing row changes.
--
-- Deliberately NOT reusing 'character_ref' / 'product_ref' / 'ref_frame':
-- loadConditioningRefs (web/lib/frames.ts:100-115) reads 'character_ref', so
-- reusing it would silently change what the /ugc wizard conditions its renders
-- on. A generated image is a standalone artifact a human downloads; it is not a
-- conditioning frame until a human decides it is.

alter table assets drop constraint if exists assets_kind_check;
alter table assets
  add constraint assets_kind_check
  check (kind in ('character_ref', 'product_ref', 'composite_ref', 'ref_frame',
                  'clip', 'final', 'poster', 'audio', 'generated_image'));

comment on constraint assets_kind_check on assets is
  'Our own product vocabulary, not a vendor enum -- see 0017_composite_asset.sql for why a CHECK '
  'here is the right layer. generated_image added in 0083: a standalone image from the Image '
  'Generator, downloaded by a human. It is NOT a conditioning reference -- loadConditioningRefs '
  'reads character_ref and must never read this kind.';

-- -----------------------------------------------------------------------------
-- 2. runs gains the two columns the attempt lifecycle needs
-- -----------------------------------------------------------------------------
--
-- `runs` is already the per-attempt ledger AGENTS.md describes and already what
-- the caps sum, so it is extended rather than shadowed by a second reservation
-- table that would have to be kept in agreement with it. It already carries
-- kie_task_id (0050, renamed by 0070).
--
-- Both columns are nullable so every existing writer keeps working untouched.

alter table runs add column if not exists idempotency_key text;
alter table runs add column if not exists settled_at timestamptz;

comment on column runs.idempotency_key is
  'Client-generated, one per Generate press, unique per project. A retried POST or a second tab '
  'reusing the key resolves to the existing attempt instead of charging twice. NULL for every '
  'writer that predates 0083 and for every path that is not the Image Generator.';

comment on column runs.settled_at is
  'NULL means the attempt is still in flight and its cost_usd is an ESTIMATE that already counts '
  'against every cap -- conservative by construction, so a crash over-reports rather than losing '
  'a charge. Set once the outcome is known, whether that outcome is a real cost, a release, or '
  'billing-unknown. DEFAULTS to now(): every writer other than the Image Generator records a run '
  'AFTER its outcome is known, so a row that does not mention this column is settled by '
  'definition. Only reserve_image_attempt inserts NULL here, explicitly.';

-- Partial, so the ~all existing rows carrying NULL are untouched and unindexed.
-- Scoped to the project rather than global: it matches how the key is used and
-- keeps one project's keys out of another's namespace.
create unique index if not exists runs_project_idempotency_key_uniq
  on runs (project_id, idempotency_key)
  where idempotency_key is not null;

-- Every historical row is settled by definition -- it was written after its
-- outcome was known, by a path that had no concept of a reservation. Without
-- this backfill the stale-reservation sweep would see the entire table as
-- in flight and rewrite years of history as billing-unknown.
--
-- ORDER MATTERS: the column is added WITHOUT a default, backfilled to each
-- row's own created_at, and only THEN given the default. Adding it with the
-- default already attached would stamp every historical row with the moment
-- this migration ran -- claiming a run from months ago settled today -- and
-- leave the backfill below matching nothing, since no row would still be NULL.
update runs set settled_at = created_at where settled_at is null;

-- Every OTHER writer records a run after the outcome is known: recordRun
-- (web/lib/runs.ts) and the worker's three inserts (worker/internal/store/
-- store.go:491, :578, :1348) all write a finished attempt, and none of them
-- mentions this column. Without a default they would each start writing NULL
-- -- "in flight" by this column's own definition -- and a sweep would later
-- rewrite honest, settled costs as billing-unknown.
--
-- Defaulting here fixes both services at once and needs no Go change. The one
-- writer that means NULL, reserve_image_attempt below, says so explicitly.
alter table runs alter column settled_at set default now();

-- -----------------------------------------------------------------------------
-- 3. reserve_image_attempt: ceilings and reservation in one transaction
-- -----------------------------------------------------------------------------
--
-- Returns exactly one of 'reserved' / 'duplicate' / 'blocked'. Only 'reserved'
-- writes a row.
--
-- security definer + search_path = '' with every object fully qualified, so no
-- caller-controlled search_path can resolve `runs` or `projects` to something
-- else. Note the existing spend functions set their own search_path to 'public'
-- and so resolve their own unqualified tables correctly when called from here.

create or replace function public.reserve_image_attempt(
  p_project_id            uuid,
  p_idempotency_key       text,
  p_estimate_usd          numeric,
  p_model                 text,
  p_day_start_ts          timestamptz,
  p_week_start_ts         timestamptz,
  p_now_ts                timestamptz,
  p_global_daily_cap_usd  numeric,
  p_weekly_cap_usd        numeric,
  p_daily_cap_usd         numeric,
  p_daily_cap_enabled     boolean
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
  v_new_id       uuid;
begin
  -- Trust boundary. This function is service_role-only and the Server Action is
  -- its only caller, but it is the last thing standing between a bad argument
  -- and a charge, so it validates rather than assuming.
  --
  -- A NULL cap is the dangerous one: `spent + estimate > NULL` is NULL, which is
  -- not true, so a forgotten env var would silently disable a ceiling instead of
  -- failing. A negative estimate would manufacture headroom the same way.
  if p_idempotency_key is null or p_idempotency_key = '' then
    raise exception 'reserve_image_attempt: idempotency_key is required'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_estimate_usd is null or p_estimate_usd < 0 then
    raise exception 'reserve_image_attempt: estimate_usd must be >= 0, got %', p_estimate_usd
      using errcode = 'invalid_parameter_value';
  end if;
  if p_global_daily_cap_usd is null or p_weekly_cap_usd is null then
    raise exception 'reserve_image_attempt: global and weekly caps are required'
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

  -- The owner is derived from the LOCKED project row, never passed in: a caller
  -- must not be able to name whose budget is spent. requireProject has already
  -- checked ownership in the app; this is the seam that does not depend on it.
  select p.user_id into v_owner_id
  from public.projects p
  where p.id = p_project_id
  for update;

  if not found then
    raise exception 'reserve_image_attempt: project % not found', p_project_id
      using errcode = 'no_data_found';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('image-generator:owner:' || v_owner_id::text)
  );

  -- Idempotency is checked BEFORE the ceilings, so a retry of an attempt that
  -- already exists is never refused by a cap it already passed.
  select r.id into v_existing_id
  from public.runs r
  where r.project_id = p_project_id
    and r.idempotency_key = p_idempotency_key
  limit 1;

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
  -- Same rule sidebar_budget_snapshot follows: call them, never reimplement them.
  --
  -- Ceilings are compared with `>`, not `>=`, and the reads happen before the
  -- insert. An account with room for exactly one image therefore gets it:
  -- spent + estimate = cap is not over the cap. This is the double-count bug
  -- this whole function exists to avoid, reduced to one operator.
  --
  -- Checked global -> weekly -> daily, and the FIRST breach is what blocked_by
  -- names. Order matters for the message, not the outcome: reporting a personal
  -- weekly cap when it is the company-wide budget that is exhausted would send
  -- someone to request an allowance that cannot help them.
  v_spent := public.spend_total_usd(p_day_start_ts, v_to_ts);
  if v_spent + p_estimate_usd > p_global_daily_cap_usd then
    return query select 'blocked'::text, null::uuid, 'global_daily'::text, v_spent;
    return;
  end if;

  v_spent := public.user_spend_usd(v_owner_id, p_week_start_ts, v_to_ts);
  if v_spent + p_estimate_usd > p_weekly_cap_usd then
    return query select 'blocked'::text, null::uuid, 'weekly'::text, v_spent;
    return;
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
  insert into public.runs (project_id, vendor, model, cost_usd, idempotency_key, settled_at)
  values (p_project_id, 'kie', p_model, p_estimate_usd, p_idempotency_key, null)
  returning id into v_new_id;

  return query select 'reserved'::text, v_new_id, null::text, null::numeric;
end;
$$;

comment on function public.reserve_image_attempt(
  uuid, text, numeric, text, timestamptz, timestamptz, timestamptz,
  numeric, numeric, numeric, boolean
) is
  'Checks the global, weekly and optional daily ceilings and creates the reservation in ONE '
  'transaction, under a global-then-owner advisory lock. Returns exactly one of reserved / '
  'duplicate / blocked; only reserved writes a row. spent_usd is the spend measured against the '
  'ceiling named by blocked_by, and NULL otherwise. The owner is derived from the locked project '
  'row -- there is deliberately no owner parameter. Callers must NOT also call '
  'assertWithinSpendCaps: that would count the reservation twice.';

-- -----------------------------------------------------------------------------
-- 4. Lock the function down. The default is wide open.
-- -----------------------------------------------------------------------------
--
-- 0007_grants.sql grants execute on all functions in schema public to
-- `authenticated` AND sets the same as a DEFAULT PRIVILEGE for functions created
-- later -- which is this one. Without the revoke below, any signed-in browser
-- client could call this directly and spend money against a project it was
-- refused through the app.
--
-- Service-role-only is how the app actually reaches it: every mutation goes
-- through createAdminClient(), which uses SUPABASE_SERVICE_ROLE_KEY
-- (web/lib/supabase/server.ts:82). The Server Action is the only caller.
--
-- If a future change makes service-role-only impossible, the fallback is the
-- pattern 0032_allowance_requests.sql:266 already uses: re-validate inside the
-- definer function by checking auth.uid() against the owner derived from the
-- locked project row, and raise otherwise.

revoke execute on function public.reserve_image_attempt(
  uuid, text, numeric, text, timestamptz, timestamptz, timestamptz,
  numeric, numeric, numeric, boolean
) from public, anon, authenticated;

grant execute on function public.reserve_image_attempt(
  uuid, text, numeric, text, timestamptz, timestamptz, timestamptz,
  numeric, numeric, numeric, boolean
) to service_role;
