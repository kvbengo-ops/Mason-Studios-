-- =============================================================================
-- project_directory (view) — makes the /projects list's Product, Owner,
-- Scenes, Created and Cost to date columns sortable server-side
-- (web/app/(app)/projects/page.tsx).
--
-- ---------------------------------------------------------------------------
-- The problem this exists to avoid
-- ---------------------------------------------------------------------------
-- Same shape of bug 0028_user_directory.sql's own header describes for
-- /users, applied to /projects: the list pages through `projects` with
-- `.range()`, embeds `scenes` for the per-row scene count, and fetches
-- per-project cost separately from project_cost_totals (0026) for only the
-- ids already on that one page. That is the right shape for DISPLAYING an
-- aggregate next to a page of projects — bounded, no per-row round trip —
-- and the WRONG shape for SORTING by one: the page of projects is already
-- decided (by created_at DESC) before either aggregate is fetched, so
-- "sort by cost to date" built on top of that sequence could only reorder
-- the 20 rows already on screen. This view puts scene count and cost in the
-- SAME relation as the ORDER BY + LIMIT/OFFSET, so Postgres picks the
-- correct 20 rows out of the full project set under any sortable column,
-- not just the ones that already lived on `projects`.
--
-- ---------------------------------------------------------------------------
-- Status is deliberately NOT a sortable column here
-- ---------------------------------------------------------------------------
-- `projects.status` (this view's `status` column, passed through unchanged)
-- is the fossil 0018_derived_project_status.sql's own header describes: it
-- is written forward-only by four call sites in web/actions/ and nothing
-- ever writes 'complete' to it, so it lags the real status for a large
-- fraction of rows. The real status comes from
-- web/lib/project-status.ts's deriveProjectStatus(), computed from a
-- project's scene statuses (and, for 'delivered' only, this same fossil
-- column read as the one genuinely stored fact — see that function's doc
-- comment).
--
-- Re-deriving that function's logic a second time in SQL so `status` could
-- be ORDER BY-able was considered and rejected. deriveProjectStatus is not
-- a lookup table — it is a sequence of scene-set predicates
-- (scenes.length === 0; some scene queued/rendering; every scene has left
-- draft/frame_ready per lib/editable-guard.ts's isEditable; every scene has
-- a ref_frame_asset_id) evaluated in priority order, plus one sticky fact
-- read from this same fossil column. Encoding that as a second CASE
-- expression here would mean two independent copies of one derivation,
-- with no automated check that they agree (this migration is deliberately
-- not applied — see below — so nothing would even run the SQL copy to find
-- out) and a documented history of exactly this drift: 0018's own column
-- comment still describes 'complete' with the ORIGINAL "some scene has left
-- draft/frame_ready" wording; deriveProjectStatus's doc comment explains at
-- length why that reading was wrong and had to become "every scene" instead
-- (unfreezeScene, actions/brief.ts, can put one previously-'done' scene back
-- to 'frame_ready' while its siblings stay 'done' — the old "some" check
-- read that exact mix as 'complete' and routed an operator straight to
-- /deliver for a clip whose 'final' asset had just been deleted out from
-- under it). A comment sitting three migrations away from the code it
-- describes already fell out of sync once, silently, with no compiler or
-- test to catch it; a second SQL implementation of the same function is the
-- same failure mode with higher stakes, since it would additionally have to
-- track lib/editable-guard.ts's EDITABLE_STATUSES list to stay correct.
--
-- So /projects' Status header renders with no sort control at all — every
-- other column here is sortable, Status plainly isn't. web/lib/
-- project-status.ts stays the single place deriveProjectStatus is computed,
-- unchanged by this migration; the page still fetches each page's scenes
-- separately (see page.tsx) to derive the badge exactly as it does today.
--
-- ---------------------------------------------------------------------------
-- LEFT JOIN + COALESCE, not the sibling views' "absence means zero" contract
-- ---------------------------------------------------------------------------
-- project_cost_totals (0026) intentionally has NO row for a project with no
-- runs — a plain inner join, documented there as "callers read a missing
-- project_id as $0, not as an error." That contract is correct for ITS
-- caller (getProjectCostTotals), which already has the full page of
-- projects from somewhere else and is only filling in one column.
--
-- It would be exactly the bug this view exists to fix if repeated here: a
-- draft project with zero scenes and zero spend is precisely the row an
-- admin sorting Scenes or Cost to date ascending is looking for, and an
-- inner join (or an un-COALESCEd LEFT join) would either drop it from the
-- result entirely or leave scene_count/total_cost_usd NULL, which sorts
-- before or after every real number depending on NULLS FIRST/LAST and
-- answers a question nobody asked. This view LEFT JOINs both aggregates
-- from `projects` (so every project is present regardless of activity) and
-- COALESCEs each to 0, the same fix 0028_user_directory.sql made for
-- /users' Projects/Spend columns, for the same reason.
--
-- The two subqueries below duplicate project_cost_totals'/the scenes
-- embed's own GROUP BY logic rather than selecting from that view, to keep
-- this view a single self-contained query plan — same call 0028 made over
-- 0026/0027, for the same "one less thing to trace" reason given there.
--
-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- `with (security_invoker = true)` for the same reason 0026's, 0027's and
-- 0028's views needed it (Postgres 15+ — supabase/config.toml pins
-- major_version = 15): a view defaults to running with its OWNER's
-- privileges, not the querying role's. /projects reads through the session
-- client (web/lib/supabase/server.ts's createClient(), never
-- createAdminClient()), so without security_invoker this view would ignore
-- RLS and hand back every user's projects to whoever queries it.
-- security_invoker re-checks projects_select / scenes_select / runs_select
-- (0002_rls.sql) against the actual calling role on every query: an editor
-- sees only their own projects (and, transitively, only their own scenes'
-- and runs' contribution to scene_count/total_cost_usd), an admin sees
-- every project, exactly the scoping /projects' own page.tsx comment
-- already relies on for the query it's replacing. profiles is a plain LEFT
-- JOIN (not COALESCEd — email has no zero value) so a project whose owner
-- profile is somehow missing still returns a row with a null owner_email,
-- which the page already renders as "—" the same way it does today for
-- `project.profiles?.email ?? "—"`.
--
-- No new grants needed — 0007_grants.sql's `alter default privileges ...
-- grant ... on tables to authenticated` already covers anything this
-- migration's role creates, the same fact 0026's, 0027's and 0028's headers
-- leaned on before it.
--
-- Per this task's constraints, this migration is written but deliberately
-- NOT applied. web/types/db.ts is hand-patched to describe this view's
-- shape ahead of that application — see that file's own header for the
-- general policy on hand-patching, and this view's entry there for the
-- exact patch.
-- =============================================================================

create view project_directory
with (security_invoker = true) as
select
  p.id,
  p.title,
  p.product_name,
  p.status,
  p.created_at,
  p.user_id,
  prof.email as owner_email,
  coalesce(sc.scene_count, 0) as scene_count,
  coalesce(cost.total_cost_usd, 0) as total_cost_usd
from projects p
left join profiles prof on prof.id = p.user_id
left join (
  select project_id, count(*) as scene_count
  from scenes
  group by project_id
) sc on sc.project_id = p.id
left join (
  select s.project_id, coalesce(sum(r.cost_usd), 0) as total_cost_usd
  from scenes s
  join runs r on r.scene_id = s.id
  group by s.project_id
) cost on cost.project_id = p.id;

comment on view project_directory is
  'projects LEFT JOINed to owner email, per-project scene count and all-time cost, both aggregates '
  'computed in SQL, so the /projects list can ORDER BY an aggregate that lives in a different '
  'relation without first fetching a page of projects and reordering only what happened to be on it '
  '— see this migration''s header. LEFT JOIN + COALESCE(...,0), NOT the inner-join "absence means '
  'zero, no row" contract project_cost_totals uses standalone: a project with zero scenes and zero '
  'spend MUST still appear as a 0/$0 row here, or ORDER BY scene_count/total_cost_usd would silently '
  'drop exactly the rows an admin most wants to find. `status` is passed through UNCHANGED (the raw '
  'fossil column, not a SQL re-derivation of web/lib/project-status.ts''s deriveProjectStatus) — see '
  'this migration''s header for why /projects deliberately does not offer a Status sort control.';
