-- =============================================================================
-- assets.kind gains 'poster' — a small downscaled JPEG frame for a clip or
-- a project's assembled final, extracted by the Go worker
-- (worker/internal/media.Runner.ExtractPoster).
--
-- The bug this fixes: every <video> in the web app (clip-grid.tsx,
-- deliver/page.tsx) sets preload="metadata" specifically to avoid pulling
-- whole videos on page load — the right call on the 3G/4G connections these
-- are watched over — but with no `poster` attribute anywhere in the repo,
-- that means every video renders as a blank/black box until its metadata
-- resolves. On mobile this reads as a broken page, not a loading one.
--
-- Why this is a new assets.kind rather than a column on scenes/projects, or
-- its own table: it IS an asset in every way the `assets` table already
-- models one — one storage_key, uploaded through the same
-- worker/internal/store.UploadObject path 'clip' and 'final' already use,
-- against the same 'media' bucket. The only things that differ from a clip
-- are the file extension (jpg, not mp4) and content-type (image/jpeg) on
-- upload, and those live in the worker code that produces it
-- (worker/internal/ingest and worker/internal/loop/assemble), not the
-- schema.
--
-- A poster row's scene_id follows the same convention 'clip' and 'final'
-- already established: set for a per-scene clip poster
-- (worker/internal/store.StorageKeyForPoster), NULL for a project-level
-- final poster (worker/internal/store.StorageKeyForFinalPoster) — the same
-- split ProjectsReadyToAssemble and SceneClipsForProject already rely on to
-- tell "belongs to one scene" from "belongs to the project" apart.
--
-- assets.kind is a plain `text` CHECK, not a native Postgres enum — see
-- 0001_init.sql / types/db.ts's "Hand-maintained enum aliases" section, and
-- 0017_composite_asset.sql for the same reasoning applied to
-- 'composite_ref'. Same treatment here: 'poster' is our own product
-- vocabulary, not a vendor enum, so a migration-gated CHECK is the right
-- layer.
--
-- Extraction is best-effort on the worker side (see
-- worker/internal/media.Runner.ExtractPoster's doc comment) — a render or
-- an assembly that fails to produce a poster still completes and is still
-- marked done/final. This migration only makes 'poster' a legal kind value;
-- it does not require one to exist for every clip or final.
-- =============================================================================

alter table assets drop constraint if exists assets_kind_check;

alter table assets
  add constraint assets_kind_check
  check (kind in ('character_ref', 'product_ref', 'composite_ref', 'ref_frame', 'clip', 'final', 'poster'));

comment on constraint assets_kind_check on assets is
  'Our own product vocabulary, not a vendor enum — see 0017_composite_asset.sql for why a CHECK '
  'here is the right layer (same reasoning as 0013_project_direction.sql''s shooting_mode/ugc_style). '
  'poster added in 0022: a small JPEG frame for a clip or final, extracted by '
  'worker/internal/media.Runner.ExtractPoster, best-effort and never required.';
