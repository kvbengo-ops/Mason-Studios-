-- Several reference assets per scene, in the order the prompt names them.
--
-- WHY A TABLE AND NOT MORE COLUMNS
--
-- Seedance binds references from the prompt BY INDEX: "@image1" is the first
-- entry of reference_image_urls, "@image2" the second, "@audio1" the first
-- entry of reference_audio_urls. kie's schema for bytedance/seedance-2-5
-- accepts up to 30 images and 10 audios. The editors' actual workflow uses
-- that shape — a person, a background, a product, a voice, a music bed — and
-- the whole of it was unreachable because a scene could hold exactly one
-- reference: `scenes.ref_frame_asset_id uuid`, one column, one picture.
--
-- ORDINAL IS THE CONTRACT. ordinal 1 becomes @image1 in the submitted prompt.
-- The worker cannot derive that ordering from the prompt text — it tried, and
-- the two sides disagreed silently, because the web resolves the first tag
-- that MATCHES A SAVED ELEMENT (skipping ones that match nothing) and lets an
-- explicit picker choice beat every tag. So the order is written down here by
-- the side that decides it.
--
-- KIND SPLITS THE TWO ARRAYS. 'image' rows number @image1..N and 'audio' rows
-- number @audio1..N, independently — Seedance numbers per array, not across
-- all references. Audio cannot be stored yet (assets.kind has no audio
-- member) so no 'audio' row can exist today; the column is here because
-- leaving it out would mean renumbering every image row the day it lands.
--
-- CATEGORY AND DESCRIPTION ARE SNAPSHOTS, per reference, taken from the
-- element at scene-creation time. They are what let the worker say what each
-- slot IS — "@image1 is the character reference. @image2 defines the location
-- and light; do not use any people in it." A tag alone connects nothing: an
-- index with nothing said about it is a picture the model was handed and told
-- nothing about. Snapshotted rather than joined because
-- actions/ugc.ts COPIES a chosen element's image into this project rather
-- than pointing at it, so there is no link back to elements to follow — and
-- because an element renamed after a clip was billed must not change what
-- that clip is recorded as having been made from (0059's rule).
--
-- 'location' is a category elements does not have yet. It is admitted here so
-- the declaration can say the one thing that matters about a backdrop — do
-- not reproduce the people in it — the moment the picker can save one.
--
-- THE SCRIPTED PIPELINE IS UNTOUCHED. It writes no rows here, and the worker
-- falls back to scenes.ref_frame_asset_id when a scene has none. That column
-- stays: it is still the only reference the wizard produces, and moving it
-- would rewrite a pipeline this change has nothing to do with.

create table scene_references (
  id          uuid primary key default gen_random_uuid(),
  scene_id    uuid not null references scenes (id) on delete cascade,
  asset_id    uuid not null references assets (id) on delete restrict,
  kind        text not null check (kind in ('image', 'audio')),
  ordinal     int  not null check (ordinal >= 1),
  category    text check (category in ('character', 'product', 'voice', 'location')),
  description text,
  tag         text,
  created_at  timestamptz not null default now(),
  unique (scene_id, kind, ordinal)
);

comment on table scene_references is
  'The reference assets one scene submits, in the order the vendor indexes them. ordinal 1 '
  'of kind ''image'' is the "@image1" the prompt can name. Written by /ugc''s generateClip; '
  'the scripted pipeline writes none and keeps using scenes.ref_frame_asset_id. See this '
  'migration''s header for why the order is recorded rather than derived from the prompt.';

comment on column scene_references.asset_id is
  'ON DELETE RESTRICT, unlike scenes.ref_frame_asset_id''s plain reference: these rows say '
  'what a BILLED render was made from, so an asset row must not be removable while a scene '
  'still cites it. Deleting the scene cascades these away first, which is the intended '
  'order of operations.';

comment on column scene_references.kind is
  'Which vendor array this row lands in: ''image'' -> reference_image_urls, ''audio'' -> '
  'reference_audio_urls. Seedance numbers the two independently, so ordinal is unique per '
  '(scene, kind) rather than per scene.';

comment on column scene_references.ordinal is
  '1-based position within its kind, and therefore the N in "@imageN". Not a display order: '
  'changing it changes which picture the prompt is talking about.';

comment on column scene_references.category is
  'What this reference DEPICTS, snapshotted from elements.category — plus ''location'', '
  'which elements does not offer yet. Read by the worker to write a declaration true of '
  'THIS picture: "use the person''s face, hair and clothing" is right about a character and '
  'actively wrong about a bottle or a backdrop. Null for a direct upload, which has no '
  'element behind it.';

comment on column scene_references.description is
  'The operator''s own words about this reference, snapshotted from elements.description. '
  'Fed to the model so an index arrives with words attached. NOT re-read from elements '
  'later: an element re-described after a clip was billed must not change what that clip is '
  'said to have been made from.';

comment on column scene_references.tag is
  'The element NAME whose "@tag" in the prompt selected this reference, or null when it came '
  'from the picker or a direct upload. The worker rewrites exactly this tag to "@imageN" '
  'using the ordinal above, and strips the "@" from every other tag in the prompt — a tag '
  'that named nothing this scene carries must not be left looking like an index.';

create index scene_references_scene_id_kind_ordinal_idx
  on scene_references (scene_id, kind, ordinal);
