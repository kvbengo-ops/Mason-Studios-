-- =============================================================================
-- final_versions.dev — close the assemble half of the shared-queue split
--
-- 0063 partitioned the RENDER queue by MODE: a MODE=development web app writes
-- scenes.dev = true, and a worker claims, counts and reconciles only rows
-- matching its own mode, so a dev worker and a production worker can poll one
-- table without ever touching each other's work.
--
-- The ASSEMBLE queue was left open. ClaimPendingFinalVersions selects any
-- unclaimed final_versions row whose scenes are all terminal, with no mode
-- predicate at all — so a dev worker could claim a production project's
-- final build, run ffmpeg against real clips, and write a real final asset;
-- and a production worker could just as easily claim a developer's. It is the
-- same race 0063 closed, one step further down the pipeline, and it was
-- missed because that step spends no vendor money — the cost is a wrong
-- artifact delivered to a customer rather than a wrong bill.
--
-- A column rather than a join through scenes, deliberately. The scenes of one
-- project could in principle carry mixed dev values (a developer pointing a
-- local app at a real project's row), and a predicate that has to reason about
-- "mostly dev" is a predicate that will be read wrong later. final_versions is
-- inserted by the web app (actions/deliver.ts) exactly like a queued scene is,
-- so it can state its own mode outright.
--
-- DEFAULT false is the safe direction and matches 0063's reasoning: every row
-- that already exists was written by production, and a production worker
-- asking for dev = false still finds all of them. The failure mode of getting
-- it backwards would be a dev worker inheriting the entire existing backlog.
-- =============================================================================

alter table final_versions
  add column dev boolean not null default false;

comment on column final_versions.dev is
  'Which MODE asked for this build: true for MODE=development, false (the default, and every '
  'pre-existing row) for MODE=production. ClaimPendingFinalVersions filters on it so a dev '
  'worker cannot assemble a production project''s final video — the assemble-side half of '
  '0063_scenes_dev_flag.sql''s render-side split.';

-- Mirrors 0063's shape: partial, over exactly the rows the claim query scans.
-- ClaimPendingFinalVersions only ever looks at unclaimed, unbuilt, unfailed
-- rows, so the index carries only those and stays small no matter how much
-- history accumulates.
create index final_versions_dev_pending_idx
  on final_versions (dev, created_at)
  where built_at is null and failed_at is null and claimed_at is null;
