-- =============================================================================
-- 'video' becomes a legal scene_references.kind, and scene_references.category
-- admits the 'video' element category alongside it. A tagged .mp4 can now
-- reach a render.
-- =============================================================================
--
-- 0093_video_reference_elements.sql got video reference elements as far as
-- storage and the picker, and stopped there on purpose: its header called
-- widening this exact CHECK "the migration that says 'we know what this
-- costs'" and declined to be that migration, because reference_video_urls
-- had never been confirmed against kie's own docs and no render had ever
-- sent one.
--
-- WHAT CHANGED SINCE. reference_video_urls is confirmed in kie's Seedance 2.5
-- docs (docs.kie.ai/market/bytedance/seedance-2-5) as the array a video
-- reference is sent in, the same shape as reference_image_urls and
-- reference_audio_urls before it, and the render path (worker and
-- web/actions/ugc.ts's attachSceneReferences) is now wired to send it. 0093's
-- reason (a) for refusing -- the worker silently skipping a kind it does not
-- recognise -- no longer applies once the worker knows this one.
--
-- THE WARNING THAT SURVIVES, because it is not a schema problem and no CHECK
-- can fix it. kie prices a video-input render as Price x (input + output),
-- not Price x output -- a scene carrying a video reference bills MORE than
-- an otherwise-identical scene without one. That arithmetic is not enforced
-- here; it lives in web/lib/kie/rates.ts and worker/internal/kie/models.go,
-- and every quote and cap check upstream of this table needs to agree with
-- it before an operator sees a price this migration can no longer prevent
-- them from exceeding.
--
-- 'video' MATCHES elements.category's spelling, not assets.kind's -- a video
-- reference element is assets.kind = 'video_ref' (0093) but writes here as
-- kind = 'video', exactly the way an image element (assets.kind = 'ref_frame'
-- or similar) already writes as kind = 'image'. scene_references.kind has
-- always named the vendor ARRAY a row feeds, never the storage vocabulary of
-- the asset behind it.
--
-- CATEGORY TOO. scene_references.category snapshots elements.category at
-- attach time (0071's own header), and 0081_element_kind_categories.sql
-- already keeps scene_references_category_check in lockstep with
-- elements_category_check for exactly that reason -- a category the
-- snapshot cannot hold is a category attachSceneReferences cannot write, no
-- matter what kind.kind allows. elements.category gained 'video' in 0093;
-- scene_references.category did not, because nothing could reach this table
-- to test it. It does now.
--
-- Same drop-and-recreate shape as every migration that has touched either
-- constraint (0079, 0081, 0083, 0093). Both widen; neither rewrites an
-- existing row.
-- =============================================================================

alter table scene_references drop constraint if exists scene_references_kind_check;

alter table scene_references
  add constraint scene_references_kind_check
  check (kind in ('image', 'audio', 'video'));

alter table scene_references drop constraint if exists scene_references_category_check;

alter table scene_references
  add constraint scene_references_category_check
  check (category in ('character', 'product', 'voice', 'location', 'image', 'audio', 'video'));

comment on column scene_references.kind is
  'Which vendor array this row lands in: ''image'' -> reference_image_urls, ''audio'' -> '
  'reference_audio_urls, ''video'' (0094) -> reference_video_urls. Seedance numbers all three '
  'independently, so ordinal is unique per (scene, kind) rather than per scene. A scene '
  'carrying a ''video'' row bills as Price x (input + output), not Price x output -- see '
  'web/lib/kie/rates.ts and worker/internal/kie/models.go, and this migration''s own header.';

comment on column scene_references.category is
  'What this reference DEPICTS, snapshotted from elements.category at attach time -- see '
  '0071''s own comment for why a snapshot and not a join. ''video'' added in 0094 alongside '
  'kind gaining the same member; kept in lockstep with elements_category_check the same way '
  '0081 first set up, because a category the snapshot cannot hold is one attachSceneReferences '
  'cannot write regardless of what kind allows.';

-- ---------------------------------------------------------------------------
-- CORRECTING TWO COMMENTS 0093 WROTE AND THIS MIGRATION JUST FALSIFIED
-- ---------------------------------------------------------------------------
-- 0093 recorded, on the constraint and on the column, that a video reference
-- "is never sent to kie" and that scene_references.kind was "deliberately
-- staying" without a video member. Both were true and load-bearing when they
-- were written: the field name reference_video_urls had not been confirmed
-- against kie's schema and the input+output pricing had no owner, so the
-- narrow constraint WAS the enforcement and the comments said so.
--
-- The statements above reverse exactly that. A comment is not a changelog --
-- it is the current state of the database, and pg_description keeps only the
-- last one written -- so leaving 0093's text in place would mean every reader
-- who inspects these two objects is told the opposite of what the schema now
-- does, by the schema itself. Rewritten here rather than edited into 0093,
-- because 0093 has already been applied elsewhere and a migration that has
-- run is history.

comment on constraint assets_kind_check on assets is
  'Our own product vocabulary, not a vendor enum -- see 0017_composite_asset.sql for why a CHECK '
  'here is the right layer. video_ref added in 0093: an uploaded .mp4 reference element. 0093 '
  'said here that a video is never sent to kie; 0094 made that false. A tagged video now becomes '
  'a scene_references row of kind ''video'' and reaches Seedance as reference_video_urls. It is '
  'still NOT a conditioning frame -- only a still can be one, and web/actions/ugc.ts''s '
  'firstTaggedImageElementId enforces that with an allowlist rather than a denylist.';

comment on column elements.category is
  'What KIND of reference this is: image, audio, or (0093) video. The older subject-based values '
  '(character, product, location) are still legal and still carried by rows that predate 0081, '
  'but nothing branches on any of them -- the value is a filter label. A ''video'' element is an '
  '.mp4 that is uploaded, described automatically by kie''s Gemini pass, named and tagged like '
  'any other reference. 0093 said here that it could not be attached to a scene; 0094 made that '
  'false -- it can, and a scene carrying one bills as Price x (input + output).';
