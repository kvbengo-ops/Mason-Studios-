-- BytePlus's private Asset Library, for Seedance 2.5 on BytePlus.
--
-- BytePlus wants a reference uploaded to its Asset Library once (CreateAsset,
-- AK/SK-signed, asynchronous) and then named as "asset://<id>" in the video
-- request, rather than fetched from our signed URL on every render. The worker
-- does the upload (a vendor call never runs in web/), and it must not upload
-- the same Element again for every scene: generateClip COPIES each reference
-- into the scene's project, so every scene's row points at a different asset,
-- and the Entry tier caps an account at 50 library assets.
--
-- 1. scene_references.source_asset_id — the Element's own asset the row was
--    copied from. Written by generateClip; null for an upload made straight
--    into a scene and for every row written before this migration, where the
--    worker falls back to the row's own asset_id (one upload per scene, which
--    is what those always cost).
--
-- 2. byteplus_assets — one row per source the worker has sent to BytePlus:
--    BytePlus's asset id and its last known status. WORKER-ONLY. The worker
--    connects as the database owner, so no grant or policy is needed for it;
--    RLS is enabled with NO policy and every grant revoked so no signed-in
--    client can read or write it (0007's default privileges would otherwise
--    make it readable to every account).

-- DELIBERATELY NO FOREIGN KEY to assets. A second scene_references -> assets
-- FK makes every PostgREST embed `scene_references(assets(...))` ambiguous
-- ("Could not embed because more than one relationship was found"), which
-- broke production reads the day this was first applied with one
-- (2026-11-19, dropped the same hour). The column is only a cache key.
alter table public.scene_references
  add column source_asset_id uuid;

comment on column public.scene_references.source_asset_id is
  'The Element asset this row''s asset was copied from (generateClip copies every reference '
  'into the scene''s project). The worker keys its BytePlus Asset Library uploads on it, so '
  'one Element is uploaded once, not once per scene. Null for a direct upload and for rows '
  'written before 0147; the worker then keys on asset_id. DELIBERATELY NO FOREIGN KEY: a '
  'second scene_references -> assets FK makes every PostgREST scene_references(assets(...)) '
  'embed ambiguous and fail.';

create table public.byteplus_assets (
  -- source_asset_id as text, or scene_references.asset_id when that is null,
  -- or the storage key for a pre-0071 scene with no reference rows at all.
  -- Text rather than a uuid FK so all three fit one key space.
  source_key        text primary key,
  byteplus_asset_id text not null,
  status            text not null check (status in ('Processing', 'Active', 'Failed')),
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.byteplus_assets is
  'Worker-only cache of BytePlus Asset Library uploads: which BytePlus asset holds each '
  'reference source, and whether it is usable yet (Active). See 0147''s header.';

alter table public.byteplus_assets enable row level security;
revoke all on table public.byteplus_assets from anon, authenticated;
