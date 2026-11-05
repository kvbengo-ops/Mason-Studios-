-- =============================================================================
-- projects.status — stop reading it as the source of truth
--
-- 0001_init.sql's column comment already said this column was a
-- "convenience/cache" and that project status was "properly *derived*" from
-- scenes. That was aspirational, not descriptive: every reader in web/ (the
-- projects list, the step rail, the render redirect) read this column
-- directly, and nothing ever computed the documented derivation. AGENTS.md
-- went further and claimed status was "derived, never stored" outright,
-- which was flatly false — actions/compile.ts, actions/brief.ts and
-- actions/enqueue.ts write 'briefed'/'framed'/'rendering' to this column on
-- every transition.
--
-- The concrete bug that exposed this: nothing writes 'complete'. A project
-- whose scenes have all finished (or failed) sits at 'rendering' in this
-- column forever — the projects list showed it as still running until an
-- operator manually clicked Mark delivered, which is the only other writer.
-- Adding a fifth writer to cover 'complete' would still leave the same
-- structural problem (N writers that must all agree, forever), so instead of
-- patching in a 'complete' write, web/lib/project-status.ts's
-- deriveProjectStatus() now computes status from `scenes` on every read
-- (actions/guard.ts's requireProject embeds scenes and derives once per
-- request; the projects list embeds scenes for the same reason so deriving
-- N projects stays one query, not N+1).
--
-- 'delivered' is the one value in this column still trusted as-is. It is a
-- human act (actions/deliver.ts markDelivered) — no combination of scene
-- statuses means "an operator clicked Mark delivered" — so it is the one
-- genuinely stored fact and everything else is computed around it.
--
-- The column is NOT dropped. actions/compile.ts and actions/enqueue.ts still
-- write 'briefed'/'framed'/'rendering' to it (actions/brief.ts's approveBrief
-- writes 'framed' too) — those writes are now pure cache/debugging fossils,
-- inert because nothing reads them back as truth, and are left in place
-- rather than torn out across three files for a column that costs nothing to
-- keep. If a value here ever needs to be trusted again, deriveProjectStatus
-- is the one place that decision would have to move.
-- =============================================================================

comment on column projects.status is
  'Cache/fossil column, NOT the source of truth. Only ''delivered'' is ever read as fact '
  '(it is a human act — actions/deliver.ts markDelivered — with no scene-derived '
  'equivalent). Every other value is written by actions/compile.ts, actions/brief.ts and '
  'actions/enqueue.ts on each transition but is stale the moment scenes.status changes '
  'underneath it (e.g. it never reaches ''complete'' — nothing writes that). '
  'web/lib/project-status.ts deriveProjectStatus() is the real status for every other '
  'value: complete = no scenes queued/rendering (but at least one has left '
  'draft/frame_ready), rendering = any scene queued or rendering, framed = all scenes '
  'have ref_frame_asset_id, draft = no scenes yet. See 0018_derived_project_status.sql.';
