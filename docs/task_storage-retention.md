# Task: Storage retention — 3-day bin, scheduled purge, storage quota

Owner decisions (2026-11-11):

- **Keep the 480p → 1080x1920 upscale and CRF 17.** Not touched by this task.
- **Bin retention is 3 days** (was 14).
- **Live work is never auto-deleted.** No auto-binning of old takes.
- **One storage quota for every non-admin account**, adjustable by an admin.

## Facts this task builds on

- Clips are stored by us, not streamed from kie. The worker downloads the kie result,
  normalizes it, and uploads the clip and poster to the Supabase `media` bucket
  (`worker/internal/ingest/ingest.go`). kie URLs are temporary.
- `BIN_RETENTION_DAYS = 14` lives in `web/lib/bin-thumbnails.ts:129`. Restore and the
  expiry label both read it.
- `reapExpiredBinEntries()` (`web/actions/ugc.ts`) runs **only on page load** of `/bin`
  and `/accounts-control`. With no visitors, nothing is purged.
- The **image bin** (`assets.deleted_at`, `0114`) is **never reaped**. Purging an image
  deletes the asset row and its Storage file (`manage_personal_image`).
- `assets.bytes` is written for every clip the worker uploads.

## Phase 1 — 3-day bin

1. Set `BIN_RETENTION_DAYS = 3` in `web/lib/bin-thumbnails.ts`.
2. Update every "14 days" / "2 weeks" string and comment that refers to the bin:
   - `docs/api.md:107`
   - doc comments on `reapExpiredBinEntries`, `purgeDeletedScene`, `purgeDeletedVersion`
     in `web/actions/ugc.ts`
   - `web/lib/bin-thumbnails.ts:128`
   - `docs/personal-api-token-plan.md:65`
   - any `/bin` page copy that states the window
3. Update `web/lib/bin-thumbnails.test.ts` for the 3-day cutoff.
4. ~~Extend `reapExpiredBinEntries()` to purge binned images.~~ **Done in the worker only**
   (Phase 2) — one copy of that logic, not two. Until the worker deploys, binned images
   are not auto-purged (same as today).

## Phase 2 — scheduled purge in the worker

The page-load reaper stays as a backup. The worker adds an hourly purge so expiry does
not depend on someone opening a page.

1. Add `DeleteObjects(ctx, cfg, bucket, keys)` to `worker/internal/store/storage.go`
   (`DELETE {SUPABASE_URL}/storage/v1/object/{bucket}` with `{"prefixes": [...]}`).
2. Add a purge loop that ticks hourly (constant `BinPurgeInterval`, no env var):
   - delete `deleted_scenes` and `deleted_scene_versions` rows with
     `deleted_at < now() - interval '3 days'` or `hard_deleted_at is not null`,
     returning their archived storage keys
   - delete binned images past the cutoff, returning their storage keys
   - remove only keys that no live `assets.storage_key` still references
   - skip a binned image that `scene_references` still points at (FK is `restrict`)
   - one statement; delete Storage objects **after** the commit, so a
     failed Storage call leaves an orphaned file, never a row pointing at nothing
3. Keep the 3-day window in one place per service: `BIN_RETENTION_DAYS` (web) and a Go
   constant (worker), with a comment on each that names the other.
4. Respect MODE: in `development`, purge only `dev = true` rows if those tables carry the
   flag; otherwise do not run the loop in development against prod Supabase.
5. This does not touch `scenes.status`, so the web/worker contract is unchanged.

## Status

- Phase 1: done. `BIN_RETENTION_DAYS = 3`, copy and docs updated.
- Phase 2: done. `worker/internal/store/bin_purge.go`, `worker/internal/loop/purge_bin.go`,
  `DeleteObjects` in `storage.go`, wired in `cmd/worker/main.go` (production mode only).
  Compiles; tests are left to CI.
- Phase 3: not started — waiting on the measurement query below.

## Phase 3 — storage meter and quota (separate PR)

Do this after running the measurement below.

```sql
select count(*), avg(bytes)/1e6 as avg_mb, sum(bytes)/1e9 as total_gb
from assets where kind = 'clip';
```

1. Migration `0136`: add `app_settings.storage_quota_gb` (numeric, nullable;
   `null` = disabled; seed `20`). Bump `EXPECTED_DB_VERSION` to `0136`. Apply to prod with
   `supabase db query --linked -f`, then insert the `schema_migrations` row, before deploy.
2. Usage per user = `sum(assets.bytes)` over the user's projects and personal images,
   **including binned items** until they are purged. Check that personal images and
   posters write `bytes`; backfill or count them as `0` and say so in the UI.
3. `assertWithinStorageQuota(userId)` in `web/lib/`, called next to every
   `assertWithinSpendCaps` site that starts a generation (`/ugc` Generate, Image
   Generator, `/api/v1/generate`). Admins are exempt.
   - at ≥ 100%: refuse Generate with "Storage full — delete clips or empty the bin."
   - never block download, delete, restore, or bin
4. UI:
   - sidebar meter: `X.X GB of 20 GB`, warning tone at ≥ 80%
   - Accounts Control: per-user usage column, and a field to edit `storage_quota_gb`
     (guarded by `requireAdmin`)

## Out of scope

- Changing the resolution or CRF of clips.
- Auto-binning old takes. If users ask, add a per-scene "Delete older takes" button
  that bins every take except the current one.
- Per-role quotas.

## Done when

- A scene, a take, and an image deleted 3+ days ago are gone from `/bin` and from
  Storage within an hour, with nobody opening `/bin`.
- A file still used by a live asset is never removed.
- (Phase 3) An editor over quota cannot Generate, can still delete, and sees the meter
  turn warning at 80%.
