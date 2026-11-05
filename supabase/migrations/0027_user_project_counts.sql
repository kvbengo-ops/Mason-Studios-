-- =============================================================================
-- user_project_counts (view) — fixes the per-row project count on the new
-- /users admin page (web/app/(app)/users/page.tsx).
--
-- Why a view instead of a per-row count in the page itself: the naive
-- version of "how many projects does this user have" is one
-- `.from("projects").select("id", { count: "exact", head: true }).eq("user_id", ...)`
-- per row rendered. That's fine for a single profile page, but /users lists
-- every user a page at a time (see lib/pagination.ts — same PAGE_SIZE-bounded
-- shape as /projects and /library) — N rows on screen means N round trips to
-- Postgres just to fill in one integer column, scaling with page size instead
-- of being O(1) per page load. This view does the same thing
-- project_cost_totals (0026_cost_aggregates.sql) already does for per-project
-- run cost: SUM/COUNT + GROUP BY once in Postgres, then one `.in("user_id",
-- ids)` scoped to only the user ids already on the current page — see
-- web/lib/db-aggregates.ts's getProjectCostTotals for the exact shape this
-- follows (and the new getUserProjectCounts this migration's counterpart
-- lands next to it).
--
-- `with (security_invoker = true)` for the same reason 0026's view needed it
-- (Postgres 15+ — supabase/config.toml pins major_version = 15): a view
-- defaults to running with its OWNER's privileges, not the querying role's.
-- /users reads through the session client (web/lib/supabase/server.ts's
-- createClient(), never createAdminClient() — see that page's own comment on
-- why), so without security_invoker this view would ignore RLS and hand back
-- every user's project count to whoever queries it, admin or not.
-- security_invoker re-checks projects_select (0002_rls.sql: `user_id =
-- auth.uid() or is_admin()`) against the actual calling role on every query —
-- an admin (the only role /users' requireAdmin() gate lets reach this page at
-- all) sees every user's count, transitively, the same way admins already see
-- every user's spend via spend_totals_by_user and every project via
-- /projects' own owner column.
--
-- A user with zero projects has no row here at all (plain GROUP BY, no LEFT
-- JOIN from a users/profiles table) — same "absence means zero" contract as
-- project_cost_totals: callers read a missing user_id out of the returned Map
-- as 0, not as an error. /users itself is driven by `profiles`, not by this
-- view, so a user with no projects still appears in the list; this view only
-- ever supplies the number in that row's "Projects" column.
--
-- No new grants needed — 0007_grants.sql's `alter default privileges ...
-- grant execute on functions to authenticated` / `... on tables to
-- authenticated` already cover anything this migration's role creates, the
-- same fact 0026's header and 0020_characters.sql's leaned on before it.
--
-- Per this task's constraints, this migration is written but deliberately
-- NOT applied — see the task note on 0026_cost_aggregates.sql for the same
-- caveat on that migration. web/types/db.ts is hand-patched to describe this
-- view's shape ahead of that application, same as 0026's view/functions were;
-- see that file's own header for the general policy on hand-patching.
-- =============================================================================

create view user_project_counts
with (security_invoker = true) as
select
  p.user_id,
  count(*) as project_count
from projects p
group by p.user_id;

comment on view user_project_counts is
  'Per-user count of projects, computed in SQL instead of one count() round trip per row on the '
  '/users admin list — see this migration''s header. A user with zero projects has no row here at '
  'all: callers read a missing user_id as 0, not as an error (web/lib/db-aggregates.ts '
  'getUserProjectCounts).';
