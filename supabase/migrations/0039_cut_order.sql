-- =============================================================================
-- projects.cut_order_updated_at — when the SCENE ORDER (not the project row
-- in general) last changed, so a `final` asset can be told apart from a cut
-- order that has since moved on.
-- =============================================================================
-- The problem: scenes has created_at (0001_init.sql) but no updated_at, so
-- there is no column anywhere that answers "did the operator reorder scenes
-- after this project's `final` asset was assembled?" web/actions/deliver.ts's
-- hasFinalAsset only answers "does a final asset exist yet", not whether it
-- still reflects the current cut — worker/internal/store/store.go's
-- ProjectsReadyToAssemble runs the assemble loop exactly once per project
-- (every scene terminal, at least one done, and NOT EXISTS a `final` asset),
-- so once a `final` exists the loop will never look at this project again on
-- its own. Re-running it is entirely a matter of deleting that `final` row
-- (and its Storage object) — see web/actions/deliver.ts's reassembleProject
-- — but knowing WHETHER to offer that action at all requires comparing two
-- timestamps: this column, and the `final` asset's own `created_at`
-- (assets.created_at, 0001_init.sql).
--
-- Deliberately a NEW column, not a reuse of projects.updated_at: that column
-- is touched by markDelivered/reopenProject and every plain field edit
-- (actions/character.ts's saveCharacterSetup, actions/project.ts's
-- updateProject) — a title-only rename bumps it today. If staleness were
-- computed against updated_at, renaming a delivered project (saveCharacterSetup
-- explicitly allows a title-only write even when locked) would make an
-- up-to-date `final` read as stale for a reason that has nothing to do with
-- scene order. cut_order_updated_at is stamped ONLY by the one write that
-- actually changes what "scene N" means — web/actions/brief.ts's
-- reorderScenes — so it stays null (never stale) for a project whose scenes
-- have never been reordered, and only moves forward when the order itself
-- moves.
--
-- Nullable, no default: null means "this project's cut order has never been
-- explicitly reordered since it was created" — the common case, since
-- reorderScenes has no UI caller yet (see reorderScenes's own doc comment)
-- and every project's scenes sit in the order the compiler produced them in.
-- A null value is treated as "not stale" by the staleness read (whatever
-- final asset exists, if any, is trusted) rather than "always stale" —
-- there is no reorder event to be stale against.
--
-- =============================================================================
-- Grants/RLS check (per this migration's own instructions: verify, don't
-- assume)
-- =============================================================================
-- Confirmed no new grant or policy is needed:
--   - 0007_grants.sql's `alter default privileges ... grant select, insert,
--     update, delete on tables to authenticated` was issued once, at the
--     TABLE level, before this column existed; it is not re-evaluated per
--     column, so a plain `alter table ... add column` on an already-granted
--     table needs nothing further from that file.
--   - 0002_rls.sql's `projects_update_own` policy
--     (`using (user_id = auth.uid()) with check (user_id = auth.uid())`) is
--     also not column-scoped — an owner who may UPDATE the row at all may
--     set any column on it, this one included. No new policy is needed for
--     the same reason 0034_profile_avatar.sql's new profiles.avatar_storage_key
--     column needed none.
--   - In practice every write in web/actions/ goes through
--     createAdminClient() (service_role, which bypasses RLS entirely per
--     0007's own header) once requireProject has already checked ownership
--     in code, so this column is reachable in production regardless — the
--     check above is about not leaving a session-client path silently
--     broken, not about unblocking the real write path.
alter table projects
  add column cut_order_updated_at timestamptz;

comment on column projects.cut_order_updated_at is
  'When scenes.idx was last rewritten by a reorder (web/actions/brief.ts''s reorderScenes), NOT '
  'when the project row was last touched in general (see this migration''s header for why that '
  'rules out reusing projects.updated_at). Null means the cut order has never been explicitly '
  'reordered. Compared against the project''s `final` asset''s built_from_cut_order_at '
  '(assets.built_from_cut_order_at, 0042_final_built_from_cut_order.sql) — the cut order the '
  'worker actually read when it built that final — NOT against the final''s created_at, which '
  'cannot tell a `final` apart from a reorder that landed WHILE assembly was still running; see '
  '0042''s header for that race and web/actions/deliver.ts for the staleness read that makes this '
  'comparison.';
