-- =============================================================================
-- A deleted scene must not take its spend out of the project's own totals.
--
-- `runs.scene_id` has been `references scenes(id) on delete cascade` since
-- 0001_init.sql, which makes billed history a CHILD of the scene: delete the
-- scene and every attempt charged to it is destroyed. 0038_preserve_cost_
-- history_on_delete.sql caught that and copies the rows into
-- deleted_project_cost_history one step ahead of the cascade, and 0040_
-- include_archived_cost_in_spend_reads.sql taught six reads to UNION ALL
-- that archive back in.
--
-- Six. Not the per-PROJECT ones:
--
--   * project_cost_totals (view, 0026, redefined by 0030) — the /projects
--     list's cost column. Named in 0038's header AND in 0040's header as a
--     read that needs the archive, and then not touched by either.
--   * web/lib/db-aggregates.ts's getProjectSpend — the Deliver page's
--     "Spend to date" and the per-scene "already spent on the clip being
--     discarded" label. A plain `select from runs`, written after 0040, so
--     it was never on anybody's list at all.
--
-- Both are read through the OWNER's session client, and
-- deleted_project_cost_history is admin-select-only (0038), so no UNION ALL
-- could have fixed them without also widening that table's RLS. The result
-- an operator sees: they generate a reference frame, regenerate it three
-- times, delete the scene — and the Deliver page's spend figure silently
-- drops back to only what survived to a delivered clip, while /spend and
-- the daily/weekly caps (which go through createAdminClient, so they DO see
-- the archive) still count every dollar.
--
-- ---------------------------------------------------------------------------
-- The fix: stop destroying the row in the first place
-- ---------------------------------------------------------------------------
-- ON DELETE SET NULL, not another union. `runs.scene_id` is already
-- nullable and already a designed case — a full-script compile, a character
-- reference, a composite all carry scene_id NULL (0001_init.sql;
-- web/lib/runs.ts's RunRecord.sceneId), and every reader already handles it:
-- getProjectSpend counts a scene-less run in totalUsd and skips it in
-- bySceneId, which is exactly right for a scene that no longer exists.
-- runs.project_id (0030) is what keeps the row attached to the project, and
-- runs_select's RLS has keyed on project_id, not scene_id, since 0030 too.
--
-- So no query anywhere changes. The run stays in `runs`, keeps its dollars
-- in every live-branch sum, and loses only the per-scene attribution that
-- stopped being meaningful when the scene went away.
--
-- Referential actions run as the constraint's table owner and are exempt
-- from RLS (no `force row level security` on runs), so the SET NULL update
-- is not subject to runs_update / 0053's is_active() gate — an ordinary
-- owner deleting their own scene is unaffected.
-- =============================================================================

alter table runs drop constraint runs_scene_id_fkey;

-- No `if exists` above on purpose: if 0001's inline column reference ever
-- got a different name, a silent no-op would leave the old CASCADE in place
-- alongside the new constraint and the cascade would still win. Fail loudly.
alter table runs
  add constraint runs_scene_id_fkey
  foreign key (scene_id) references scenes(id) on delete set null;

-- ---------------------------------------------------------------------------
-- The scene archive trigger has to go with it
-- ---------------------------------------------------------------------------
-- Not tidying: leaving it would DOUBLE-COUNT. 0040's "why no union below can
-- ever double-count a run" rests entirely on the triggers being BEFORE
-- DELETE on a row the same transaction then destroys — "a given run_id is in
-- exactly one of the two tables, never both." With SET NULL the scene delete
-- no longer destroys the run, so this trigger would archive a row that is
-- still live, and all six of 0040's unions would count it twice.
--
-- Project deletes are unaffected: projects_archive_cost_history is a
-- separate BEFORE DELETE trigger whose WHERE already covers every run via
-- `or r.project_id = $1` (0040), so it archives scene-owned runs too, and
-- the runs.project_id cascade (0030) still destroys them. The archive keeps
-- doing the one job it still has.
drop trigger scenes_archive_cost_history on scenes;
drop function public.archive_scene_cost_history();

comment on table deleted_project_cost_history is
  'Spend history rescued from ON DELETE CASCADE when a PROJECT is deleted. Every runs row reachable '
  'from the project is copied here by projects_archive_cost_history (BEFORE DELETE) one step ahead '
  'of the cascade that is about to destroy it (0001_init.sql''s cascades, 0030''s runs.project_id; '
  'web/actions/project.ts deleteProject). Scene deletes no longer archive anything: since '
  '0054_runs_survive_scene_delete.sql runs.scene_id is ON DELETE SET NULL, so the run survives in '
  '`runs` and stays in every live-branch sum — archiving it too would double-count it against '
  '0040''s unions. Rows written by the old scenes trigger are still here and still correct. '
  'Deliberately has NO foreign keys to projects/scenes/runs: the rows it preserves are precisely '
  'the ones whose parents are being deleted in the same transaction, so an FK would either reject '
  'the insert or cascade-wipe the archive itself. project_id/scene_id are bare uuids that are '
  'EXPECTED to dangle; project_title, owner_email and user_id are snapshots taken while the project '
  'still existed.';
