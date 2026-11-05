-- =============================================================================
-- 0095 — an image attempt can name the image it produced
-- =============================================================================
--
-- THE PROBLEM THIS SOLVES. An operator who leaves /image-generator mid-generation
-- loses everything the browser was holding: the spinner, the preview, and any
-- idea of whether the request is still running, finished, or failed. The charge
-- is real either way. Coming back, there was no server-side way to answer "what
-- happened to that?", because the attempt (`runs`) and the picture (`assets`)
-- had no link between them in either direction — actions/image-generator.ts's
-- ALREADY_COMPLETED_MESSAGE says so in as many words, and calls the link a v2
-- option. This is that v2.
--
-- NO STATUS COLUMN, DELIBERATELY. The five states the recovery UI distinguishes
-- — queued, generating, completed, failed, billing_unknown — are already fully
-- determined by columns this table has:
--
--   settled_at is null, kie_task_id is null   reserved, not yet submitted
--   settled_at is null, kie_task_id is not null   submitted, still drawing
--   settled_at, error is null                 completed
--   settled_at, error like 'billing-unknown:%'    billing unknown
--   settled_at, any other error               failed
--
-- A stored status would be a sixth fact that has to agree with the five, and
-- AGENTS.md already names the failure mode: project status is derived from
-- scenes on every read because storing it drifts. Same rule, same reason. The
-- derivation lives in one function, web/lib/image-attempt.ts, and every reader
-- goes through it.
--
-- What genuinely could not be derived is WHICH IMAGE an attempt produced, so
-- that is the one thing this migration adds.

alter table runs add column if not exists asset_id uuid references assets(id) on delete set null;

comment on column runs.asset_id is
  'The image this attempt produced, for the Image Generator''s recovery flow (0095). NULL for '
  'every attempt that has not succeeded, and for every writer that is not the Image Generator. '
  'ON DELETE SET NULL, never cascade: deleting a picture must not delete the record of what it '
  'cost. The charge outlives the file, exactly as 0054 made a run outlive its scene.';

-- No index. Every reader reaches this column by run id or through the existing
-- runs_user_id_created_at_idx (0085); nothing looks an attempt up BY asset.
