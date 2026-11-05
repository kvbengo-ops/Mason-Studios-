-- =============================================================================
-- 'audio' becomes a legal assets.kind, which is the one thing standing between
-- this schema and a voice reference.
-- =============================================================================
--
-- 0071_scene_references.sql already shipped `kind text not null check (kind in
-- ('image', 'audio'))` and said in its own comment that "Audio cannot be stored
-- yet (assets.kind has no audio member)". The reference table was built for
-- this and left exactly one migration short. This is that migration.
--
-- WHAT IT UNBLOCKS, and what it deliberately does not do. kie's schema for
-- bytedance/seedance-2-5 takes `reference_audio_urls` — an array of URIs, WAV
-- or MP3, 2-30 seconds each, 15 MB each, 10 files maximum and 30 seconds
-- total (docs.kie.ai/market/bytedance/seedance-2-5, read 2026-09-04). None of
-- those limits belong in a CHECK here: a duration is not a column, and a file
-- size the storage layer already enforces would drift the moment kie changes
-- it. This migration makes the ROW legal; the upload path and the worker
-- enforce the rest.
--
-- Same layer argument as 0022_asset_poster_kind.sql and 0017_composite_asset:
-- assets.kind is our own product vocabulary carried as a text CHECK rather
-- than a native enum, so extending it is a migration and not a type change.
--
-- The 'voice' ELEMENT CATEGORY has existed since 0065 and has been a
-- placeholder that whole time — a voice element stored an image, because
-- there was nowhere to put audio. It stops being a placeholder here.
-- =============================================================================

alter table assets drop constraint if exists assets_kind_check;

alter table assets
  add constraint assets_kind_check
  check (kind in ('character_ref', 'product_ref', 'composite_ref', 'ref_frame', 'clip', 'final', 'poster', 'audio'));

comment on constraint assets_kind_check on assets is
  'Our own product vocabulary, not a vendor enum — see 0017_composite_asset.sql for why a CHECK '
  'here is the right layer. poster added in 0022. audio added in 0079: a WAV or MP3 voice '
  'reference, sent to kie as reference_audio_urls. The vendor''s own limits (2-30s, 15 MB, 10 '
  'files, 30s total) are enforced at upload and by kie itself, not here — a duration is not a '
  'column, and a limit copied into a CHECK drifts the moment the vendor moves it.';
