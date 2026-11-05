-- =============================================================================
-- projects.kind — tells a scripted project's title link from a clip
-- project's, which the UI cannot currently do at all.
--
-- createClipProject (the /ugc console's entry point) writes a `projects`
-- row exactly like every scripted project does — same table, same
-- `projects.id` — because a clip project is still a project: it has an
-- owner, a status, scenes, spend. Nothing before this migration marked
-- which flavor a given row is, so the project list's title link had
-- exactly one route hard-coded (`/projects/<id>`) and sent every clip
-- project into the scripted console it was never built for. This column is
-- the fix: the title link now branches on `kind` — 'clip' -> `/ugc/<id>`,
-- 'scripted' -> `/projects/<id>` — instead of guessing.
--
-- DEFAULT 'scripted', not nullable: every row that exists before this
-- migration runs IS a scripted project (createClipProject and the /ugc
-- route did not exist yet), so the backfill is the default itself — no
-- UPDATE statement needed, and no row can end up in the ambiguous
-- "neither" state a nullable column would allow.
--
-- CHECK, not a native Postgres enum: same reasoning as every other
-- CHECK-constrained "enum-ish" column in this schema (assets.kind,
-- scenes.status, projects.status itself) — see 0001_init.sql and
-- web/types/db.ts's "Hand-maintained enum aliases" header. Our own product
-- vocabulary, migration-gated, not a vendor enum.
-- =============================================================================

alter table projects
  add column kind text not null default 'scripted'
    check (kind in ('scripted', 'clip'));

comment on column projects.kind is
  'Which console owns this project: ''scripted'' -> /projects/<id> (the script-driven pipeline, '
  'every project before this column existed), ''clip'' -> /ugc/<id> (createClipProject''s console). '
  'The project list''s title link branches on this instead of hard-coding one route for every row '
  '— see this migration''s header for the defect that shipped before this column existed.';
