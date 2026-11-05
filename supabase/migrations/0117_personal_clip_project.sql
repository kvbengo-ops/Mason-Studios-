-- One hidden clip project per account, for /create's Video tab.
--
-- A clip is a scene and a scene needs a project, but /create makes videos with
-- no project step. Each account gets ONE personal clip project, found or made
-- the first time they generate, and every Video-tab clip is queued into it.
-- The worker, the spend caps and runs all keep working because it is a real
-- project underneath.
--
-- A MARKER COLUMN, NEVER THE TITLE. Matching on a title like "UGC clips" was
-- tried once for /ugc and made one operator's strip swallow their whole
-- history (see actions/ugc.ts createClipProject). is_personal is the key, and
-- the partial unique index below is what makes "find or create" race-safe: two
-- first presses cannot both insert.

alter table projects
  add column if not exists is_personal boolean not null default false;

create unique index if not exists projects_one_personal_per_user
  on projects (user_id)
  where is_personal;

-- /projects lists project_directory; a hidden project must not appear there.
-- Appended last — CREATE OR REPLACE VIEW may only add columns at the end — and
-- the page filters on it.
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
  p.updated_at,
  p.is_personal
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

comment on column projects.is_personal is
  'True for the one hidden clip project /create queues Video-tab clips into. At most one per user '
  '(projects_one_personal_per_user); hidden from /projects via project_directory.is_personal.';
