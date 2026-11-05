-- =============================================================================
-- Enable Realtime replication for `scenes`.
--
-- render-progress.tsx subscribes to `postgres_changes` UPDATE events on this
-- table, filtered by `project_id=eq.<id>`, to drive the render screen
-- (docs/architecture.md § "User flow" step 8: "Watch — Realtime progress,
-- per-scene retry"). `scenes.status` is the column the Go worker writes as
-- it dispatches/completes/fails clips — this is the only way the web app
-- observes that progress, since it never talks to the worker directly.
-- =============================================================================

alter publication supabase_realtime add table scenes;

-- Postgres' logical replication only includes the primary key columns in an
-- UPDATE's old-row payload by default. The Realtime filter above matches on
-- `project_id`, so without full replica identity a row whose `project_id`
-- isn't part of the primary key would not reliably match the filter on
-- every change.
alter table scenes replica identity full;
