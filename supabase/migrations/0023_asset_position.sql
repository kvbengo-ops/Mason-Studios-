-- =============================================================================
-- assets.position — ordinal position for a project's product_ref photos;
-- position 0 is THE primary.
--
-- The gap this closes: spec §3.2's "Product Photos (optional — upload
-- multiple angles for better consistency)" is a GRID with one photo marked
-- primary ("8 photos · primary used for the brief, all are passed as
-- references at image-gen time"). Nothing in this schema stopped an
-- operator from uploading more than one product_ref row before this
-- migration — uploadProductRef (web/actions/character.ts) has always been a
-- plain INSERT, never a replace — but every reader (regenerateComposite in
-- that same file, and actions/frames.ts's loadConditioningRefs) picked
-- `order by created_at desc limit 1`: the single most recently uploaded
-- row. A second upload didn't add a photo to a grid, it silently replaced
-- the first one for every purpose that mattered, while the first row
-- stayed in the table forever — paid-for Storage the app never showed
-- again and never fed to the vendor again. This migration gives `assets` a
-- real way to order a project's photos of one kind and to say which one is
-- primary, so the application code can build an actual grid instead of
-- papering over the accumulation with "most recent."
--
-- ---------------------------------------------------------------------------
-- Why an ordinal, not a boolean is_primary + partial unique index
-- ---------------------------------------------------------------------------
-- Both were considered. A boolean needs its OWN uniqueness guarantee (a
-- partial unique index on is_primary where true) AND a separate mechanism
-- for grid order — the grid still has to render photos in some stable
-- sequence, so a boolean-only design still ends up needing an ordinal
-- column right next to it, just for the non-primary photos. That's two
-- columns encoding two invariants that can drift apart from each other
-- (nothing stops `is_primary = true` at position 3 without a second CHECK
-- tying them together), for a grid that only ever needed one.
--
-- An ordinal collapses both into a single column: `position` orders the
-- grid, and position 0 IS primary by definition — there is no second flag
-- to keep in sync, and no state where "primary" and "first in the grid"
-- can disagree. This is also not a new idiom for this schema: it's the
-- exact shape `scenes.idx` + `unique (project_id, idx)` already established
-- in 0001_init.sql for "order a project's rows of one kind, and enforce no
-- two can claim the same slot." `position` on `assets` is that same
-- pattern applied to product photos instead of scenes.
--
-- ---------------------------------------------------------------------------
-- Why the unique index is scoped to kind = 'product_ref', not the whole
-- table
-- ---------------------------------------------------------------------------
-- A table-wide `unique (project_id, kind, position)` looks like the more
-- "general" choice and was rejected on inspection: character_ref and
-- composite_ref have the EXACT accumulation pattern described above —
-- uploadCharacterRef, regenerateCharacter, and useCharacter (see
-- 0020_characters.sql / 0021_project_character_source.sql) all INSERT a
-- new row without deleting the old one; only removeCharacterRef's "delete
-- every row of this kind" ever cleans them up. If `position` defaulted to
-- 0 table-wide, the SECOND character_ref row any project ever accumulates
-- would violate a table-wide constraint immediately — regenerateCharacter
-- would start failing in production the moment this migration landed,
-- which is a worse bug than the one being fixed. product_ref is the only
-- kind that has grown an actual grid (this migration's application-code
-- companion, web/actions/character.ts); scoping the index to it, and
-- leaving `position` an inert, unenforced 0 default on every other kind,
-- is the minimal change that fixes the real bug without also
-- retroactively demanding an ordinal invariant from three other code paths
-- that were never asked for one. `scene_id is null` rides along in the
-- WHERE clause as a defensive belt, not a load-bearing part of the
-- invariant — product_ref rows never carry a scene_id in any code path
-- today (they're a project-level reference asset, not a per-scene one,
-- same split 0022_asset_poster_kind.sql's header documents for
-- clip/final/poster).
--
-- ---------------------------------------------------------------------------
-- Backfill order: newest-first, matching current production behaviour
-- ---------------------------------------------------------------------------
-- Any project that already accumulated more than one product_ref row (the
-- exact garbage this migration exists to stop producing) needs its
-- existing rows assigned distinct positions before the unique index below
-- can even be created — otherwise CREATE UNIQUE INDEX fails outright on
-- the first project with duplicates. The backfill assigns position 0 to
-- the MOST RECENTLY created row per project, 1 to the next, and so on —
-- matching the `order by created_at desc limit 1` every reader has used
-- until now, so applying this migration does not silently swap which photo
-- feeds the compiled brief or the vendor call for any project that already
-- has more than one. (Oldest-first would have been just as valid a
-- one-time choice, but would flip the live reference out from under any
-- project with accumulated rows the moment this migration ran — a
-- behaviour change hidden inside what should be a purely additive schema
-- migration.)
--
-- NOT YET APPLIED — per the standing instruction on this task, this
-- migration is written and reviewed but not run against any database.
-- =============================================================================

alter table assets
  add column if not exists position integer not null default 0;

comment on column assets.position is
  'Ordinal within (project_id, kind). Position 0 is primary — enforced for kind=''product_ref'' '
  'by assets_product_ref_position_key below. Inert (unenforced) default 0 for every other kind; '
  'see this migration''s header for why the invariant is scoped to product_ref only.';

alter table assets
  add constraint assets_position_non_negative check (position >= 0);

-- Backfill existing product_ref rows BEFORE the unique index below is
-- created — a project with accumulated duplicate-position rows (all
-- default 0) would fail CREATE UNIQUE INDEX otherwise. See header for why
-- newest-first.
with ranked as (
  select
    id,
    row_number() over (partition by project_id order by created_at desc) - 1 as ranked_position
  from assets
  where kind = 'product_ref'
)
update assets
set position = ranked.ranked_position
from ranked
where assets.id = ranked.id;

-- The actual invariant: at most one product_ref row per project may hold
-- any given position — in particular, at most one may hold position 0,
-- i.e. at most one primary. See header for why this is scoped to kind =
-- 'product_ref' rather than the whole table.
create unique index assets_product_ref_position_key
  on assets (project_id, position)
  where kind = 'product_ref' and scene_id is null;

comment on index assets_product_ref_position_key is
  'Enforces at most one product_ref row per project per position — in particular, at most one '
  'primary (position 0). Scoped to kind=''product_ref'' only; see 0023_asset_position.sql''s header '
  'for why a table-wide version of this index would break character_ref/composite_ref, which still '
  'accumulate rows without cleanup on every upload/regenerate.';
