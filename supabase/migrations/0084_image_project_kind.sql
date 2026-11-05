-- =============================================================================
-- projects.kind gains 'image' — the Image Generator gets its own console.
-- =============================================================================
--
-- 0083 built the Image Generator as a surface INSIDE an existing project, at
-- /projects/<id>/image-generator. That was wrong in a way only visible once it
-- was on screen: the generator is deliberately not connected to video at all
-- (see docs/image-generation-route-plan.md — "the only link is a human
-- downloading a file and uploading it later"), yet it was nested inside a
-- project whose whole shape is script -> scenes -> cut. Picking a video project
-- to hold a standalone image is a question the operator should never be asked.
--
-- 'clip' (0064_project_kind.sql) is the precedent and the argument: /ugc is
-- also project-scoped, also unrelated to the six-step wizard, and got its own
-- kind plus its own route tree at /ugc/<id> rather than a subpath under
-- /projects/<id>. Images are the third console and take the same shape.
--
-- WHY A ROUTE TREE OF ITS OWN MATTERS, and not just a kind. Everything under
-- app/(app)/projects/[id]/ inherits that segment's layout, which renders the
-- Setup -> Scenes -> Cut rail. An image project has no script and no scenes, so
-- it would show locked "compile the script first" placeholders it can never
-- satisfy — a rail that reads as broken rather than as finished. /ugc avoids
-- this by living outside that tree; /images does the same.
--
-- This WIDENS the CHECK. No existing row changes kind, and 'scripted' remains
-- the column default, so every project written before this stays exactly what
-- it was.

alter table projects drop constraint if exists projects_kind_check;
alter table projects
  add constraint projects_kind_check
  check (kind in ('scripted', 'clip', 'image'));

comment on column projects.kind is
  'Which console owns this project. ''scripted'' is the default and every project that predates '
  '0064: the six-step wizard at /projects/<id>. ''clip'' is /ugc/<id> (0064). ''image'' is the '
  'Image Generator at /images/<id> (0084) — a standalone image workspace with no script, no '
  'scenes and no cut, which is why it lives outside the /projects/<id> route tree rather than '
  'inheriting a rail it can never complete. The projects list branches its title link on this '
  'column; a new kind that does not get a branch there opens the wrong screen.';
