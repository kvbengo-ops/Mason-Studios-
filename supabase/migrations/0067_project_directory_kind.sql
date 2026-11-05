-- =============================================================================
-- project_directory (0029, re-created 0030) — carry projects.kind through.
--
-- 0064_project_kind.sql added projects.kind so the /projects list's title
-- link could finally tell a scripted project from a clip one apart —
-- 'clip' -> /ugc/<id>, 'scripted' -> /projects/<id> — instead of the one
-- route that used to be hard-coded for every row. But the title link
-- (components/projects-table.tsx) reads its rows from THIS view, not from
-- `projects` directly (see 0029's header: the view exists so /projects can
-- ORDER BY an aggregate that lives in a different relation), and 0064 never
-- touched it. Without this column here, the page has no way to know which
-- route a given row wants — the exact defect 0064's own header describes,
-- just one hop further down.
--
-- Appended as the LAST column, not inserted alongside the other `p.*`
-- columns above it: `create or replace view` cannot rename or reorder
-- existing columns (SQLSTATE 42P16 — see 0030's project_directory
-- re-creation, which hit this once already), only add new ones at the end.
-- Every other column is otherwise byte-for-byte what 0030 left behind.
create or replace view project_directory
with (security_invoker = true) as
select
  p.id,
  p.title,
  p.product_name,
  p.status,
  p.created_at,
  p.user_id,
  prof.email as owner_email,
  coalesce(scene_counts.scene_count, 0) as scene_count,
  coalesce(cost.total_cost_usd, 0) as total_cost_usd,
  p.kind
from projects p
left join profiles prof on prof.id = p.user_id
left join (
  select project_id, count(*) as scene_count
  from scenes
  group by project_id
) scene_counts on scene_counts.project_id = p.id
left join (
  select r.project_id, coalesce(sum(r.cost_usd), 0) as total_cost_usd
  from runs r
  group by r.project_id
) cost on cost.project_id = p.id;

comment on view project_directory is
  'projects LEFT JOINed to owner email, per-project scene count and all-time cost, both aggregates '
  'computed in SQL, so the /projects list can ORDER BY an aggregate that lives in a different '
  'relation without first fetching a page of projects and reordering only what happened to be on it '
  '— see 0029_project_directory.sql''s header. LEFT JOIN + COALESCE(...,0) for scene_count/'
  'total_cost_usd, NOT the sibling project_cost_totals view''s "absence means zero, no row" contract: '
  'a project with zero scenes and zero spend MUST still appear as a 0/$0 row here, or ORDER BY '
  'scene_count/total_cost_usd would silently drop exactly the rows an admin most wants to find. '
  '`status` is passed through UNCHANGED (the raw fossil column, not a SQL re-derivation of '
  'web/lib/project-status.ts''s deriveProjectStatus) — see 0029''s header for why /projects '
  'deliberately does not offer a Status sort control. `kind` (0064_project_kind.sql) is the column '
  'the title link branches on — see this migration''s header.';
