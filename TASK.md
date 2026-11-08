# Personal API Token & REST Endpoints (`/api/v1/*`) — Implementation Tracker

**Design & Specification:** [`docs/personal-api-token-plan.md`](docs/personal-api-token-plan.md)  
**Prior Related Proposal (Superseded):** [`docs/mcp-per-account-plan.md`](docs/mcp-per-account-plan.md)  
**Other Repo Trackers (Separate Scope):** [`DEV_A_TODO.md`](DEV_A_TODO.md), [`PEER_APPROVAL_TODO.md`](PEER_APPROVAL_TODO.md), [`docs/image-generator-todo.md`](docs/image-generator-todo.md)  
**Estimated Effort:** ~19.5 hours (estimate subject to implementation and test results)

---

## Status Legend
- `[ ]` Pending
- `[~]` In progress
- `[x]` Completed & acceptance checks verified

**Current pass:** Implementation and focused suites are in place. Tests, lint, TypeScript, and Prettier were not run because the repo's `AGENTS.md` defers them to CI. `make db-push` could not connect to local Postgres, and `make db-start` could not reach Docker Desktop. Keep affected workstreams at `[~]` until CI and the local migration check verify them.

**Pass 2 (2026-11-09, Claude Code):** Skipped local Docker: `0127` + `0128` were applied to **prod** and the API was verified live end to end from the local dev server (which points at prod Supabase). Four bugs fixed along the way (see T1, T3, T6), image generation added to the API (T7), and a local MCP wrapper built (T8). Still **all uncommitted on `main`**, not through CI and not deployed — see "Next steps" below T8.

### Verified live (prod DB, local web, deployed worker)
| Check | Result |
| --- | --- |
| `GET /api/v1/elements` with a valid token | 200, the account's Elements |
| Forged `ms_live_` token | 401 `invalid_token` |
| `POST /api/v1/quote` Seedance 2.5 BytePlus 480p 4s | 200, $0.41 (published, unpaid label) |
| `POST /api/v1/quote` Wan 3.0 480P 4s | 200, $0.16 (receipt) |
| `POST /api/v1/generate` Wan 3.0 480P 4s | 202 → worker `queued → rendering → done` in ~2 min, `total_cost_usd` 0.16, 1 attempt, MP4 downloaded |
| Clip visible on `/create` Video wall | Only after the T6 `openSceneVersion` fix (job `c4952db6…` backfilled by hand in prod) |
| `GET /api/v1/images/{unknown uuid}` | 404 `not_found` (route + moved core compile and run) |
| `POST /api/v1/images` unknown model | 422 `unsupported_model`, nothing reserved |
| `POST /api/v1/images` Nano Banana 9:16 (paid) | 202 `generating` → `GET /api/v1/images/{id}` `completed` in ~20s, `cost_usd` 0.02, 768×1344 PNG, auto-filed as Element `img_3d2017` (`element_id` returned) |
| Same `Idempotency-Key` replayed | 200, same `asset_id`, no new charge (1 run row, $0.02 total) |
| Image → video chain: `@PROP_SERUM` tagged in `POST /api/v1/images` (routes to `nano-banana-edit`) → new Element as `image_refs[0]`, `PROP_SERUM` as `image_refs[1]` → `POST /api/v1/generate` Wan 3.0 720P 10s | Image $0.02 in ~20s; clip $0.80 (published, unpaid rate) `done` in ~4 min, 10.03s with AAC audio, person and product both carried through |
| Version fix (T6) on a fresh clip | `scene_versions` n=1, `clip_asset_id` set, `active_version_id` points at it — no backfill needed |
| Oddities to check | Wan 3.0 at "720P" returned a **1080×1920** file (kie billing at that tier unconfirmed — measure a 720P receipt); the clip carries a burned-in "MAISON_SERUM" caption Wan invented |
| **Not yet run:** a `POST /api/v1/elements` upload, the `/image-generator` UI after the core move | — |

---

## Workstream Checklist, Dependencies & Acceptance Checks

### T1 — Database Migration `0127_api_tokens.sql`, `types/db.ts`, `version.ts` & Go RLS Tests
- **Status:** `[~]` Implemented; needs CI verification
- **Dependencies:** None (foundation for T3, T4, T5, T6)
- **Files:**
  - `supabase/migrations/0127_api_tokens.sql`
  - `web/lib/version.ts` (`EXPECTED_DB_VERSION = "0127"`, now `"0128"` — see Pass 2 fixes)
  - `supabase/migrations/0128_fix_queue_scenes_unnest.sql` (Pass 2)
  - `web/types/db.ts` (hand-patched types for `api_tokens`, new `scenes` columns, and `0127` RPCs)
  - `worker/internal/store/rls_anon_test.go`
  - `worker/internal/store/rls_test.go`
- **Deliverables:**
  1. `public.api_tokens` table with RLS enabled, `REVOKE ALL` from `public, anon, authenticated`, column-scoped `GRANT SELECT` (excluding `token_hash`) to `authenticated`, and `api_tokens_select_own_or_admin` policy.
  2. `public.scenes` columns: `api_token_id`, `idempotency_key`, `idempotency_hash`, `estimated_cost_usd`, `prepare_token`, `prepare_started_at`, plus partial unique index `scenes_project_idempotency_key_uniq`.
  3. `SECURITY DEFINER` RPCs (`set search_path = ''`, `REVOKE ALL FROM public, anon, authenticated`, `GRANT EXECUTE TO service_role`):
     - `public.insert_frame_ready_scene`
     - `public.attach_scene_references_fenced`
     - `public.reclaim_stale_frame_ready_scene`
     - `public.delete_abandoned_api_scene`
     - `public.queue_scenes_if_within_caps`
     - Updated `public.reserve_image_attempt` using unified `'spend-cap:global'` and `'spend-cap:owner:' || v_owner_id::text` advisory lock keys and live in-flight scene subtraction.
- **Pass 2 fixes:**
  - `0127` referenced two types that do not exist — `public.scene_status` and `public.asset_kind` (`scenes.status` / `assets.kind` are `text` + CHECK). First prod apply failed and rolled back; replaced with `text`, then applied to prod.
  - **`0128_fix_queue_scenes_unnest.sql` (new, applied to prod):** `queue_scenes_if_within_caps` called `pg_catalog.unnest(a, b)`; multi-array `unnest` only exists unqualified, so every queue errored at runtime. Rewritten as `rows from (pg_catalog.unnest(a), pg_catalog.unnest(b))`. Same signature, so 0127's grants carry over.
  - `EXPECTED_DB_VERSION` → `"0128"` (`web/lib/version.ts`). Prod `/api/health` reports `database-ahead` until this branch deploys.
  - Codex stripped every explanatory comment from `reserve_image_attempt` in `0127` (logic identical to `0124` apart from the lock-key rename). Not restored — `0127` is frozen in prod; a comment-only `0129` is optional.
- **Acceptance Checks:**
  - `"api_tokens"` added to `worker/internal/store/rls_anon_test.go`.
  - `worker/internal/store/rls_test.go` covers `api_tokens` column-level `token_hash` denial for `authenticated` and `42501` direct RPC execution denial for `anon`/`authenticated`.

---

### T2 — Server-Side MP4 `mvhd` Duration Parser & Upload Validation Parity
- **Status:** `[~]` Implemented; needs CI verification
- **Dependencies:** None
- **Files:**
  - `web/lib/mp4-duration.ts`
  - `web/lib/mp4-duration.test.ts`
  - `web/lib/api-elements.ts`
  - `web/actions/elements.ts`
- **Deliverables:**
  1. Zero-dependency ISO BMFF `moov -> mvhd` duration parser (`parseMp4DurationSeconds(bytes: Uint8Array): number | null`) supporting `mvhd` v0 (32-bit), v1 (64-bit), faststart (`moov` before `mdat`), trailing `moov` (`moov` after `mdat`), and 64-bit `largesize === 1` boxes.
  2. Rejects truncated/malformed boxes, `timescale === 0`, `duration === 0`, fragmented MP4s (`fMP4` with `mvhd.duration === 0`), and `cmov` with `null` (`422`).
  3. Wired into `registerElement` (`web/actions/elements.ts`) and shared element upload helper so client-supplied `durationS` is never trusted for `.mp4` reference videos.
- **Acceptance Checks:**
  - `web/lib/mp4-duration.test.ts` passes for valid v0/v1/trailing-`moov`/`largesize` buffers, truncated/corrupt buffers, and unsupported fragmented MP4s.

---

### T3 — Spend Hold Fixes & Single-Transaction Queue Wiring (`web/lib/spend.ts`, `ugc.ts`, `enqueue.ts`)
- **Status:** `[~]` Implemented; needs CI verification
- **Dependencies:** T1
- **Files:**
  - `web/lib/spend.ts`
  - `web/lib/spend.test.ts`
  - `web/actions/ugc.ts`
  - `web/actions/enqueue.ts`
- **Deliverables:**
  1. `getInFlightSpend()` in `web/lib/spend.ts` joins `scene_references(kind, assets(duration_s))` and `api_token_id`, computing video-reference-aware in-flight spend (`byUserUsd`, `byTokenUsd`, `globalUsd`).
  2. `queueScenesIfWithinCaps()` helper in `web/lib/spend.ts` checks Kie vendor balance (outside DB lock when not in `MODE=development`), resolves account/global ceilings, and invokes `admin.rpc("queue_scenes_if_within_caps", ...)`.
  3. Wired into browser queue paths (`generateClip` in `web/actions/ugc.ts` and `enqueueRender`, `enqueueScene`, `enqueueTestScene`, `retryScene`, `retryAllFailed`, `rerenderScene` in `web/actions/enqueue.ts`) as well as `/api/v1/generate`.
- **Pass 2 fix:** `queueScenesIfWithinCaps` omitted `p_hour_start_ts`, so PostgREST could not resolve the RPC (`Could not find the function … in the schema cache`) — this broke **browser** Generate on any server running this branch, not only the API. Now passes `p_hour_start_ts: null` (the SQL reads NULL as a rolling `now - 1 hour`, matching the rolling-hour cap).
- **Acceptance Checks:**
  - `web/lib/spend.test.ts` covers video reference durations in `getInFlightSpend()`, per-token monthly cap holds, and `queueScenesIfWithinCaps()` serialization across same-user and cross-user global cap contention.

---

### T4 — Reference Mapping & Explicit Array-Ordered Binding (`web/lib/api-references.ts`, `ugc.ts`)
- **Status:** `[~]` Implemented; needs CI verification
- **Dependencies:** T1, T2
- **Files:**
  - `web/lib/api-references.ts`
  - `web/lib/api-references.test.ts`
  - `web/actions/ugc.ts`
- **Deliverables:**
  1. `resolveApiReferences()` validates ownership (`elements.user_id = userId AND deleted_at IS NULL`), media kinds (`image_refs`, `video_refs`, `audio_refs`), duplicate IDs, model reference limits (`MAX_REFERENCES = 10`, `seedance-2-mini` 9 images, Kling 2 PNG/JPG frames & `klingTagRefusal`), positional `@Image k`/`@Video k`/`@Audio k` bounds (`1..N`), and native `@tag` ownership.
  2. Rewrites positional mentions to `@<element.name>` while preserving array order in `explicitOrderedTags`.
  3. `attachSceneReferences` in `web/actions/ugc.ts` and `attachApiSceneReferences` in `web/lib/api-references.ts` support `explicitOrderedTags` and fenced `attach_scene_references_fenced` insertion.
- **Acceptance Checks:**
  - `web/lib/api-references.test.ts` proves out-of-order mentions (`"@Image 2 talks to @Image 1"`), mixed media (image + video + audio, including unmentioned refs), invalid indexes (`422`), cross-user reference rejection (`403`/`422`), and browser `generateClip` regression compatibility.

---

### T5 — Personal API Token Auth, `signedUrlWithExpiry`, Middleware & Token Management UI
- **Status:** `[~]` Implemented; needs CI verification
- **Dependencies:** T1
- **Files:**
  - `web/lib/storage.ts` (`signedUrlWithExpiry`)
  - `web/lib/storage.test.ts`
  - `web/lib/action-rate-limit.ts` (`takeReadSlot`)
  - `web/lib/action-rate-limit.test.ts`
  - `web/lib/supabase/middleware.ts` (`/api/v1` public path bypass)
  - `web/lib/api-auth.ts`
  - `web/lib/api-auth.test.ts`
  - `web/actions/api-tokens.ts`
  - `web/app/(app)/settings/api-tokens/page.tsx`
  - `web/components/api-tokens-manager.tsx`
  - `web/components/app-sidebar.tsx` (or settings navigation link)
- **Deliverables:**
  1. `signedUrlWithExpiry()` in `web/lib/storage.ts` returning `{ url, expiresInSeconds }` with exact remaining cache TTL (`1800..3600s`).
  2. `takeReadSlot(userId)` (`120/min`) in `web/lib/action-rate-limit.ts` alongside `takeActionSlot(userId)` (`60/min`).
  3. `/api/v1` added to `isPublicPath()` in `web/lib/supabase/middleware.ts`.
  4. `requireApiToken(req, requiredScope)` in `web/lib/api-auth.ts` enforcing `ms_live_` format, SHA-256 lookup, `revoked_at`, `expires_at` (including `NULL` non-expiring), `canUseApp(profile)`, and scopes (`read`, `upload`, `generate`).
  5. Server Actions (`createApiToken`, `revokeApiToken`, `listApiTokens`) in `web/actions/api-tokens.ts` and UI caller at `/settings/api-tokens` (plus sidebar/profile link so every Server Action has a UI caller per `AGENTS.md`).
- **Acceptance Checks:**
  - `web/lib/api-auth.test.ts` passes for valid, revoked, expired, non-expiring, suspended-account, and insufficient-scope tokens.

---

### T6 — `/api/v1/*` Route Handlers, Fenced Crash Recovery, Sweeper & Integration Tests
- **Status:** `[~]` Implemented; focused suites added, needs CI verification
- **Dependencies:** T1, T2, T3, T4, T5
- **Files:**
  - `web/app/api/v1/elements/upload-url/route.ts`
  - `web/app/api/v1/elements/route.ts`
  - `web/app/api/v1/quote/route.ts`
  - `web/app/api/v1/generate/route.ts`
  - `web/app/api/v1/jobs/[id]/route.ts`
  - `web/lib/api-v1.ts`
  - `web/lib/api-clip.ts`
  - `web/lib/api-elements.ts`
  - `web/lib/api-generation.ts`
  - `web/lib/api-references.ts`
  - `web/lib/spend.ts`
  - `web/lib/storage.ts`
  - `web/types/db.ts`
  - `web/app/api/v1/__tests__/ownership.test.ts`
  - `web/app/api/v1/__tests__/idempotency.test.ts`
- **Deliverables:**
  1. `POST /api/v1/elements/upload-url` (`upload` scope)
  2. `POST /api/v1/elements` (`upload` scope, staged & direct multipart with full validation parity) and `GET /api/v1/elements` (`read` scope)
  3. `POST /api/v1/quote` (`read` scope)
  4. `POST /api/v1/generate` (`generate` scope) with `Idempotency-Key` deduplication, `409` payload mismatch, `reclaim_stale_frame_ready_scene` CAS recovery, slow-request `prepare_token` fencing, and `sweepAbandonedApiScenes` (`DELETE ... WHERE prepare_token = ... AND prepare_started_at < clock_timestamp() - interval '5 minutes' RETURNING id`, gating storage cleanup on `DELETE ... RETURNING`).
  5. `GET /api/v1/jobs/[id]` (`read` scope) returning status, saved inputs, `estimated_cost_usd`, `latest_attempt_cost_usd`, `total_cost_usd`, `attempts_count`, and `output` with exact `url_expires_in_s`.
- **Pass 2 fix:** `/api/v1/generate` never opened a `scene_versions` row. The worker's `MarkDone` links the clip to `scenes.active_version_id` and `/create`'s wall reads takes from `scene_versions`, so an API clip rendered and billed but never appeared in the UI. The route now calls `openSceneVersion` (with the merged render settings) before queueing, exactly like `generateClip`. Not yet proven by a second paid render.
- **Acceptance Checks:**
  - `web/app/api/v1/__tests__/ownership.test.ts` and `web/app/api/v1/__tests__/idempotency.test.ts` pass, including:
    - Two simultaneous retries on a stale `frame_ready` row
    - Slow original request overlapping recovery (fenced on references, queue, and cleanup)
    - 5-minute sweeper selecting a stale candidate whose timestamp is refreshed by the same attempt before `DELETE` (`0` rows deleted, `0` files removed, shared Elements untouched)

---

### T7 — Image Generation over the API (`/api/v1/images`)
- **Status:** `[~]` Implemented 2026-11-09; free paths verified live, paid path not yet run, needs CI
- **Dependencies:** T5
- **Files:**
  - `web/lib/image-generation.ts` (new) — the guard-free core **moved verbatim** out of `web/actions/image-generator.ts`: `resolvePromptReferences`, `generateImageFor`, `settleAndStore`, `imageForRun`, `toImageAttempt`, the refusal messages, and the reconcile body as `reconcileImageAttemptFor(client, userId, runId)`. Deliberately **not** `"use server"`: every export of a `"use server"` module is a callable endpoint and this code authorizes nobody.
  - `web/actions/image-generator.ts` — now thin: every Server Action still calls `requireUser`/`requireProject` first and delegates to the core; types re-exported (type-only) so components are unchanged.
  - `web/actions/image-generator.test.ts` — import path for `resolvePromptReferences` → `@/lib/image-generation`.
  - `web/app/api/v1/images/route.ts` — `POST` (`generate` scope, `Idempotency-Key` required): `{prompt, model?, aspect_ratio?, resolution?}`; unknown `model` refused (422) instead of `getImageModel`'s silent default. Returns `202 {job_id, status:"generating"}` or `200 {status:"completed", output}`; refusals (caps, validation, kie) → 422.
  - `web/app/api/v1/images/[id]/route.ts` — `GET` (`read` scope): one reconcile read (same as the `/image-generator` panel), owner-scoped; `output` has `asset_id`, `element_id` (the picture is auto-filed as an Element, usable in a clip's `image_refs`), full-size `download_url`, `url_expires_in_s`.
- **Why not a token-auth Server Action:** `AGENTS.md` — every Server Action calls a guard first and has a UI caller.
- **Acceptance Checks (pending):** one paid `POST /api/v1/images` → poll to `completed` → `element_id` usable in `POST /api/v1/generate`; `/image-generator` still generates and recovers (refactor regression); CI green on `image-generator*.test.ts`.

---

### T8 — Local MCP wrapper (Claude Code / Claude Desktop)
- **Status:** `[~]` Built and protocol-tested 2026-11-09; **outside the repo** (personal client, per the superseded MCP plan's "builds his own script/MCP client")
- **File:** `C:\Users\Asus\mason-mcp\mason-mcp.mjs` — zero-dependency stdio JSON-RPC server (no `@modelcontextprotocol/sdk`), env `MASON_API_TOKEN` + `MASON_API_URL` (default `http://localhost:9000`).
- **Tools (7):** `list_elements`, `quote_clip`, `generate_clip`, `get_job`, `upload_element` (`file_path` or `url` → multipart `POST /api/v1/elements`), `generate_image`, `get_image`. Paid tools auto-mint an `Idempotency-Key` and echo it back for safe retries.
- **Verified:** `initialize`, `tools/list`, `quote_clip`, `get_job`, `get_image` 404, `generate_image` model refusal.
- **Register (Claude Code):** `claude mcp add mason --scope user -e MASON_API_URL=http://localhost:9000 -e MASON_API_TOKEN=<token> -- node C:\Users\Asus\mason-mcp\mason-mcp.mjs`
- **Register (Claude Desktop):** `%APPDATA%\Claude\claude_desktop_config.json` → `mcpServers.mason` with the same command/env; fully quit and reopen.
- **Not covered:** the Claude web/mobile app. That needs a hosted `/api/mcp` endpoint (token-in-URL or OAuth) on the deployed site — not started.

---

### Next steps
1. **Revoke the token pasted into the 2026-11-09 session** and mint a new one for the MCP wrapper.
2. Branch, commit, push; read CI and fix what it finds. Any further SQL fix is a **new** migration (`0127`/`0128` are in prod).
3. Merge, then deploy `ugc-web` manually (`autoDeploy: false`); `/api/health` should read `aligned` at `0128`. The worker needs no deploy.
4. Paid smoke tests: one image via `/api/v1/images`, one clip proving the `/create` wall fix, one Element upload.
5. Optional: hosted `/api/mcp` for the Claude web app; comment-only `0129` restoring `reserve_image_attempt`'s notes.

---

### Optional / Deferred Features (Not in Scope for This Pass)
- `[ ]` Paid AI auto-description (`describeElement`) on `POST /api/v1/elements`
- `[ ]` Source filter pills (`Web UI` vs `API`) in `/ugc` or Accounts Control
- `[ ]` Formal `openapi.yaml` file
- `[ ]` Outbound webhooks on job completion
