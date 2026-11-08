# Personal API Token & REST Endpoints — Reassessed Implementation Plan

**Target Document:** `docs/personal-api-token-plan.md`  
**Requester Brief:** Ced Cantong — *"# A personal API token for Ced on the platform"* (7 Nov 2026)  
**Scope:** Personal API tokens (`ms_live_...`) + versioned REST endpoints (`/api/v1/*`) that wrap the platform's existing generation, pricing, spend-cap, and Elements Library logic. Ced builds his own script or MCP server against these endpoints.

---

## 1. Architecture Verification & Code Evidence

Every claim below has been verified against the repository on `main`:

### 1.1 Authentication, Proxy & Rate Limiting
- **Request proxy (`web/proxy.ts`):** Next.js 16 uses [`proxy.ts`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/proxy.ts#L1-L29), which delegates to [`updateSession`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/supabase/middleware.ts#L9-L51). `updateSession` checks Supabase session cookies and redirects unauthenticated requests to `/login` unless `pathname` is matched by `isPublicPath()` (`middleware.ts:11-22`). Currently only `/login`, `/auth/*`, `/unauthorized`, and `/api/health` bypass cookie redirects; `/api/v1/*` **must** be added to `isPublicPath()` so Bearer-authenticated requests reach the route handlers instead of receiving a `307` redirect to `/login`.
- **Server Action guards (`web/actions/guard.ts`):** [`requireUser()`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/guard.ts#L92-L127) reads the cookie session, enforces [`withinActionLimit(user.id)`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/guard.ts#L41-L49), fetches `profiles(role, status)`, and checks [`canUseApp(profile)`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/account-approval.ts#L14-L16) (`profile.role === "admin" || profile.status === "active"`).
- **Rate limiter subtlety (`web/lib/action-rate-limit.ts`):** [`takeActionSlot(userId)`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/action-rate-limit.ts#L7-L26) enforces `ACTION_LIMIT_PER_MINUTE = 60` in a 60-second rolling in-memory window. However, `withinActionLimit` in [`guard.ts:41-49`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/guard.ts#L41-L49) only consumes a slot when the request carries a `next-action` header. REST Route Handlers do not carry `next-action`, so `/api/v1/*` must call rate-limit helpers directly (see Section 7.2).

### 1.2 Existing Route Handlers under `web/app/api/`
Only 5 Route Handlers currently exist:
1. [`web/app/api/health/route.ts`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/app/api/health/route.ts) — DB connectivity + `schemaDrift` check against `EXPECTED_DB_VERSION`.
2. [`web/app/api/issue-image/[file]/route.ts`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/app/api/issue-image/[file]/route.ts) — issue-report attachment reader.
3. [`web/app/api/accounts-control/runs-csv/route.ts`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/app/api/accounts-control/runs-csv/route.ts) — admin CSV export.
4. [`web/app/api/projects/[id]/archive/route.ts`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/app/api/projects/[id]/archive/route.ts) — ZIP archive download.
5. [`web/app/api/projects/[id]/brief-csv/route.ts`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/app/api/projects/[id]/brief-csv/route.ts) — project brief CSV export.

None of these expose `/ugc` clip generation, quoting, or element creation.

### 1.3 Generation Flow, Queue Contract & Worker Behavior
- **State machine (`AGENTS.md`, `web/actions/ugc.ts`, `worker/internal/loop/dispatch.go`):**
  - `web/` owns `draft -> frame_ready -> queued`.
  - `worker/` owns `queued -> rendering -> done | failed`.
- **How `/ugc` creates a clip today ([`createUgcClip` in `web/actions/ugc.ts:1833-2189`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/ugc.ts#L1833-L2189)):**
  1. Validates model, resolution, duration, aspect ratio, prompt length, and Kling constraints (`ugc.ts:1864-1955`).
  2. Resolves `@tags` against the caller's owned `elements` (`resolveElementTags`, `ugc.ts:468-523, 1986-2009`), measures video reference durations (`videoReferenceDurationsForTags`, `ugc.ts:154-205, 2011-2023`), and checks spend caps (`assertWithinSpendCaps`, `ugc.ts:1855, 2015-2022`).
  3. Inserts a `scenes` row at `status = "frame_ready"` (`ugc.ts:2061-2078`).
  4. Copies referenced element assets into `projects/<projectId>/<kind>/<uuid>.<ext>` and inserts `scene_references` rows with 1-based `ordinal` per `kind` (`attachSceneReferences`, `ugc.ts:1203-1413, 2117`).
  5. Updates `scenes.status = "queued"` (`ugc.ts:2123-2126`).
- **How the Go worker processes queued scenes ([`worker/internal/loop/dispatch.go:93-436`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/worker/internal/loop/dispatch.go#L93-L436)):**
  1. `ClaimQueuedScenes` claims rows where `status = 'queued'` and `dev = (MODE == "development")`, flipping them to `status = 'rendering'`.
  2. Reads `scenes.render_settings_override` merged over `projects.render_settings` (`dispatch.go:257`).
  3. Loads `scene_references` ordered by `(kind, ordinal)` (`ReferencesForScene`, `dispatch.go:321-347`) and signs 1-hour URLs from the `media` bucket (`dispatch.go:25, 333`).
  4. Routes `seedance-2.5-byteplus` (or `seedance-2.5` when `BYTEPLUS_DIRECT=true`, `dispatch.go:265-270`) to BytePlus Ark (`submitBytePlusScene`, `dispatch.go:955-1084`) and all other models to Kie (`dispatch.go:303-435`).
  5. On completion/failure, downloads the output MP4 into `projects/<projectId>/scenes/<sceneId>/...`, inserts a `video` row in `assets`, inserts a billing row in `runs`, and sets `scenes.status = 'done' | 'failed'` in one transaction (`MarkDone` / `MarkFailed`).
- **Does "zero worker changes" hold?**
  - **Yes**, provided `web/` writes `scenes.video_prompt` using valid `@<tag>` identifiers and populates `scene_references` with explicit array-based ordinals before setting `status = 'queued'` (proven in Section 5). The Go worker does not need to know whether a scene was queued by a browser Server Action or by `/api/v1/generate`.

### 1.4 Model Limits
- **Frontend catalog ([`web/lib/kie/models.ts:149-168`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/kie/models.ts#L149-L168)) & Worker catalog ([`worker/internal/kie/models.go:718-749`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/worker/internal/kie/models.go#L718-L749)):**
  - `seedance-2.5` (`bytedance/seedance-2.5`) and `seedance-2.5-byteplus` (`seedance-2-0-260328`):
    - **Durations:** `seconds(4, 30)` — any integer from **4 to 30 seconds** (`duration: 17` in Ced's brief is valid).
    - **Resolutions:** `["480p", "720p", "1080p"]`.
    - **Aspect ratios:** `["9:16", "16:9", "1:1"]`.
    - **Prompt length:** [`MAX_PROMPT_LEN = 5000`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/ugc.ts#L43) at the action boundary.
    - **Reference limits:** Up to [`MAX_REFERENCES = 10`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/ugc-references.ts#L45) total references across image, video, and audio (`supportsReferences: true`, `supportsVideoReferences: true`, `supportsAudioReferences: true`).
  - **Other offerable models in [`models.ts`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/kie/models.ts):**
    - `seedance-2-fast` / `seedance-2`: `4..15s`, `480p`/`720p`, up to 10 refs (image/video/audio).
    - `seedance-2-mini`: `4..15s`, `480p`/`720p`, up to 9 image refs (`maxImageReferences: 9`), video/audio supported.
    - `kling-3.0-pro`: `3..15s`, `720p`/`1080p` (UI labels `720p` as `"480p"` via `ugc-tier-label.ts`), `maxPromptChars: 2500`, start+end PNG/JPG frames only (max 2 images, no `@tags` per `klingTagRefusal`).
    - `kling-4.0` / `kling-4.0-reference`: `3..30s`, `720p`/`1080p`, `maxPromptChars: 8000`, images only (`maxImageReferences: 2` / `7`).
    - `wan-3.0`: `4..30s`, `480P`/`720P`/`1080P`, `maxPromptChars: 5000`.
    - `hailuo-2.3-pro`: `[6, 10]s`, `768P`, `maxPromptChars: 5000`.

### 1.5 Storage Bucket, Retention, Signed URL Expiry & Next Migration Number
- **Storage bucket:** [`MEDIA_BUCKET = "media"`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/storage.ts#L22) (not `"assets"`).
- **Retention:** Active `scenes`, `assets`, and `elements` have **no automatic TTL**. Soft-deleted items in `/bin` (`deleted_at IS NOT NULL`) are retained for [`BIN_RETENTION_DAYS = 14`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/bin-thumbnails.ts#L129-L130) before purge.
- **Signed URL expiry & cache interaction:** [`signedUrl()` in `web/lib/storage.ts:644-708`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/storage.ts#L644-L708) signs URLs with [`DEFAULT_SIGNED_URL_TTL_SECONDS = 3600`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/storage.ts#L27) (1 hour) and caches them in-process (`signedUrlCache`, `storage.ts:153-160`) for [`SIGNED_URL_CACHE_FRESH_FRACTION = 0.5`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/storage.ts#L171) (30 minutes). See Section 7.4 for how `signedUrlWithExpiry()` returns the exact remaining TTL computed from `cachedAtMs`.
- **Next migration number:** [`EXPECTED_DB_VERSION = "0126"`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/version.ts#L22) (`0126_runs_survive_scene_delete.sql`). The next migration is **`0127_api_tokens.sql`**, and `EXPECTED_DB_VERSION` in `web/lib/version.ts` must bump to `"0127"` in the same change.

---

## 2. Reliable Spending Limits, Transaction Boundaries & RPC Security

### 2.1 How Costs & Pending Reservations Work Today
- **When `runs` rows are recorded:** For video renders, `web/` never inserts into `runs`. The Go worker inserts a `runs` row inside `MarkDone` / `MarkFailed` when the render finishes (`cost_usd` = vendor charge on success/billed failure; `cost_usd = NULL` on unbilled failure).
- **How pending jobs reserve budget (`web/lib/spend.ts:948-1090`):**
  - [`getInFlightSpend()`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/spend.ts#L994-L1090) queries all `scenes` with `status IN ("queued", "rendering")` and `dev = isDev()`, estimates each scene's cost, and folds that in-flight hold into global, weekly, hourly, and daily spend checks (`spend.ts:1613-1667`).
  - **Settlement / release requires no extra worker code:** Because `MarkDone` and `MarkFailed` flip `scenes.status` out of `('queued', 'rendering')` and insert the `runs` row in **one Postgres transaction** (`spend.ts:979-982`), a scene is counted in either in-flight `scenes` or settled `runs`, never both and never neither.

### 2.2 Confirmed Spend-Cap Gaps
1. **`getInFlightSpend()` ignores attached video reference durations ([`web/lib/spend.ts:1003-1081`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/spend.ts#L1003-L1081)):** It selects `scenes` without `scene_references`, under-reserving video-to-video scenes (`Price = Rate × (input_video_s + output_s)`) while in flight.
2. **Per-token `monthly_cap_usd` must include in-flight scenes:** Both settled `runs` and in-flight `queued`/`rendering` scenes for `api_token_id` must count toward `api_tokens.monthly_cap_usd`.
3. **Separate query vs. update across HTTP round trips ([`web/lib/spend.ts:1121-1162`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/spend.ts#L1121-L1162), [`web/actions/ugc.ts:1855-2126`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/ugc.ts#L1855-L2126), [`web/actions/enqueue.ts:328-353`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/enqueue.ts#L328-L353)):**
   - With `@supabase/supabase-js` (PostgREST), each `.select()`, `.update()`, or `.rpc()` call is a separate HTTP request and its own database transaction.
   - As documented in [`0083_image_generator.sql:176-179`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/supabase/migrations/0083_image_generator.sql#L176-L179) and the [PostgreSQL Advisory Locks documentation](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS), advisory locks only coordinate code paths that explicitly acquire the same lock keys within the same transaction as the check and write.

### 2.3 Single-Transaction Lock, Spend Check & Queue RPC (`public.queue_scenes_if_within_caps`)

To keep lock acquisition, ownership/fencing checks, spend evaluation (settled + in-flight), and the `status = 'queued'` transition inside **one database transaction** across **both browser and API submissions** and across **all users sharing the global cap**:

#### 1. Persist `estimated_cost_usd` on `public.scenes` when queuing
Add `estimated_cost_usd numeric` to `public.scenes` in `0127_api_tokens.sql`. Also update `getInFlightSpend()` in [`web/lib/spend.ts:1003-1081`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/spend.ts#L1003-L1081) to join `scene_references(kind, assets(duration_s))` (used for UI budget snapshots and as a fallback for any pre-0127 row where `estimated_cost_usd IS NULL`).

#### 2. `public.queue_scenes_if_within_caps` Definition, Ownership Verification & Fencing
Modeled directly on [`public.reserve_image_attempt` in `0083_image_generator.sql:112-321`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/supabase/migrations/0083_image_generator.sql#L112-L321), this function executes as a single `.rpc("queue_scenes_if_within_caps", ...)` transaction:

```sql
create or replace function public.queue_scenes_if_within_caps(
  p_project_id            uuid,
  p_expected_user_id      uuid,
  p_scene_ids             uuid[],
  p_scene_estimates_usd   numeric[],
  p_prepare_token         uuid,        -- required when queuing a newly-prepared scene; null for legacy batch enqueue
  p_api_token_id          uuid,        -- set by /api/v1/generate; null for browser actions
  p_dev                   boolean,
  p_override              jsonb,
  p_month_start_ts        timestamptz,
  p_day_start_ts          timestamptz,
  p_week_start_ts         timestamptz,
  p_hour_start_ts         timestamptz,
  p_now_ts                timestamptz,
  p_global_cap_enabled    boolean,
  p_global_cap_usd        numeric,
  p_global_cap_period     text,
  p_weekly_cap_usd        numeric,
  p_hourly_cap_usd        numeric,
  p_daily_cap_enabled     boolean,
  p_daily_cap_usd         numeric
)
returns table (
  outcome    text,     -- 'queued' | 'blocked' | 'fenced'
  blocked_by text,     -- 'global' | 'weekly' | 'hourly' | 'daily' | 'token_monthly' | null
  spent_usd  numeric
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
  -- 1. INPUT & ESTIMATE SANITY CHECKS (0083_image_generator.sql:143-165).
  --    Refuses empty arrays, mismatched array lengths, NULL/NaN/<=0 estimates, or missing caps.
  --    Every offerable video model has a strictly positive per-second rate; an estimate <= 0
  --    or NaN is rejected outright so a caller can never pass a zero/negative cost to bypass caps.
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
  select coalesce(sum(e), 0) into v_batch_estimate_usd
  from pg_catalog.unnest(p_scene_estimates_usd) as e;

  -- 2. ACQUIRE SHARED GLOBAL LOCK FIRST (protects company-wide global cap across DIFFERENT users).
  --    Lock order is ALWAYS global first, owner second — identical across browser, API, and
  --    reserve_image_attempt so two callers can never deadlock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('spend-cap:global')
  );

  -- 3. LOCK PROJECT ROW & VERIFY OWNER.
  --    Owner is derived from public.projects and verified against p_expected_user_id.
  select p.user_id into v_owner_id
  from public.projects p
  where p.id = p_project_id
  for update;

  if not found or v_owner_id is distinct from p_expected_user_id then
    raise exception 'queue_scenes_if_within_caps: project % not found for user %', p_project_id, p_expected_user_id
      using errcode = 'insufficient_privilege';
  end if;

  -- 4. ACQUIRE PER-USER LOCK SECOND (serializes all browser tabs + API scripts for this user).
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('spend-cap:owner:' || v_owner_id::text)
  );

  v_to_ts := greatest(p_now_ts, pg_catalog.clock_timestamp());

  -- 5. VERIFY API TOKEN OWNERSHIP, ACTIVE STATUS & READ CAP FROM DB (when p_api_token_id is set).
  --    Never trusts a caller-passed token cap; reads monthly_cap_usd directly from public.api_tokens.
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

  -- 6. LOCK TARGET SCENE ROWS, VERIFY PROJECT MEMBERSHIP, DURATION & FENCING TOKEN.
  --    If p_prepare_token is provided (createUgcClip and /api/v1/generate), verifies the scene is
  --    still in 'frame_ready' AND still owned by p_prepare_token. If another retry has reclaimed
  --    the row (rotating prepare_token), returns outcome = 'fenced' without modifying anything.
  select count(*) into v_locked_count
  from public.scenes s
  where s.id = any(p_scene_ids)
    and s.project_id = p_project_id
    and s.duration_s is not null
    and s.duration_s >= 3
  for update;

  if v_locked_count <> pg_catalog.cardinality(p_scene_ids) then
    raise exception 'queue_scenes_if_within_caps: one or more scenes do not belong to project % or have invalid duration',
      p_project_id
      using errcode = 'invalid_parameter_value';
  end if;

  -- Ensure no attached video_ref asset has a missing or <= 0 duration_s.
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
      return query select 'fenced'::text, null::text, null::numeric;
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

  -- 7. COMPUTE LIVE IN-FLIGHT SPEND INSIDE THE LOCK.
  select coalesce(sum(s.estimated_cost_usd), 0) into v_in_flight_global
  from public.scenes s
  where s.status in ('queued', 'rendering')
    and s.dev = p_dev
    and not (s.id = any(p_scene_ids));

  select coalesce(sum(s.estimated_cost_usd), 0) into v_in_flight_owner
  from public.scenes s
  join public.projects p on p.id = s.project_id
  where s.status in ('queued', 'rendering')
    and s.dev = p_dev
    and p.user_id = v_owner_id
    and not (s.id = any(p_scene_ids));

  -- 8. CHECK CEILINGS IN CANONICAL ORDER (global -> weekly -> hourly -> daily -> token monthly).
  if p_global_cap_enabled then
    v_global_from_ts := case when p_global_cap_period = 'weekly' then p_week_start_ts else p_day_start_ts end;
    v_spent := public.spend_total_usd(v_global_from_ts, v_to_ts) + v_in_flight_global;
    if v_spent + v_batch_estimate_usd > p_global_cap_usd then
      return query select 'blocked'::text, 'global'::text, v_spent;
      return;
    end if;
  end if;

  v_spent := public.user_spend_usd(v_owner_id, p_week_start_ts, v_to_ts) + v_in_flight_owner;
  if v_spent + v_batch_estimate_usd > p_weekly_cap_usd then
    return query select 'blocked'::text, 'weekly'::text, v_spent;
    return;
  end if;

  if p_hourly_cap_usd is not null then
    v_spent := public.user_spend_usd(v_owner_id, p_hour_start_ts, v_to_ts) + v_in_flight_owner;
    if v_spent + v_batch_estimate_usd > p_hourly_cap_usd then
      return query select 'blocked'::text, 'hourly'::text, v_spent;
      return;
    end if;
  end if;

  if p_daily_cap_enabled then
    v_spent := public.user_spend_usd(v_owner_id, p_day_start_ts, v_to_ts) + v_in_flight_owner;
    if v_spent + v_batch_estimate_usd > p_daily_cap_usd then
      return query select 'blocked'::text, 'daily'::text, v_spent;
      return;
    end if;
  end if;

  if p_api_token_id is not null and v_token_monthly_cap_usd is not null then
    select coalesce(sum(s.estimated_cost_usd), 0) into v_in_flight_token
    from public.scenes s
    where s.status in ('queued', 'rendering')
      and s.dev = p_dev
      and s.api_token_id = p_api_token_id
      and not (s.id = any(p_scene_ids));

    select coalesce(sum(r.cost_usd), 0) + v_in_flight_token into v_spent
    from public.runs r
    join public.scenes s on s.id = r.scene_id
    where s.api_token_id = p_api_token_id
      and r.dev = p_dev
      and r.cost_usd is not null
      and r.created_at >= p_month_start_ts
      and r.created_at <= v_to_ts;

    if v_spent + v_batch_estimate_usd > v_token_monthly_cap_usd then
      return query select 'blocked'::text, 'token_monthly'::text, v_spent;
      return;
    end if;
  end if;

  -- 9. RESERVE & QUEUE IN THE SAME TRANSACTION (clearing prepare_token now that status='queued').
  update public.scenes s
  set status = 'queued',
      dev = p_dev,
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

  return query select 'queued'::text, null::text, null::numeric;
end;
$$;
```

#### 3. Explicit `REVOKE EXECUTE` & Backend-Only Grants on All `0127` RPCs
Following [`0083_image_generator.sql:294-321`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/supabase/migrations/0083_image_generator.sql#L294-L321), because [`0007_grants.sql:33, 44-45`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/supabase/migrations/0007_grants.sql#L33) grants `EXECUTE` on all functions in `public` to `authenticated` by default (and PostgreSQL grants `EXECUTE` to `PUBLIC` by default), every RPC created in `0127_api_tokens.sql` (`queue_scenes_if_within_caps`, `insert_frame_ready_scene`, `attach_scene_references_fenced`, `reclaim_stale_frame_ready_scene`) is locked down to `service_role` only:
```sql
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
```
And why a client cannot supply a lower estimated cost or another user's ID:
- **Direct RPC calls from `anon` or `authenticated` are blocked at the Postgres privilege layer (`42501 permission denied`).**
- **In the Next.js routes and Server Actions (`service_role` callers):** `user.id` comes from `requireApiToken` (SHA-256 of the Bearer token) or `requireUser`/`requireProject` (session cookie), and `estimatedUsd` is always computed server-side by `estimateCost()` (`web/lib/estimate.ts`) from DB-persisted `duration_s`, `render_settings`, and `parseMp4DurationSeconds()`-verified video reference durations. No client payload field can ever supply a price or user ID.
- **Inside the RPC itself:** `v_owner_id` is verified against `projects.user_id` (`FOR UPDATE`), `api_tokens.user_id` is verified against `v_owner_id`, `monthly_cap_usd` is read directly from `public.api_tokens`, and non-positive/NaN estimates or missing video reference durations raise an exception.

#### 4. Confirming Browser & API Participation in the Same Lock Scheme
- **API path (`POST /api/v1/generate`):** Calls `queueScenesIfWithinCaps()`.
- **Browser `/ugc` paths ([`web/actions/ugc.ts`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/ugc.ts)):** `createUgcClip` (`ugc.ts:2123-2126`) and `regenerateClip` (`ugc.ts:2291-2332`) call `queueScenesIfWithinCaps()`.
- **Browser `/projects/[id]/render` paths ([`web/actions/enqueue.ts`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/enqueue.ts)):** `enqueueRender`, `enqueueScene`, `enqueueTestScene`, `retryScene`, `retryAllFailed`, and `rerenderScene` all call `queueScenesIfWithinCaps()`.
- **Image Generator path ([`0083_image_generator.sql:180-199`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/supabase/migrations/0083_image_generator.sql#L180-L199)):** Updated in `0127_api_tokens.sql` to use the same `'spend-cap:global'` and `'spend-cap:owner:' || v_owner_id::text` lock keys and live `v_in_flight_global`/`v_in_flight_owner` sums.

---

## 3. Exclusive Crash Recovery, Fencing for Slow Requests & Safe Cleanup

### 3.1 Schema Support on `public.scenes`
Add six nullable columns to `public.scenes` in `0127_api_tokens.sql`:
- `api_token_id uuid references public.api_tokens(id) on delete set null`
- `idempotency_key text` (max 128 chars)
- `idempotency_hash text` (SHA-256 hex of canonical request payload)
- `estimated_cost_usd numeric`
- `prepare_token uuid` — **per-attempt fencing token** set when a request starts preparing a `frame_ready` scene, rotated on recovery, and cleared to `NULL` once `status = 'queued'`
- `prepare_started_at timestamptz` — DB `clock_timestamp()` lease timestamp when `prepare_token` was issued or refreshed

With a partial unique index:
```sql
create unique index scenes_project_idempotency_key_uniq
  on public.scenes (project_id, idempotency_key)
  where idempotency_key is not null;
```

### 3.2 Exclusive CAS Recovery & Fencing Against Slow Requests

A `frame_ready` row being older than 15 seconds (`STALE_PREPARE_LEASE_SECONDS = 15`) does **not** prove the original request has crashed—the original request (Attempt A, holding `prepare_token = T_A`) might still be running slowly on a congested storage copy. Therefore, recovery uses an **exclusive compare-and-swap (CAS) lease rotation** combined with **strict `prepare_token` fencing** on every subsequent write and cleanup step:

#### 1. Actual Compare-And-Swap RPC (`public.reclaim_stale_frame_ready_scene`)
When a retry with `Idempotency-Key: K` (and matching `idempotency_hash = H`) sees an existing row in `status = 'frame_ready'` whose `prepare_started_at < clock_timestamp() - interval '15 seconds'`, it generates a fresh `v_new_prepare_token = crypto.randomUUID()` (`T_B`) and calls `public.reclaim_stale_frame_ready_scene`:

```sql
create or replace function public.reclaim_stale_frame_ready_scene(
  p_scene_id               uuid,
  p_project_id             uuid,
  p_expected_prepare_token uuid,
  p_new_prepare_token      uuid
)
returns table (
  claimed              boolean,
  superseded_keys      text[]
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
  -- COMPARE-AND-SWAP UPDATE:
  -- In PostgreSQL READ COMMITTED, if Retry B and Retry C execute this UPDATE concurrently
  -- with the same p_expected_prepare_token (T_A), Postgres locks the scenes row for the first
  -- writer (Retry B). Retry B updates prepare_token = T_B and prepare_started_at = clock_timestamp().
  -- When Retry B commits, Retry C unblocks, re-evaluates the WHERE clause against the updated
  -- row (EvalPlanQual), sees prepare_token is now T_B (<> T_A) and prepare_started_at is now
  -- fresh, matches 0 rows, and gets v_claimed_id = NULL.
  update public.scenes s
  set prepare_token = p_new_prepare_token,
      prepare_started_at = pg_catalog.clock_timestamp()
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

  -- Wipe any partial scene_references and scene-scoped assets from the superseded attempt
  -- inside the SAME transaction, returning ONLY the scene-scoped copy storage_keys so the
  -- caller can delete those orphaned copy objects from Storage.
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
```

- **Why two simultaneous retries cannot both claim the row:** Both read `p_expected_prepare_token = T_A`. The first to acquire the row lock in `UPDATE public.scenes` rotates `prepare_token` to `T_B` and advances `prepare_started_at` to `clock_timestamp()`. The second retry's `WHERE` clause (`s.prepare_token is not distinct from T_A AND s.prepare_started_at < clock_timestamp() - interval '15 seconds'`) fails on **both** predicates after row-lock re-evaluation, returning `claimed = false`. The loser then enters the short poll loop waiting for `T_B` to finish.

#### 2. How a Slow Original Request (`T_A`) Is Fenced From Modifying References, Queuing, or Deleting `T_B`'s Files
Once Retry B wins the CAS (`prepare_token = T_B`), here is what happens to every remaining step of slow Attempt A (`prepare_token = T_A`):

1. **Attempt A cannot modify `scene_references` or `assets` (`public.attach_scene_references_fenced`):**
   - During `attachSceneReferences`, an attempt first copies the referenced element files in Storage to new UUID keys (`projects/<projectId>/<kind>/<uuid>.<ext>`, [`web/actions/ugc.ts:1298-1303`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/ugc.ts#L1298-L1303)), recording those destination keys in a local per-attempt array `attemptStorageKeys: string[]`.
   - Instead of inserting into `assets` and `scene_references` with unguarded table inserts during the copy loop, all DB rows for `assets` (`scene_id = sceneId`) and `scene_references` (`scene_id = sceneId`) are inserted in **one fenced RPC call** `public.attach_scene_references_fenced(p_scene_id, p_project_id, p_prepare_token, p_assets_jsonb, p_refs_jsonb)` after the storage copies finish:
     ```sql
     -- Inside public.attach_scene_references_fenced:
     select 1 from public.scenes s
     where s.id = p_scene_id
       and s.project_id = p_project_id
       and s.status = 'frame_ready'
       and s.prepare_token = p_prepare_token
     for update;

     if not found then
       return false; -- Fenced! Inserts 0 rows into assets or scene_references.
     end if;

     -- Refresh lease timestamp so the 5-minute sweeper sees active progress,
     -- then insert the attempt's assets and scene_references rows.
     update public.scenes
     set prepare_started_at = pg_catalog.clock_timestamp()
     where id = p_scene_id;
     ```
   - When slow Attempt A finishes copying files and calls `attach_scene_references_fenced(..., p_prepare_token = T_A)`, the check `s.prepare_token = T_A` fails (`prepare_token` is `T_B` or `NULL`), so it returns `false` and **inserts zero `assets` or `scene_references` rows**.
2. **Attempt A cannot queue the scene (`public.queue_scenes_if_within_caps`):**
   - Even if Attempt A had finished `attach_scene_references_fenced` just before `T_B` reclaimed the row, when Attempt A calls `queue_scenes_if_within_caps(..., p_prepare_token = T_A)` (Section 2.3 Step 6), `s.prepare_token is distinct from T_A` returns `outcome = 'fenced'` without touching `scenes.status`.
3. **Attempt A cannot delete the scene row or `T_B`'s files in its `catch` / fencing cleanup:**
   - When Attempt A sees `fenced` (or catches any error), its cleanup runs two strictly scoped steps:
     - **Storage cleanup:** Calls `removeStorageObjects(attemptStorageKeys)` — where `attemptStorageKeys` is the local JavaScript array of `projects/<projectId>/<kind>/<uuid>.<ext>` keys that **Attempt A itself created** during its own `copyStorageObject` calls. It has no reference to `T_B`'s storage keys.
     - **DB row cleanup:** Executes a fenced delete that **requires `prepare_token = T_A`**:
       ```sql
       delete from public.scenes
       where id = p_scene_id
         and project_id = p_project_id
         and status = 'frame_ready'
         and prepare_token = p_prepare_token -- T_A
       returning id;
       ```
       Because `prepare_token` on the row is now `T_B` (or `NULL` because `T_B` already queued the scene), Attempt A's `DELETE` matches **0 rows**, leaving Retry B's scene, `scene_references`, and `assets` completely untouched. Instead of returning an error to Attempt A's caller when fenced, Attempt A reads the current scene row for `(project_id, K)` and returns the live status (`200 OK`, `deduplicated: true`)!

#### 3. How the 5-Minute Sweeper (`sweepAbandonedApiScenes`) Rechecks `prepare_started_at` on `DELETE` & Gates File Removal on `DELETE ... RETURNING`
- `sweepAbandonedApiScenes(projectId)` first selects candidate rows where `status = 'frame_ready' AND api_token_id IS NOT NULL AND prepare_token IS NOT NULL AND prepare_started_at < clock_timestamp() - interval '5 minutes'`.
- **Why the `DELETE` itself must recheck `prepare_started_at < clock_timestamp() - interval '5 minutes'`:** Between candidate selection and the `DELETE` statement, the **same active attempt** (`prepare_token = T_A`, unchanged!) can call `attach_scene_references_fenced` and refresh `prepare_started_at = clock_timestamp()`. Checking `prepare_token = v_candidate_prepare_token` alone would still match and delete that active scene!
- Therefore, the actual `DELETE` statement re-verifies **both** `prepare_token` **and** the 5-minute `prepare_started_at` cutoff under the row lock, and uses `DELETE ... RETURNING id` to confirm which rows were actually deleted:
  ```sql
  delete from public.scenes
  where id = v_candidate_id
    and project_id = p_project_id
    and api_token_id is not null
    and status = 'frame_ready'
    and prepare_token = v_candidate_prepare_token
    and prepare_started_at < pg_catalog.clock_timestamp() - interval '5 minutes'
  returning id;
  ```
- **Storage cleanup is strictly gated on `DELETE ... RETURNING` (never on the candidate list):**
  - If `DELETE ... RETURNING id` returns **0 rows** (because the same attempt refreshed `prepare_started_at` or another retry rotated `prepare_token`), the sweeper **stops immediately for that candidate and removes zero files**.
  - Only when `DELETE FROM public.scenes ... RETURNING id` returns a deleted `scene_id` does the sweeper delete the corresponding [`0088_deleted_scenes.sql`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/supabase/migrations/0088_deleted_scenes.sql#L190-L245) snapshot row (`DELETE FROM public.deleted_scenes WHERE scene_id = v_deleted_id RETURNING assets`, matching [`purgeDeletedScene` in `web/actions/ugc.ts:3050-3059`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/ugc.ts#L3050-L3059)) and pass only the `storage_key`s from that confirmed-deleted scene's `assets` snapshot to `removeStorageObjects()`.

#### 4. Why Cleanup Can Never Delete Shared Uploaded Elements
- **Code evidence ([`web/actions/elements.ts:375-404`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/elements.ts#L375-L404), [`web/actions/ugc.ts:1298-1325`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/ugc.ts#L1298-L1325)):**
  - Every Element in the Elements Library owns its own `assets` row (`elements.asset_id -> assets.id` with **`assets.scene_id IS NULL`**) under the user's hidden library project (`__elements_library__`).
  - When `attachSceneReferences` attaches an element to a scene (`ugc.ts:1298-1325`), it **never** attaches `elements.asset_id` directly. It calls `buildStorageKey({ projectId, kind: assetKind, ext })` to mint a brand-new UUID storage key under the target scene's project (`projects/<apiRunsProjectId>/<kind>/<newUuid>.<ext>`), copies the storage object (`copyStorageObject(sourceAsset.storage_key, toKey)`), and inserts a separate scene-scoped `assets` row with **`scene_id = sceneId`**.
- **Two-layer guarantee in cleanup:**
  1. Per-attempt rollback only passes `attemptStorageKeys` (the newly minted `toKey` copy strings returned by `buildStorageKey` during that attempt).
  2. `reclaim_stale_frame_ready_scene` and `sweepAbandonedApiScenes` only collect `storage_key`s from `DELETE FROM public.assets WHERE scene_id = p_scene_id AND project_id = p_project_id RETURNING storage_key` (which can never match an Element's asset because Element assets have `scene_id IS NULL` and live in `__elements_library__`), and the cleanup helper additionally filters out any key that does not start with `projects/${projectId}/` before calling `removeStorageObjects()`.

---

## 4. Media Verification Before Pricing & Hosting Constraints

*(See previous audit of [`package.json`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/package.json), [`web/package.json`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/package.json), [`web/Dockerfile`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/Dockerfile), [`web/actions/elements.ts:271-295`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/elements.ts#L271-L295), and [`web/lib/file-type.ts:87-177`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/file-type.ts#L87-L177)):*

1. **Zero-dependency MP4 `moov -> mvhd` parser (`web/lib/mp4-duration.ts`):**
   - No installed dependency (`sharp` is still-image only) or container binary (`oven/bun:1.4.2-alpine` has no `ffprobe`) parses MP4 duration in `web/`.
   - Walks top-level ISO BMFF boxes (`size`, `type`, including 64-bit `largesize === 1` and trailing `moov` after `mdat`) to read `moov -> mvhd` (`version 0` 32-bit and `version 1` 64-bit) and compute `duration / timescale`.
   - **Bounds & layout limits:** Rejects truncated box headers, box sizes `< header` or `> byteLength`, `timescale === 0`, `duration === 0`, fragmented MP4s (`fMP4` with `mvhd.duration === 0` and `moof` fragments), and legacy compressed QuickTime headers (`cmov`) with `422 invalid_media_file`. Client-supplied `duration_s` is ignored on video uploads.
2. **Staged Upload & Direct Upload Validation Parity:**
   - Both `POST /api/v1/elements` with `{ staged_key }` (uploaded via `POST /api/v1/elements/upload-url` to bypass Render's Cloudflare WAF, [`web/lib/staged-upload.ts:1-7`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/staged-upload.ts#L1-L7)) and direct `multipart/form-data` uploads execute the exact same 5 checks:
     1. `staged_key` prefix ownership check (`staging/${auth.userId}/<uuid>`, [`web/lib/storage.ts:729, 753`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/storage.ts#L753)) + staging object removal in `finally`.
     2. Size limits (`10 MB` image, `15 MB` video `.mp4`, `15 MB` audio `.mp3/.wav` -> `413 file_too_large`).
     3. Magic-byte signature check (`detectKind` -> `422 invalid_media_file`).
     4. Server-side `parseMp4DurationSeconds(bytes)` for `.mp4` (`422 invalid_media_file` on `null` or `<= 0`) and `2..30s` check for audio.
     5. Scoped `assets` and `elements` insertion with `user_id = auth.userId`.

---

## 5. Proof of Reference Mapping (Positional `@Image N` & Native `@tag`)

*(Verified against [`worker/internal/loop/dispatch.go:321-347, 726-803, 901-951, 967-1006`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/worker/internal/loop/dispatch.go#L321-L347) and [`web/actions/ugc.ts:1203-1413`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/actions/ugc.ts#L1203-L1413)):*

- `resolveApiReferences()` (shared by `/api/v1/quote` and `/api/v1/generate`) verifies that every ID in `image_refs`, `video_refs`, `audio_refs` belongs to `auth.userId` (`elements.user_id = auth.userId AND deleted_at IS NULL`) and matches the expected `assets.kind`.
- Validates positional `@Image k`, `@Video k`, `@Audio k` mentions against `1 <= k <= refsForKind.length` (`422 invalid_reference_index` if out of bounds) and rewrites them to `@<element.name>`.
- Passes `explicitOrderedTags` (in exact `image_refs`, `video_refs`, `audio_refs` array order) to `attachSceneReferences` so `ordinal = 1..N` per kind always matches the caller's array positions, even when `@Image 2` is mentioned before `@Image 1` in `prompt` or when an attached reference is not mentioned in `prompt`.

---

## 6. Token Security, Grants & Ownership Boundaries

### 6.1 Column-Scoped Grants & RLS on `public.api_tokens` (`0127_api_tokens.sql`)
Counters [`supabase/migrations/0007_grants.sql:40-41`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/supabase/migrations/0007_grants.sql#L40-L41) default table grants so `token_hash` is never readable by `authenticated` or `anon`:
```sql
alter table public.api_tokens enable row level security;
revoke all on table public.api_tokens from public, anon, authenticated;

grant select (
  id, user_id, name, token_prefix, scopes, monthly_cap_usd,
  expires_at, last_used_at, revoked_at, created_at
) on table public.api_tokens to authenticated;

create policy api_tokens_select_own_or_admin on public.api_tokens
  for select to authenticated
  using (public.is_active() and (user_id = auth.uid() or public.is_admin()));
```

### 6.2 Token Lifecycle, Account Status & Ownership Enforcement (`web/lib/api-auth.ts`)
- Enforces `Authorization: Bearer ms_live_<64-hex-chars>`, SHA-256 lookup on `token_hash`, `revoked_at IS NULL` (`401`), `expires_at IS NULL OR expires_at > now()` (`401`), [`canUseApp(profile)`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/account-approval.ts#L14-L16) for suspended accounts (`403`), required scope (`read`, `upload`, `generate` -> `403`), and explicit `user_id = auth.userId` scoping on every query.

---

## 7. Complete API Contract & Accurate Signed-URL Expiry

1. **Error envelope:** `{ "error": "...", "code": "..." }` across `400`, `401`, `403`, `404`, `409`, `413`, `422`, `429` (with `Retry-After`), and `500`.
2. **Rate limits (`web/lib/action-rate-limit.ts`):** Separate write bucket (`takeActionSlot` — `60/min`) and read bucket (`takeReadSlot` — `120/min`) so 5s polling never starves writes.
3. **Endpoints:**
   - `POST /api/v1/elements/upload-url` (`upload`)
   - `POST /api/v1/elements` (`upload`)
   - `GET /api/v1/elements` (`read`)
   - `POST /api/v1/quote` (`read`)
   - `POST /api/v1/generate` (`generate`)
   - `GET /api/v1/jobs/[id]` (`read`) — returns saved `inputs` (`prompt`, `provider_reference_prompt`, `references`), cost breakdown (`estimated_cost_usd`, `latest_attempt_cost_usd`, `total_cost_usd`, `attempts_count`), and `output` (`asset_id`, `download_url`, `url_expires_in_s`).
4. **Accurate `url_expires_in_s` (`signedUrlWithExpiry` in [`web/lib/storage.ts:153-160, 644-708`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/web/lib/storage.ts#L644-L708)):**
   - Returns `3600` on a fresh sign and `Math.max(1, cached.expiresInSeconds - Math.ceil((now - cached.cachedAtMs) / 1000))` on a cache hit (`1800–3600s`).

---

## 8. Required Work vs. Optional Features

- **Required Work:** Migration `0127_api_tokens.sql` (`api_tokens`, `scenes` columns, `queue_scenes_if_within_caps`, `insert_frame_ready_scene`, `attach_scene_references_fenced`, `reclaim_stale_frame_ready_scene`, unified lock keys in `reserve_image_attempt`, `REVOKE`/`GRANT EXECUTE`), `web/lib/mp4-duration.ts`, `web/lib/spend.ts` updates, `web/lib/api-references.ts`, `web/lib/api-auth.ts` + `/settings/api-tokens` UI, `/api/v1/*` routes, and focused automated tests.
- **Optional / Deferred:** Paid AI auto-description (`describeElement`) on API uploads, UI source-filter pills (`Web UI` vs `API`), formal `openapi.yaml`, and outbound webhooks.

---

## 9. Verification & Focused Test Plan

1. **RLS, Column Grants & Unauthorized Direct RPC Calls (`worker/internal/store/rls_anon_test.go`, `worker/internal/store/rls_test.go`):**
   - Add `"api_tokens"` to [`worker/internal/store/rls_anon_test.go:49`](file:///C:/Users/Asus/Desktop/Maison/Mason-Studios-/worker/internal/store/rls_anon_test.go#L49).
   - Verify in `worker/internal/store/rls_test.go` that `authenticated` cannot `SELECT token_hash FROM public.api_tokens` or mutate `api_tokens`.
   - **Unauthorized direct RPC test:** Verify that calling `public.queue_scenes_if_within_caps`, `public.insert_frame_ready_scene`, `public.attach_scene_references_fenced`, or `public.reclaim_stale_frame_ready_scene` as `anon` or `authenticated` is rejected with `42501 permission denied for function`, and that calling `queue_scenes_if_within_caps` with a mismatched `p_expected_user_id`, cross-user `p_api_token_id`, or `<= 0` estimate raises an exception.
2. **Authentication, Scopes & Account Lifecycle (`web/lib/api-auth.test.ts`):**
   - Covers valid tokens, revoked tokens (`401`), expired tokens (`401`), non-expiring tokens (`expires_at IS NULL`), suspended accounts (`403`), and missing scopes (`403`).
3. **Ownership & Staged Upload Isolation (`web/app/api/v1/__tests__/ownership.test.ts`):**
   - Confirms User A cannot reference User B's elements (`403`/`422`), cannot poll User B's jobs (`404`), and cannot pass a `staged_key` under `staging/<userB>/...` (`403`).
   - Confirms staged uploads and direct `multipart/form-data` uploads run through identical file-size (`413`), magic-byte (`422`), and MP4 duration (`422`) checks.
4. **MP4 Duration Parser (`web/lib/mp4-duration.test.ts`):**
   - Covers valid files (`mvhd` v0/v1, faststart and trailing `moov`, 64-bit `largesize`), malformed/truncated files (`< 8` bytes, out-of-bounds box `size`, `timescale === 0`, missing `moov`/`mvhd`), and unsupported layouts (fragmented MP4 with `mvhd.duration === 0`, `cmov`).
5. **Transactional Locking & Concurrent Spending (`web/lib/spend.test.ts`):**
   - Verifies `queue_scenes_if_within_caps` serializes concurrent browser + API submissions for the same user and across two different users competing for the remaining shared global cap (`spend-cap:global`).
6. **Idempotency, Exclusive CAS Recovery, Slow Request Fencing & Sweeper Safety (`web/app/api/v1/__tests__/idempotency.test.ts`):**
   - **Two simultaneous retries:** When a `frame_ready` row is stale (`prepare_started_at < now() - 15s`), two concurrent retries with the same `Idempotency-Key` call `reclaim_stale_frame_ready_scene`; proves exactly one wins `claimed = true` and queues the job while the second gets `claimed = false` and returns the winner's job (`deduplicated: true`).
   - **Slow original request overlapping recovery:** Attempt A (`prepare_token = T_A`) stalls for `> 15s` during storage copies while Retry B reclaims the row (`prepare_token = T_B`), attaches references, and queues the scene. When Attempt A resumes and attempts to call `attach_scene_references_fenced(T_A)`, `queue_scenes_if_within_caps(T_A)`, or its error/fencing cleanup (`DELETE ... WHERE prepare_token = T_A`), proves all three are fenced off and Retry B's queued scene, `scene_references`, and copied storage objects remain intact.
   - **Cleanup / 5-minute sweeper overlapping active preparation (same-attempt timestamp refresh):** The sweeper selects a stale candidate (`prepare_started_at < now() - 5m`, `prepare_token = T_A`); before the sweeper's `DELETE` executes, the **same attempt `T_A`** refreshes `prepare_started_at = clock_timestamp()` without changing `prepare_token`; when the sweeper executes `DELETE ... WHERE prepare_token = T_A AND prepare_started_at < clock_timestamp() - interval '5 minutes' RETURNING id`, proves `0` rows are deleted, `removeStorageObjects` is **not** called for that candidate, and the active scene and its files survive. Also verifies that cleanup of a genuinely deleted abandoned attempt only removes scene-scoped copy keys (`projects/<projectId>/...`), leaving the user's shared `elements` and their backing `assets` (`scene_id IS NULL`) untouched.
7. **Reference Mapping & Browser Regression (`web/lib/api-references.test.ts`):**
   - Out-of-order `"@Image 2 talks to @Image 1"`, mixed media, invalid indexes (`422`), and browser `createUgcClip` / `enqueueRender` regression tests.

---

## 10. Effort Estimate & Assumptions

> [!NOTE]
> The **~19.5-hour figure below is an engineering estimate subject to implementation and test results**, not a guaranteed delivery date.

| Workstream | Scope Included | Estimated Effort |
| :--- | :--- | :--- |
| **1. DB Migration `0127` + Transactional/Fenced RPCs + Go RLS Tests** | `0127_api_tokens.sql` (`api_tokens`, `scenes` columns, `queue_scenes_if_within_caps`, `insert_frame_ready_scene`, `attach_scene_references_fenced`, `reclaim_stale_frame_ready_scene`, unified lock keys in `reserve_image_attempt`, `REVOKE`/`GRANT EXECUTE`), `EXPECTED_DB_VERSION = "0127"`, `rls_anon_test.go`, `rls_test.go` | **3.5 hours** |
| **2. Pure-TS MP4 `mvhd` Parser & Upload Pipeline** | `web/lib/mp4-duration.ts`, unit tests (valid v0/v1/trailing-`moov`/`largesize`, truncated, fragmented MP4), wiring into `registerElement` & `POST /api/v1/elements` (both staged and direct) | **2.5 hours** |
| **3. Spend Hold & Browser/API Queue Wiring** | `web/lib/spend.ts` (`getInFlightSpend` video ref durations + `queueScenesIfWithinCaps` wrapper), wiring into `web/actions/ugc.ts` and `web/actions/enqueue.ts`, concurrent spend tests | **3.0 hours** |
| **4. Reference Mapping & Explicit Ordinal Binding** | `web/lib/api-references.ts`, `attachSceneReferences` (`explicitOrderedTags` + fenced insertion), unit tests for out-of-order mentions, mixed media, invalid indexes, ownership | **2.5 hours** |
| **5. Token Auth, Middleware, `signedUrlWithExpiry` & UI** | `web/lib/api-auth.ts`, `web/lib/supabase/middleware.ts`, `web/lib/storage.ts` (`signedUrlWithExpiry`), `web/actions/api-tokens.ts`, `/settings/api-tokens` + Accounts Control revocation/cap UI | **3.0 hours** |
| **6. `/api/v1/*` Route Handlers, Fenced Crash Recovery & Test Suites** | All 5 `/api/v1/*` routes, `prepare_token` CAS recovery + lazy sweep, tests for simultaneous retries, slow-request fencing, sweeper overlap, auth/ownership, and browser regression checks | **3.5 hours** |
| **7. End-to-End Trial (Ced's Workflow Verification)** | Minting a test token, uploading image + video + audio refs via staged URL, calling `/api/v1/quote` + `/api/v1/generate` + polling `/api/v1/jobs/[id]` in `MODE=development` plus 1–2 live trial clips | **1.5 hours** |
| **Total Estimated Effort** | **Includes implementation, migration `0127`, all focused tests above, browser regression checks, and the end-to-end trial** | **~19.5 hours (~2.5–3 engineering days, subject to implementation & test results)** |

### Key Assumptions Behind This Estimate
1. **No Go worker code changes:** The existing `worker/internal/loop/dispatch.go` claim, `ReferencesForScene`, `bindUITags`, and `referencePrompt` flows remain untouched.
2. **Existing staging bucket policies:** Supabase Storage's `media` bucket already permits signed uploads under `staging/<userId>/<uuid>` via `createStagedUploadUrl`.
3. **Single-environment trial first:** End-to-end verification runs locally against `MODE=development` first, followed by 1–2 capped live Seedance 2.5 renders once `0127_api_tokens.sql` is applied to remote Postgres.
