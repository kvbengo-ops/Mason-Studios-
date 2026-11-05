-- =============================================================================
-- projects.character_desc_edited_at / projects.product_appearance_edited_at
-- — when the operator last CHANGED the text the compiler and the reference
-- image generators both read, so the Character/Product screens can tell the
-- operator when a generated image no longer matches the text.
-- =============================================================================
-- Two real incidents motivate this column pair (see this repo's own task
-- write-up):
--
--   1. A character was described as "an athletic woman" — everything else
--      (hair, clothing, earrings, lighting) was invented fresh per scene, so
--      the same person looked different in every clip. Nobody was warned
--      the description was too thin.
--   2. A product's reference PHOTO was a bright lime-green pouch; its TEXT
--      description said matte kraft-paper with a forest-green label. The
--      compiler only ever reads the text — text and image silently
--      disagreed, and the text won.
--
-- Both are instances of the same gap this repo already has a fix pattern
-- for on the ASSET side (web/actions/character.ts's invalidateComposite: a
-- changed reference photo deletes the stale composite outright, rather than
-- leaving it looking current). Reference PHOTOS (character_ref,
-- composite_ref) are regenerated from scratch on every change, so deleting
-- the stale one is correct — there is nothing to compare it against.
-- character_desc/product_appearance are different: they're operator-typed
-- text a generated portrait or composite was built FROM at some point in
-- the past, and re-typing them does not retroactively invalidate whatever
-- image already exists (see uploadCharacterRef/regenerateCharacter, which
-- never touch these two columns). Without a timestamp to compare against,
-- the Character/Product screens have no way to say "this text changed since
-- that image was made" — only "an image exists" and "text exists", with no
-- way to tell whether they still agree.
--
-- Nullable, no default, no backfill: null means "this text has never been
-- edited through the one write path that sets it" (web/actions/character.ts's
-- saveCharacterSetup) — true for every existing project and every new one
-- until its first Save. A null value reads as "not stale" everywhere this is
-- compared against an asset's created_at (an unset edited_at can never be
-- AFTER anything), which is the safe default: it would be actively wrong to
-- show a staleness warning for a description nobody has touched since this
-- column was added.
--
-- Set ONLY when the corresponding text actually changes value on a save —
-- not on every save that merely touches the row (title-only, direction-only,
-- product_name-only) — same "did it actually change" discipline
-- saveCharacterSetup already applies to source_character_id right next to
-- these two columns. Re-saving the exact same text must not manufacture a
-- staleness warning for an image that still matches it.
alter table projects
  add column character_desc_edited_at timestamptz,
  add column product_appearance_edited_at timestamptz;

comment on column projects.character_desc_edited_at is
  'When projects.character_desc last actually CHANGED value via saveCharacterSetup (web/actions/'
  'character.ts) — not merely when the row was last saved. Null means never edited through that '
  'path. Compared against the character_ref asset''s created_at by the Character screen to warn '
  'when a generated portrait was built from an EARLIER description and no longer matches it. See '
  'this migration''s header for the incident (a too-thin, then-changed description) this closes.';

comment on column projects.product_appearance_edited_at is
  'product_appearance''s twin of character_desc_edited_at above — when that column last actually '
  'changed value. Compared against the character+product composite asset''s created_at by the '
  'Product screen to warn when the composite (or the compiled brief) no longer reflects the '
  'current appearance text. See this migration''s header for the green-pouch incident this closes.';
-- =============================================================================
