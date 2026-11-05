-- =============================================================================
-- Expose the currently-applied migration version to the web app.
--
-- Supabase's own migration ledger, supabase_migrations.schema_migrations, is
-- deliberately NOT exposed to PostgREST (it lives outside every schema in
-- config.toml's `[api] schemas`, and PostgREST only ever sees what's listed
-- there). That is correct for PostgREST's REST surface, but it also means the
-- web app has no way to ask Postgres "which migration is actually applied
-- here" -- there is no table it can select from directly.
--
-- The sidebar wants exactly that: showing the applied schema version turns a
-- code-ahead-of-migration deploy (web/app shipped, this migration not yet
-- run against the target database) into something visible on the page,
-- instead of a silent mismatch that only surfaces later as a missing-column
-- or missing-function error somewhere unrelated.
--
-- This function is a read-only wrapper across that schema boundary -- the
-- same shape every `security definer` function in this repo exists for
-- (0004's profile trigger, 0032's decide_allowance_request): the caller
-- cannot reach the underlying table directly, so the function runs with the
-- owning role's privileges just long enough to read it, and touches nothing
-- else.
--
-- ---------------------------------------------------------------------------
-- Column assumption
-- ---------------------------------------------------------------------------
-- Nothing in this repo (no migration, no doc, no config.toml setting) already
-- references supabase_migrations.schema_migrations, so its shape can't be
-- confirmed against prior art here. This is written against the Supabase
-- CLI's documented table: `version text primary key` (the migration
-- filename's numeric prefix, e.g. '0045'), plus `statements text[]` and
-- `name text`, neither of which this function needs.
--
-- ---------------------------------------------------------------------------
-- Ordering
-- ---------------------------------------------------------------------------
-- Every migration in this repo is named with a zero-padded numeric prefix
-- (0038, 0039, ... 0045, this one is 0046), and the CLI records that prefix
-- verbatim as `version`. For same-width zero-padded strings, plain text
-- ordering already agrees with numeric ordering, but `order by length(),
-- then value` is used below instead of a bare `order by version desc` so a
-- future width change (a 5-digit prefix, or the CLI's own longer
-- timestamp-style versions from a `supabase migration new`) still sorts a
-- longer, later version above a shorter, earlier one rather than getting
-- silently outranked by lexicographic comparison.
--
-- ---------------------------------------------------------------------------
-- security definer / stable / read-only
-- ---------------------------------------------------------------------------
-- security definer with `set search_path = public`, same locked-down posture
-- as every other security definer function here (0004, 0015, 0026, 0032,
-- 0038, 0040, 0044) -- an explicit, minimal search_path so this can't be
-- tricked into resolving an object from a schema a caller controls.
-- supabase_migrations.schema_migrations is referenced fully-qualified in the
-- body for exactly that reason: `public` alone would never resolve it.
--
-- `stable`, not `volatile`: this only ever reads, and its result cannot
-- change within one statement/transaction.
--
-- No UPDATE/INSERT/DELETE/DDL anywhere in the body -- SELECT only.
--
-- ---------------------------------------------------------------------------
-- Grants: authenticated only, explicitly
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE on a newly created function to PUBLIC by default --
-- unlike tables, which start with no privileges for anyone. 0007_grants.sql's
-- `alter default privileges ... grant execute on functions to authenticated`
-- adds authenticated's grant but never revokes the PUBLIC one, so every prior
-- security definer function in this repo relies on an internal check
-- (is_admin(), etc.) rather than on grants to keep anon out. This function
-- has no such internal check to make -- there is no per-row, per-user
-- decision to enforce, only "can you call this at all" -- so the grant itself
-- has to do that job. The two statements at the bottom revoke the implicit
-- PUBLIC execute and grant it back to authenticated only; anon gets nothing.
-- =============================================================================
create or replace function public.applied_schema_version()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_version text;
begin
  select version
  into v_version
  from supabase_migrations.schema_migrations
  order by length(version) desc, version desc
  limit 1;

  return v_version;
exception
  when others then
    -- Table missing, renamed, or unreadable for any other reason: this is a
    -- display-only value, never something worth failing a page render over.
    return null;
end;
$$;

comment on function public.applied_schema_version is
  'Returns the highest-applied migration version from supabase_migrations.schema_migrations (the '
  'Supabase CLI''s own migration ledger, not exposed to PostgREST directly), or NULL if the table is '
  'empty or unreadable. security definer: the caller cannot reach supabase_migrations directly, so '
  'this reads it with the owning role''s privileges and nothing else -- see this migration''s header '
  'for the column-shape assumption (version text primary key) and why ordering is length-then-value, '
  'not a bare text sort. Backs the web sidebar''s applied-schema-version display, so a '
  'code-ahead-of-migration deploy is visible instead of silent.';

revoke execute on function public.applied_schema_version() from public;
grant execute on function public.applied_schema_version() to authenticated;
-- =============================================================================
