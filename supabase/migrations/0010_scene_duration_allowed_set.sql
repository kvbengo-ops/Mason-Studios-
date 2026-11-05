-- =============================================================================
-- scenes.duration_s — match fal's allowed clip lengths
--
-- 0001_init.sql wrote `check (duration_s > 0 and duration_s <= 8)` back when
-- we assumed a scene was at most one 8-second clip. The first real render
-- proved otherwise: fal-ai/ltx-2.3 accepts only
--
--   duration: Input should be 6, 8, 10, 12, 14, 16, 18 or 20
--
-- so the compiler now writes fewer, longer scenes — and every 10s+ scene was
-- rejected by the old constraint before it could reach fal at all.
--
-- The new constraint is the exact set rather than a range, because a range
-- would still admit 7s and 9s, which fal rejects. Three layers now agree:
-- the Zod schema (web/lib/claude.ts), the render gate
-- (web/lib/enqueue-guard.ts), and this — the last one being the only one a
-- direct SQL write cannot bypass.
--
-- NOT VALID on purpose. Scenes compiled under template v1 are still in the
-- table at 2s, 2.5s and 4s. Validating against them would fail this migration
-- for rows that are already unreachable: assertRenderableDurations refuses to
-- enqueue them, so they can be read and recompiled but never rendered. New
-- and updated rows are checked normally.
-- =============================================================================

alter table scenes drop constraint if exists scenes_duration_s_check;

alter table scenes
  add constraint scenes_duration_s_check
  check (duration_s in (6, 8, 10, 12, 14, 16, 18, 20))
  not valid;

comment on constraint scenes_duration_s_check on scenes is
  'fal-ai/ltx-2.3 accepts only these clip lengths; see 0010 and web/lib/models.ts.';
