-- =============================================================================
-- projects.source_character_id — a label, not a source of truth
--
-- The bug this fixes: an operator clicks Use on a Character Library card
-- (web/actions/character-library.ts's useCharacter) and nothing in the grid
-- shows which card that was. The reference photo and character_desc below
-- do change, but useCharacter COPIES them in — see its doc comment and
-- 0020_characters.sql's header — precisely so a library entry an admin
-- deletes later can never blank a character out of a project that already
-- used it. Because it copies rather than points, nothing on `projects`
-- previously recorded which library row a given copy came from, so the grid
-- genuinely could not answer "which one is this."
--
-- This column answers that question WITHOUT reopening the problem the copy
-- was built to avoid. It is deliberately just a label:
--
--   * character_ref (the assets row) and character_desc remain the only
--     real data. Nothing reads a character through this column — anything
--     that did would be reintroducing the live reference 0020 rejected.
--   * `on delete set null` mirrors that on the schema level: removing a
--     library character clears the label and changes NOTHING else. The
--     project keeps its own copies and keeps rendering exactly the
--     character it always did — the label just stops claiming to know
--     which library row (now gone) it once matched.
--   * It is nullable and starts null: most projects to date built a
--     character from scratch and never touched the library at all, and
--     that remains a completely valid, "no label" state.
--
-- Kept in sync with the copies, not just with the library row: the label is
-- also cleared (source_character_id set back to null) the moment the
-- operator changes character_desc or the character reference photo by any
-- path OTHER than useCharacter itself — a hand-edited description, a fresh
-- upload, or a regeneration (web/actions/character.ts's saveCharacterSetup,
-- uploadCharacterRef, regenerateCharacter, removeCharacterRef). Once the
-- project's own copy no longer matches what was copied, a badge that still
-- said "in use" would be lying about present state, not just recording
-- history — worse than showing nothing, because it actively misleads an
-- operator into thinking the library and the project are still the same
-- character. useCharacter is the only path that SETS this column; every
-- other write to character_desc or the character reference asset is a path
-- that CLEARS it.
--
-- No index: this column is only ever read alongside the rest of a single
-- project row already loaded by requireProject's `select("*")` — there is
-- no query that filters or joins on it.
-- =============================================================================

alter table projects
  add column if not exists source_character_id uuid references characters(id) on delete set null;

comment on column projects.source_character_id is
  'Label, not a source of truth: which characters row useCharacter last copied character_ref/'
  'character_desc FROM. Never read to reconstruct the character itself — character_ref and '
  'character_desc are the only real data (see 0020_characters.sql). Set by useCharacter '
  '(web/actions/character-library.ts); cleared to null both by "on delete set null" when that '
  'library row is removed, and by application code whenever the project''s own copy is hand-edited, '
  're-uploaded or regenerated (web/actions/character.ts) so the label can never claim to match a '
  'copy it no longer describes.';
