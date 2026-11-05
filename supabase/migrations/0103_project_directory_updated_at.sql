-- =============================================================================
-- project_directory — expose the project's own update timestamp to /projects.
--
-- The directory remains the one relation that supplies every project field
-- needed before paging/sorting. `updated_at` is appended (never inserted):
-- PostgreSQL's create-or-replace-view contract rejects a reordered existing
-- output list. This is deliberately the project row's timestamp: the UI's
-- "Updated" value means project edits, not render activity. Go updates
-- scenes.status and does not update projects.
--
-- No status derivation lives here. project_directory.status remains the raw
-- stored value and web/lib/project-status.ts remains the sole current-status
-- derivation.
-- =============================================================================

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
  p.kind,
  p.updated_at
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
  'computed in SQL so /projects can ORDER BY them before LIMIT/OFFSET. security_invoker preserves '
  'the caller''s projects/scenes/runs RLS scope. status is the raw stored fossil, not a SQL re-derivation '
  'of web/lib/project-status.ts. updated_at is the project row''s last edit/update timestamp only; scene '
  'renders do not update it, so it is not a general worker activity timestamp.';
