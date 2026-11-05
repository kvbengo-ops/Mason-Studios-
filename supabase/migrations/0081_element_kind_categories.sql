-- =============================================================================
-- 'image' and 'audio' become element categories, and 'voice' becomes 'audio'.
-- =============================================================================
--
-- WHAT THE CATEGORY IS FOR NOW, and why it changed.
--
-- 0065 made it a description of the SUBJECT — character, product, and later
-- location (0073) — on the theory that what a reference depicts is what an
-- operator sorts by. Two months of use says otherwise: nothing in the prompt
-- substitution, the reference payload or the render has ever branched on it,
-- and the filters were used to answer one question only — "is this a picture
-- or a voice?" Product and Location were removed from the UI on 2026-09-04
-- for exactly that reason; this finishes the move by making the column say
-- the thing it is actually read for.
--
-- 'voice' -> 'audio' IS A RENAME, not a reclassification. Every row carrying
-- it was created by the audio upload path, which forces that value for any
-- MP3 or WAV; the two words have never meant different things here. Moving
-- them keeps the Audio filter honest, which the old value would silently sit
-- outside of.
--
-- NOTHING ELSE MOVES. character, product and location rows keep the category
-- they have. They stay legal, they stay tagged, they stay sent — they simply
-- do not appear under the Image filter, only under All. Rewriting them to
-- 'image' would be a guess: the operator who typed "character" may have meant
-- it, and the column has no second field to remember that in.
--
-- The four old values are therefore kept in the CHECK. This widens; it does
-- not narrow. A migration that narrowed would have to delete or rewrite rows
-- nobody asked to change.
-- =============================================================================

alter table elements drop constraint if exists elements_category_check;

alter table elements
  add constraint elements_category_check
  check (category in ('character', 'product', 'voice', 'location', 'image', 'audio'));

-- Done AFTER the widened CHECK is in place, or the update itself is refused.
update elements set category = 'audio' where category = 'voice';

-- scene_references snapshots the element's category at attach time, so its own
-- CHECK has to admit the same words or attachSceneReferences starts failing on
-- any element saved from here on.
alter table scene_references drop constraint if exists scene_references_category_check;

alter table scene_references
  add constraint scene_references_category_check
  check (category in ('character', 'product', 'voice', 'location', 'image', 'audio'));

update scene_references set category = 'audio' where category = 'voice';

comment on column elements.category is
  'What KIND of reference this is, as of 0081: image or audio. The older subject-based values '
  '(character, product, location) are still legal and still carried by rows that predate this, '
  'but nothing branches on any of them — the value is a filter label. 0081 renamed voice to '
  'audio; they had never meant different things.';
