-- =============================================================================
-- assets.built_from_cut_order_at — the projects.cut_order_updated_at value
-- the worker actually saw when it read the clips a `final` asset was
-- concatenated from, so getCutStatus (web/actions/deliver.ts) can tell a
-- `final` apart from a cut order that moved DURING assembly, not just
-- before it.
-- =============================================================================
-- The bug: getCutStatus compared projects.cut_order_updated_at against the
-- `final` asset's created_at (assets.created_at, 0001_init.sql) — "was
-- there a reorder after this file was written". That is wrong when a
-- reorder lands WHILE assembly is running:
--
--   T0  operator reorders            cut_order_updated_at = T0
--   T1  operator clicks Assemble     final deleted (reassembleProject)
--   T2  worker's loop picks it up    reads clips ORDER BY s.idx  -> order A
--   T3  operator reorders AGAIN      cut_order_updated_at = T3
--   T4  worker finishes concat       final inserted, created_at = T4
--
-- At T4, T3 <= T4, so the old comparison reports "current" — but the video
-- was built from the order read at T2, which does not include the T3
-- reorder. created_at answers "when was this file written", not "what
-- order was it built from"; those diverge exactly when a second reorder
-- overlaps assembly (worker/internal/loop/assemble.go's assembleProject,
-- worker/internal/store/store.go's SceneClipsForProject). Nothing blocks
-- that second reorder either: web/actions/deliver.ts's reorderCut only
-- requires every scene to be terminal, which stays true throughout
-- assembly.
--
-- The fix: stamp the input, not the output. The worker reads
-- projects.cut_order_updated_at in the SAME query it reads the clips with
-- (SceneClipsForProject) — a separate read would just reopen a smaller
-- version of the identical race between the two queries — and carries
-- that value through to InsertFinalAsset, which writes it here.
-- getCutStatus then compares the project's CURRENT cut_order_updated_at
-- against this column instead of against created_at: "did the order
-- change after the value this final was built from", not "after the file
-- was written".
--
-- Nullable, no default: every `final` asset that exists before this
-- migration ships predates this column and was never stamped, so it is
-- unconditionally null. Chosen meaning: null = "unknown, treat as
-- current" — the same reading getCutStatus already gives a null
-- projects.cut_order_updated_at (0039_cut_order.sql: "there is no reorder
-- event to be stale against"). The alternative, treating null as
-- always-stale, would flag every pre-existing `final` asset as stale
-- simultaneously on deploy day, for projects where nothing actually
-- changed — a false alarm at 100% of existing projects, not a fix.
--
-- =============================================================================
-- Grants/RLS check (verified, not assumed, per this migration's own
-- instructions — same check 0034/0039/0041 each ran and documented)
-- =============================================================================
-- No new grant or policy needed:
--   - 0007_grants.sql's `alter default privileges ... grant select, insert,
--     update, delete on tables to authenticated` was issued once, at the
--     TABLE level, before this column existed, and is not re-evaluated per
--     column — a plain `alter table ... add column` on an already-granted
--     table needs nothing further from that file.
--   - assets has no owner-scoped RLS policy of its own to worry about
--     column-by-column (checked 0002_rls.sql and every later RLS
--     migration: `assets` rows are reached through the owning project, not
--     policied directly), and every write in this codebase goes through
--     either the Go worker's service-role Postgres connection or
--     web/actions/*'s createAdminClient() (service_role, bypasses RLS per
--     0007's header), so this column is reachable in production
--     regardless.
alter table assets
  add column built_from_cut_order_at timestamptz;

comment on column assets.built_from_cut_order_at is
  'For kind=''final'' only: the projects.cut_order_updated_at value the worker read in the same '
  'query as the clips (worker/internal/store/store.go''s SceneClipsForProject) when it built this '
  'asset — NOT when this row was inserted (see assets.created_at) and not a live/updated value, a '
  'one-time snapshot of the input the concat was built from. Lets getCutStatus '
  '(web/actions/deliver.ts) catch a reorder that lands WHILE assembly is running, which a '
  'comparison against created_at cannot: see this migration''s header for the race. Null for every '
  'final predating this column, and for any kind other than ''final''; treated as "unknown, treat '
  'as current" by getCutStatus, matching how a null projects.cut_order_updated_at is already '
  'treated.';
-- =============================================================================
