-- =============================================================================
-- UGC pipeline — initial schema
--
-- OWNERSHIP CONTRACT (scenes.status)
--
--   web  writes scenes.status: draft -> frame_ready -> queued
--   go   writes scenes.status: queued -> rendering -> done | failed
--
--   web never writes 'rendering'. go never writes 'draft'.
--
-- This is the only column both services write, and it is a disjoint split.
-- Breaking this rule is the first thing a new contributor will break — see
-- docs/architecture.md.
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  role       text not null default 'editor' check (role in ('admin', 'editor')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- prompt_templates — immutable by convention: rows are never updated, only
-- new versions inserted. If output quality drifts, this is how you answer
-- "which template produced this scene".
-- ---------------------------------------------------------------------------
create table prompt_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  version    int not null,
  body       text not null,
  created_at timestamptz not null default now(),
  unique (name, version)
);

comment on table prompt_templates is
  'Immutable by convention: rows are never updated after insert, only new versions inserted. This lets us answer "which template produced this scene" for any historical output.';

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create table projects (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references profiles(id),
  title          text not null,
  script_raw     text,
  character_desc text,
  status         text not null default 'draft'
                   check (status in ('draft', 'briefed', 'framed', 'rendering', 'complete', 'delivered')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on column projects.status is
  'Convenience/cache column. The architecture notes project status is properly *derived* (complete = no scenes queued/rendering, rendering = any scene rendering, framed = all scenes have ref_frame_asset_id) — treat this column as a snapshot, not the source of truth, to avoid drift when a webhook lands mid-deploy.';

-- ---------------------------------------------------------------------------
-- scenes
-- ---------------------------------------------------------------------------
create table scenes (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references projects(id) on delete cascade,
  idx                int not null,
  script_line        text,
  video_prompt       text,
  is_talking_head    boolean not null default false,
  duration_s         numeric not null default 8 check (duration_s > 0 and duration_s <= 8),
  template_id        uuid references prompt_templates(id),
  edited_by_human    boolean not null default false,
  status             text not null default 'draft'
                       check (status in ('draft', 'frame_ready', 'queued', 'rendering', 'done', 'failed')),
  fal_request_id     text,
  submitted_at       timestamptz,
  ref_frame_asset_id uuid,
  created_at         timestamptz not null default now(),
  unique (project_id, idx)
);

comment on column scenes.status is
  'web  writes: draft -> frame_ready -> queued. '
  'go   writes: queued -> rendering -> done | failed. '
  'web never writes ''rendering''. go never writes ''draft''. '
  'This is the only column both services write to; the split above is the entire contract between them.';

comment on column scenes.edited_by_human is
  'Flags any prompt the operator touched. If operators keep fixing the same class of prompt, the template is broken — this column is how you find out.';

-- ---------------------------------------------------------------------------
-- assets
-- ---------------------------------------------------------------------------
create table assets (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  scene_id    uuid references scenes(id) on delete cascade,
  kind        text not null check (kind in ('character_ref', 'product_ref', 'ref_frame', 'clip', 'final')),
  storage_key text not null,
  duration_s  numeric,
  bytes       bigint,
  created_at  timestamptz not null default now()
);

-- Deferred FK: scenes.ref_frame_asset_id -> assets(id).
-- Circular with assets.scene_id -> scenes(id), so it must be added after
-- both tables exist.
alter table scenes
  add constraint scenes_ref_frame_asset_id_fkey
  foreign key (ref_frame_asset_id) references assets(id);

-- ---------------------------------------------------------------------------
-- runs — one row per attempt, not per success. Retries and failures are
-- where the budget actually goes; without this table a month's spend is
-- unexplainable.
-- ---------------------------------------------------------------------------
create table runs (
  id         uuid primary key default gen_random_uuid(),
  scene_id   uuid references scenes(id) on delete cascade,
  vendor     text not null,
  model      text not null,
  cost_usd   numeric(10, 4),
  latency_ms int,
  error      text,
  created_at timestamptz not null default now()
);

comment on table runs is
  'One row per render attempt, not per success. Retries and failures are where the budget actually goes — this is how a month''s spend gets explained.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Dispatch loop hot path: `SELECT ... FROM scenes WHERE status = 'queued'`
-- runs every 30s, and reconcile filters status='rendering' every 2m. Both
-- only ever care about these two states, so a partial index keeps it tiny
-- regardless of how many 'done'/'failed' rows accumulate.
create index scenes_status_active_idx on scenes (status) where status in ('queued', 'rendering');

-- Scene ordering within a project (script order, UI rendering, uniqueness lookups).
create index scenes_project_id_idx_idx on scenes (project_id, idx);

-- Webhook lookup: fal calls back with a request id and we need the owning
-- scene. Unique but nullable — most scenes never had a request submitted.
create unique index scenes_fal_request_id_key on scenes (fal_request_id) where fal_request_id is not null;

-- Reconcile sweep: `WHERE status = 'rendering' AND submitted_at < now() - interval '3 minutes'`.
create index scenes_status_submitted_at_idx on scenes (status, submitted_at);

-- Spend dashboard: cost rollups per scene and time-windowed totals (daily cap check).
create index runs_scene_id_idx on runs (scene_id);
create index runs_created_at_idx on runs (created_at);

-- Project list view: a user's own projects, most recent first.
create index projects_user_id_created_at_idx on projects (user_id, created_at desc);
