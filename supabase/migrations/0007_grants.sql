-- Role grants for the Supabase API roles.
--
-- Creating a table does not grant anything to PostgREST's roles. Supabase's
-- default privileges cover tables created through the dashboard, but tables
-- created by a migration run under a different owner land with no grants at
-- all — every request comes back 403 "permission denied", including ones made
-- with the service-role key. Without this file the application cannot read a
-- single row.
--
-- Grants and RLS are separate gates and both must pass:
--   grants  decide whether a role may touch the table at all
--   RLS     decides which rows it sees once it may
-- 0002_rls.sql handles the second. This handles the first.

grant usage on schema public to anon, authenticated, service_role;

-- service_role bypasses RLS by design; it is the server-side identity used by
-- Server Actions and by the Go worker, both of which check ownership in code.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- authenticated gets table-level access; RLS narrows it to their own rows.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

-- anon reaches nothing. There is no public signup and no unauthenticated
-- surface, so the only thing anon needs is the ability to call auth endpoints,
-- which live outside this schema.

-- Future tables inherit the same grants, so adding a table in a later
-- migration does not silently reintroduce the 403.
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant all on sequences to service_role;
alter default privileges in schema public
  grant all on functions to service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;
alter default privileges in schema public
  grant execute on functions to authenticated;
