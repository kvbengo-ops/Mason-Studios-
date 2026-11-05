-- =============================================================================
-- projects.include_visual_idea, scenes.visual_idea — the per-scene visual
-- idea (SMN-feature-spec.md §3.3)
--
-- The gap this closes: 0013_project_direction.sql gave the operator exactly
-- one directorial lever, `visual_idea`, applied identically to every scene
-- in the ad. The reference product's actual Script step takes the script as
-- TWO columns — `Script` and `Visual Idea` — so the operator can hand-author
-- what EACH shot looks like, with an `Include Visual Idea` checkbox (default
-- ON) telling the compiler "keep your own visual directions and have Claude
-- EXPAND each into a full prompt instead of inventing its own." Until this
-- migration, the app had no way to receive, use, or remember that per-line
-- input — only the whole-project override.
--
-- Two columns, on two different tables, doing two different jobs:
--
--   * projects.include_visual_idea (boolean, default true) — the operator's
--     live master switch, exactly analogous to the six columns
--     0013_project_direction.sql already added (shooting_mode, ugc_style,
--     etc): a scalar, project-wide setting read by lib/direction.ts's
--     ProjectDirection and consulted by lib/claude.ts's compileBrief /
--     compileScene before using any per-scene visual idea at all. Default
--     TRUE, unlike every boolean 0013 added — spec §3.3 is explicit that
--     the reference product's checkbox is "checked by default," and an
--     existing project backfilled to true changes nothing for it: a
--     project with no two-column script data has nothing for this flag to
--     switch on in the first place (see scriptRowsHaveVisualIdea in
--     lib/script-columns.ts).
--
--   * scenes.visual_idea (text, nullable) — NOT the operator's raw input.
--     This is Claude's own record of which operator-authored visual idea
--     (if any) it actually used to write THIS scene's video_prompt,
--     written once per scene at compile time (see the new
--     Brief.scenes[].visual_idea field, lib/claude.ts) and echoed forward
--     unchanged on every Apply/Split of that scene afterward. It has to
--     live on `scenes`, not `projects`, because the mapping from "one row
--     of the operator's two-column paste" to "one compiled scene" is not
--     1:1 — 0019_seed_template_v5.sql §1 already has Claude merge several
--     adjacent script lines into a single longer scene whenever they share
--     a setting, and a merged scene may draw on more than one source row's
--     visual idea. Claude is the only party present at compile time that
--     knows which source line(s) ended up in which output scene, so it is
--     the only party that can correctly attribute a visual idea to a scene
--     — asking application code to reverse-engineer that mapping from text
--     alone (matching merged, possibly-reworded script_line values back
--     against the original pasted rows) would be guessing at something
--     Claude already knows for certain.
--
-- Deliberately NOT a persisted column for the operator's raw two-column
-- INPUT (an array of {script, visual_idea} rows, one per pasted/uploaded
-- line). script_raw (0001_init.sql) already IS that input, byte for byte —
-- lib/script-columns.ts's parseTwoColumnScript is a pure, cheap function
-- that re-derives the parsed rows from script_raw fresh on every compile
-- (see actions/compile.ts). Storing a second, separately-maintained copy
-- of the same information would only create a way for the two to drift the
-- moment an operator edits the script without whatever wrote the second
-- copy noticing — the exact class of bug lib/script-guard.ts's own header
-- comment warns about for a different pair of call sites. One source of
-- truth (script_raw), parsed on demand, has no such failure mode.
--
-- Why plain typed columns, not jsonb: same reasoning as
-- 0013_project_direction.sql's header comment in full — neither column
-- here is vendor-shaped, neither varies by which video/image model the
-- project renders on, and both benefit from being queried and defaulted
-- with ordinary SQL rather than jsonb path operators.
-- =============================================================================

alter table projects
  add column if not exists include_visual_idea boolean not null default true;

comment on column projects.include_visual_idea is
  'Spec §3.3''s "Include Visual Idea" checkbox, checked by default. When true, '
  'the compiler (web/lib/claude.ts) expands the operator''s own per-line visual ideas '
  '(parsed fresh from script_raw by web/lib/script-columns.ts on every compile) into '
  'the scenes they apply to, instead of inventing its own camera/action direction. '
  'When false, any two-column data the operator pasted is ignored for this purpose — '
  'the script text itself is still cleaned of delimiter noise either way.';

alter table scenes
  add column if not exists visual_idea text;

comment on column scenes.visual_idea is
  'The operator-authored visual idea (spec §3.3) that shaped this scene''s video_prompt, '
  'if any — Claude''s own echo, written once at compile time (Brief.scenes[].visual_idea, '
  'web/lib/claude.ts) and carried forward unchanged by Apply/Split thereafter (the model''s '
  'echo on a re-generate is NOT trusted as authoritative for an existing scene — this '
  'column is, the same way scenes.is_talking_head is preserved across a re-Apply rather '
  'than left to be re-derived — see lib/talking-head.ts). Null for every scene compiled '
  'without a two-column script, or with include_visual_idea off. This is NOT the operator''s '
  'raw pasted text — that lives only in projects.script_raw, re-parsed on demand by '
  'web/lib/script-columns.ts; this column is the compiler''s own record of which line, if '
  'any, actually shaped this specific scene.';
