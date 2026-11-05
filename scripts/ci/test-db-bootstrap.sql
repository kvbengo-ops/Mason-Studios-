-- Minimal stand-ins for the Supabase-managed schemas/objects that
-- supabase/migrations/*.sql assumes exist (auth, storage, realtime), so the
-- migrations apply cleanly against a bare `postgres` container instead of
-- the full `supabase start` stack.
--
-- This is NOT a reimplementation of Auth/Storage/Realtime — just enough
-- scaffolding (a users table to satisfy the FK from public.profiles, a
-- storage.objects/buckets pair and foldername() for the RLS policies that
-- reference them, and an auth.uid()/publication stub) for the migrations'
-- DDL to run. Run this BEFORE applying supabase/migrations/*.sql.
--
-- Used by .github/workflows/ci.yml (worker job's `test` matrix leg).
-- `make db-test` does NOT need it: `supabase db reset` brings up the real
-- Auth/Storage. Do not point either at anything but a scratch DB.
--
-- WHAT THIS HARNESS COVERS FOR RLS: auth.uid() below is a real
-- implementation (it reads the `request.jwt.claims` GUC the way Supabase's
-- own auth.uid() does), storage.foldername() below is also a real
-- implementation (splits on '/' and drops the trailing filename element,
-- matching Supabase's own — see that function's own comment for why an
-- inaccurate stub here is actively dangerous, not merely imprecise), and
-- worker/internal/store/rls_test.go, rls_allowance_runs_assets_test.go,
-- rls_storage_profiles_grants_test.go, and
-- rls_characters_topups_templates_history_test.go all run queries as the
-- non-superuser `authenticated` role with that GUC set per-transaction (`set
-- local role authenticated` + `set local request.jwt.claims`), so RLS is
-- actually enforced, not bypassed, for those tests. Together those files prove the
-- tenant-isolation and admin-bypass policies on: projects, scenes, runs
-- (0030_runs_project_id.sql), assets, profiles (select-only; profiles has NO
-- update policy at all, and that absence is itself asserted — see
-- 0002_rls.sql), and allowance_grants (select + admin-only insert; NO
-- update/delete policy at all, also asserted directly — see
-- 0032_allowance_requests.sql) — one user cannot select, update, or delete
-- another user's rows, and an admin genuinely can read across tenants where
-- the policy says so. They also prove allowance_requests' select/insert/
-- update policies (0032_allowance_requests.sql, fixed by
-- 0033_allowance_requests_rls_fix.sql), including the specific regression
-- 0033 closed: a non-admin rewriting their OWN already-decided
-- ('approved'/'denied') request rather than only a still-'pending' one.
--
-- storage.objects (0005_storage_bucket.sql's media_*, 0034_profile_avatar.sql's
-- avatar_*) is also covered, with one load-bearing history: 0005's four
-- media_* policies originally indexed `(storage.foldername(name))[1]` to
-- find the project id in a `projects/{projectId}/{kind}/{uuid}.{ext}` key,
-- but foldername() dropping the filename means element 1 is the literal
-- string 'projects' and element 2 is the actual project id — an indexing
-- bug that made media_select/insert/update/delete admit NO ONE via the
-- `authenticated` role, not even a row's own owner. This was NOT a
-- cross-tenant leak (the opposite: total lockout for that role) and was
-- effectively inert in production, since every real storage access goes
-- through the service-role admin client (bypasses RLS entirely — see
-- web/lib/storage.ts). 0048_fix_media_policy_folder_index.sql corrected all
-- four policies to index [2] instead. rls_storage_profiles_grants_test.go's
-- TestRLSStorageObjectsMedia now asserts the CORRECT, post-0048 behavior:
-- an owner can select/insert/update/delete their own media objects, and an
-- admin can additionally select another user's media object via
-- media_select's `or is_admin()` branch. avatar_* has no such bug
-- (avatars/{user_id}/... has no extra literal segment ahead of the indexed
-- one) and is asserted as actually working.
--
-- Real Supabase Storage also enables RLS on storage.objects and grants
-- `authenticated` table privileges on it as part of the platform's own
-- bootstrap — outside this repo's migrations entirely, so this file
-- reproduces both explicitly below (see the ALTER TABLE/GRANT lines by
-- storage.foldername()) rather than leaving storage.objects an
-- RLS-disabled, ungranted table that would either bypass every policy test
-- above or fail at the grant layer before RLS is ever reached.
--
-- rls_characters_topups_templates_history_test.go additionally proves:
-- characters (0020_characters.sql — select is `using (true)` with no `to
-- authenticated`, deliberately public-shaped but held out for anon by grants
-- alone, see rls_anon_test.go; insert/update/delete are admin-only, one
-- policy per verb, both directions asserted for each), kie_topups
-- (0036_fal_topups.sql — select and insert are admin-only, insert also pins
-- `recorded_by = auth.uid()` so an admin cannot forge another admin's
-- identity; no update/delete policy at all, asserted as such),
-- prompt_templates (0008_prompt_templates_rls.sql — a single `using (true)
-- to authenticated` select policy, no insert/update/delete), and
-- deleted_project_cost_history (0038_preserve_cost_history_on_delete.sql —
-- admin-only select, no insert/update/delete policy at all; only the
-- security-definer archive triggers may write it). All four tables were
-- checked in pg_policies against their migrations before writing tests and
-- match verbatim — none turned out broken the way 0005's media_* did.
--
-- WHAT IT STILL DOES NOT COVER: the remaining `create policy` statements
-- across supabase/migrations/ are still only checked for "does the DDL parse
-- and apply" via the superuser store tests -- never for whether they
-- actually admit or deny the right rows. A green run proves the
-- projects/scenes/runs/assets/allowance_requests/allowance_grants/profiles/
-- storage.objects/characters/kie_topups/prompt_templates/
-- deleted_project_cost_history boundaries above; it says nothing about any
-- policy these RLS test files don't touch.

create extension if not exists pgcrypto;

-- 0007_grants.sql (and later migrations) grant privileges to Supabase's
-- three standard Postgres roles, which only exist because GoTrue/the
-- platform bootstrap creates them.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

-- Mirrors Supabase's real auth.uid(): the JWT's `sub` claim, read out of the
-- per-session/per-transaction `request.jwt.claims` GUC that PostgREST (and
-- our own test harness's `set local role authenticated` + `set local
-- request.jwt.claims`) sets before running a query. `current_setting(...,
-- true)` (the `missing_ok` form) returns NULL instead of raising when the
-- GUC is unset, and nullif(...,'') turns an empty string into NULL too, so
-- an ordinary superuser session (nothing ever sets the GUC) still resolves
-- to NULL rather than erroring -- required for every non-RLS test in this
-- package, which never touches this GUC at all.
create or replace function auth.uid() returns uuid
  language sql stable
  as $$
    select
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
  $$;

create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text
);

-- Supabase's REAL storage.foldername(name) splits `name` on '/' and DROPS
-- the final element (the filename) — for 'avatars/<uid>/pic.png' it returns
-- {avatars, <uid>}, NOT {avatars, <uid>, pic.png}. The slice below keeps
-- every element up to (but not including) the last one; an input with no
-- '/' at all (e.g. 'solo.png') has nothing before the filename, so the
-- correct result is the empty array {}.
--
-- A stub that just does `string_to_array(name, '/')` (this function's
-- previous body) keeps the filename in the result, which is actively
-- dangerous here, not merely imprecise: every storage RLS policy in this
-- schema (0005_storage_bucket.sql, 0034_profile_avatar.sql) indexes into
-- this array to pull out a project id or user id segment. Getting the
-- semantics right shifts every index by however many segments the real
-- function drops, so a storage RLS test written against the wrong stub can
-- pass while asserting the OPPOSITE of what the real policy does against
-- production Storage — a false "covered" that is worse than no test at all.
-- (This fix is exactly what surfaced 0005_storage_bucket.sql's own
-- foldername-index bug — see rls_storage_profiles_grants_test.go's header.)
create or replace function storage.foldername(name text) returns text[]
  language sql immutable
  as $$ select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1] $$;

-- Real Supabase Storage enables RLS on storage.objects and grants
-- authenticated (not anon — no public bucket in this schema, see
-- 0005_storage_bucket.sql's `public: false`) select/insert/update/delete on
-- it as part of the platform's own bootstrap, entirely outside this repo's
-- migrations. Neither of those is DDL this project owns, so nothing in
-- supabase/migrations/ creates them — without reproducing both here, every
-- storage RLS policy test would either see RLS not enforced at all (a
-- superuser-only table, same false-negative shape rls_test.go's header
-- warns about) or fail at the grant layer before RLS is ever consulted
-- (same distinction rls_anon_test.go draws for public-schema tables).
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;

-- 0006_realtime.sql does `alter publication supabase_realtime add table
-- scenes`, which normally targets a publication Supabase's own bootstrap
-- creates.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
