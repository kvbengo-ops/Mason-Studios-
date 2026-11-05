-- =============================================================================
-- 'video' becomes a legal element category, and 'video_ref' becomes a legal
-- assets.kind. Neither reaches kie: this migration is deliberately a dead end.
-- =============================================================================
--
-- THE FEATURE THIS UNBLOCKS: an operator uploads an .mp4 (max 25MB) as a
-- video reference element, auto-named new_video1 / new_video2 / ..., visible
-- in the elements library and taggable in a prompt as @new_video1 -- the same
-- shape every other element category already has.
--
-- WHAT THIS MIGRATION DOES NOT DO, and why that is the point rather than an
-- oversight.
--
-- 1. No auto-description. An element with category = 'video' saves with
--    description = null; the operator writes it by hand through the
--    existing updateElement form (elements-library.tsx). No describe vendor
--    is ever called for a video asset -- describing video is a different,
--    unpriced call, and this migration does not authorize spending on it.
--
-- 2. NOTHING HERE LETS A VIDEO REFERENCE REACH A RENDER, and that is
--    enforced at the schema layer, not only in application code.
--    scene_references.kind is LEFT NARROW ON PURPOSE -- still
--    `check (kind in ('image', 'audio'))` from 0071_scene_references.sql,
--    untouched by this migration. Two independent reasons, both load-bearing:
--
--    a) worker/internal/loop/dispatch.go:230 already silently SKIPS any
--       scene_references row whose kind it does not recognize -- "A kind
--       this build does not know about. Skipped rather than guessed at:
--       posting an unknown key into either vendor array is how a render
--       silently carries the wrong material." A video kind reaching that
--       loop would vanish from the render with no error raised, which is a
--       worse failure than never being insertable at all.
--
--    b) Even if the worker were taught a third key, this product has not
--       verified what that key would cost. web/lib/kie/rates.ts:134 records
--       that kie prices ANY video-conditioned render as
--       Price x (input + output), not Price x output -- a materially
--       different bill than every render this product has priced and
--       shipped spend caps against. Widening scene_references.kind is the
--       migration that says "we know what this costs"; this is not that
--       migration.
--
--    The result: an element can be video-typed, stored, named and
--    displayed, but INSERTing it into scene_references fails the existing
--    CHECK the moment anything tries to. The constraint is the enforcement;
--    this comment is only the explanation.
--
-- 3. No reference_video_urls. Nothing here, in Go or TypeScript, adds that
--    key -- see (b) above for why that would be premature.
--
-- HOW THE TWO CONSTRAINTS BELOW ARE WIDENED: drop-and-recreate, the same
-- shape as every migration before this one that touched either check --
-- 0079 (assets.kind gained audio), 0083 (assets.kind gained
-- generated_image), 0081 (elements.category gained image/audio). This
-- widens; it does not narrow, so no existing row changes and nothing here
-- needs an UPDATE.
-- =============================================================================

alter table assets drop constraint if exists assets_kind_check;
alter table assets
  add constraint assets_kind_check
  check (kind in ('character_ref', 'product_ref', 'composite_ref', 'ref_frame',
                  'clip', 'final', 'poster', 'audio', 'generated_image', 'video_ref'));

comment on constraint assets_kind_check on assets is
  'Our own product vocabulary, not a vendor enum -- see 0017_composite_asset.sql for why a CHECK '
  'here is the right layer. video_ref added in 0093: an uploaded .mp4 reference element. It is '
  'NOT a conditioning reference and is never sent to kie -- scene_references.kind is deliberately '
  'left at image/audio only so no video reference can become a scene_references row; see '
  '0093_video_reference_elements.sql for the full reasoning.';

alter table elements drop constraint if exists elements_category_check;
alter table elements
  add constraint elements_category_check
  check (category in ('character', 'product', 'voice', 'location', 'image', 'audio', 'video'));

comment on column elements.category is
  'What KIND of reference this is: image, audio, or (0093) video. The older subject-based values '
  '(character, product, location) are still legal and still carried by rows that predate 0081, '
  'but nothing branches on any of them -- the value is a filter label. video (0093) is an .mp4 '
  'reference element that is uploaded, named and displayed like any other, but cannot be attached '
  'to a scene: scene_references.kind has no video member and is deliberately staying that way -- '
  'see this migration''s header.';
