-- =============================================================================
-- runs.inference_ms — fal's own generation time, distinct from latency_ms
--
-- runs.latency_ms has never measured what its name implies. It is computed
-- in worker/internal/ingest/ingest.go as time.Since(scene.submitted_at) at
-- the moment THIS worker notices a render is done — via the fal webhook if
-- it arrives, or via the reconcile loop's poll if it doesn't. Checked
-- against the live database, every clip we have ever rendered shows
-- submit-to-clip of 232-299 seconds. That looked like "fal is slow" until
-- the actual latency_ms values were compared across scenes rendered in the
-- same batch: 299999/299999, 270127/270125, 210070/210069 — independently
-- generated clips landing within a couple of milliseconds of each other.
-- Generation time cannot do that; a shared polling cadence can. The
-- reconcile loop's staleAfter/tick (worker/internal/loop/reconcile.go) were
-- 3 minutes and 2 minutes respectively, so a webhook loss meant "notice"
-- was delayed by up to that whole window regardless of how long fal had
-- actually taken — which is exactly the shape of the clustering above.
--
-- So latency_ms has been quietly measuring US, not fal. Queried live
-- against fal's own queue status endpoint for a completed request
-- (GET .../requests/{id}/status), fal reports:
--
--   {"status":"COMPLETED", ..., "metrics":{"inference_time":79.559...}}
--
-- ~80 seconds of real inference time behind a latency_ms of 200-300
-- seconds for the same render. That gap is reconcile's old polling cadence,
-- not fal working. inference_ms is fal's own number, captured by
-- fal.Client.Result (worker/internal/fal/client.go) at ingest time and
-- carried through unchanged, so the two numbers stay legible as what they
-- actually are: inference_ms is what fal spent; latency_ms is how long we
-- took to find out. Overloading latency_ms with fal's number (or fal's
-- number with ours) would erase that distinction the next time someone
-- needs to tell "fal is slow" apart from "our polling is slow" — which is
-- the exact confusion that produced this migration.
--
-- Nullable, no backfill: it does not exist for historical rows (fal's
-- metrics field was never captured before now), and it will be absent
-- going forward too whenever the metrics fetch itself fails or a render
-- was simulated by MOCK_FAL — see fal.Client.fetchInferenceMS and
-- mockResult's doc comments. A run row missing this is "we don't know",
-- not "zero".
-- =============================================================================

alter table runs
  add column if not exists inference_ms int;

comment on column runs.inference_ms is
  'fal''s own metrics.inference_time (ms), from the queue status endpoint. Distinct from '
  'latency_ms, which is this worker''s submit-to-detection time and is dominated by '
  'polling cadence, not fal''s work — see 0016 for the live numbers that proved it.';
