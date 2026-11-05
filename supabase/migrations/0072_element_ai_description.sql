-- What Claude sees in a saved reference, written once and reused.
--
-- WHY THIS IS CACHED AND NOT RECOMPUTED
--
-- The /ugc route no longer sends reference images to the video vendor. It
-- sends prose: Claude looks at each attached picture, describes it, and that
-- description is spliced into the prompt in place of the "@name" the operator
-- typed. So the description is not a nicety — it is the ONLY thing that
-- reaches the model about that picture.
--
-- Recomputing it per press has two costs, and the second is the one that
-- matters. The first is money and latency: a seven-clip ad describes the same
-- character seven times. The second is CONSISTENCY. Seven independent vision
-- calls produce seven slightly different descriptions of one photograph —
-- "ash-blonde", then "light blonde", then "pale blonde hair" — and the whole
-- reason an operator saves an element is that the same person appears across
-- clips. Recomputing quietly works against the thing the feature exists for.
--
-- WHY THE ASSET ID IS STORED BESIDE IT
--
-- A description is only true of the picture it was written from. An element
-- can be re-uploaded — same name, same category, new photograph — and a cache
-- keyed on the element alone would then describe a picture nobody can see any
-- more, silently and forever. Recording WHICH asset it came from makes the
-- staleness check a plain comparison at read time (ai_description_asset_id =
-- asset_id) rather than a trigger nobody remembers is there.
--
-- Deliberately NOT a foreign key: this is a record of what a description was
-- derived from, and it must survive the asset row being replaced. The
-- comparison it exists for works on a bare uuid, and a cascade or a
-- restriction here would either erase the evidence or block the re-upload.
--
-- NOT the operator's own `description`, which stays exactly as it was. That
-- column is what a human typed and may be aspirational, wrong, or "wdw" — the
-- live database holds that value. This one is what a model reported seeing.
-- Two different claims, kept apart on purpose: the same reasoning
-- lib/claude.ts's describePhotoAppearance was built on, after a fluent and
-- entirely wrong human description of a pouch that was sitting in the upload.

alter table elements
  add column if not exists ai_description text,
  add column if not exists ai_description_asset_id uuid;

comment on column elements.ai_description is
  'What Claude reported seeing in this element''s image, written once and reused for every '
  'prompt that names it. This is what actually reaches the video model: /ugc sends no '
  'reference images, so the description IS the reference. Null until the first Refine that '
  'needs it. Never shown as the operator''s own words — elements.description is that, and the '
  'two are deliberately separate claims.';

comment on column elements.ai_description_asset_id is
  'The asset ai_description was written from. A reader must treat the description as ABSENT '
  'when this does not equal asset_id: the element was re-uploaded and the cached text '
  'describes a photograph that is no longer attached. Not a foreign key — it is evidence of '
  'provenance and has to outlive the row it names.';


-- ---------------------------------------------------------------------------
-- Both prompts, kept apart.
-- ---------------------------------------------------------------------------
--
-- scenes.video_prompt is what the OPERATOR wrote, "@lena" and all. This is
-- what Claude produced from it, and it is what the vendor is actually sent.
--
-- Storing only one loses the ability to answer the question that matters when
-- a clip comes back wrong: was the prompt bad, or was the REFINEMENT bad?
-- Until now the refined text simply replaced the operator's in the editor and
-- then in the column, so the words they typed were gone the moment they
-- pressed Refine — and the render was billed against text nobody could
-- reconstruct.
--
-- It also makes the tags recoverable. video_prompt keeps "@lena", so an
-- operator can come back to a scene and retarget it; ai_generated_prompt has
-- that tag replaced by prose and cannot be edited back into a tag.
--
-- PRECEDENCE, stated here because two columns holding prompts is exactly the
-- shape that drifts: the worker submits ai_generated_prompt when it is set,
-- and video_prompt otherwise. A scene rendered without pressing Refine has
-- null here and behaves as it always did.

alter table scenes
  add column if not exists ai_generated_prompt text;

comment on column scenes.ai_generated_prompt is
  'The prompt Claude wrote from the operator''s own text — reference tags replaced by '
  'descriptions of the pictures they named — and THE ONE THE VENDOR IS SENT when it is set. '
  'Null for any scene generated without pressing Refine, which then submits video_prompt as '
  'before. Kept beside video_prompt rather than overwriting it so a wrong clip can be traced '
  'to either the writing or the refinement, and so the operator''s "@name" tags survive for '
  'retargeting.';
