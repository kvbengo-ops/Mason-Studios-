-- =============================================================================
-- prompt_templates RLS
--
-- 0002_rls.sql enabled RLS on profiles, projects, scenes, assets, and runs,
-- but never touched prompt_templates. On the live database prompt_templates
-- already has relrowsecurity = true (turned on out-of-band, not by a
-- migration) with zero policies attached — which is default-deny for every
-- non-service-role client. web/actions/compile.ts loads the latest template
-- with the RLS-scoped client, gets 0 rows, and .single() throws PGRST116.
-- Every "Compile script" click 500s before the pipeline gets past the
-- character step.
--
-- This migration makes the repo say explicitly what the live database
-- already does, instead of leaving prompt_templates' RLS state to be
-- whatever someone happened to click in the dashboard, and adds the read
-- policy that default-deny was silently missing.
-- =============================================================================

alter table prompt_templates enable row level security;

-- Templates are immutable and versioned (see the comment on the table in
-- 0001_init.sql) and carry no user_id — there is nothing to scope per-user.
-- Any signed-in user may read any template.
create policy prompt_templates_select on prompt_templates
  for select
  to authenticated
  using (true);

-- No insert/update/delete policies: templates are seeded by migration
-- (0003_seed_template.sql) and immutable by convention. The service-role
-- client used by Server Actions and the Go worker bypasses RLS entirely and
-- is unaffected by this file. anon has no grants on this table per
-- 0007_grants.sql and gets no policy here either, so it reaches nothing.
