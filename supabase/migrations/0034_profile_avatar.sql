-- =============================================================================
-- profiles.avatar_storage_key — an editor's own profile photo
-- (web/app/(app)/profile/page.tsx)
--
-- NOT APPLIED as of this migration being written — same convention as
-- 0031_account_allowances.sql and 0032_allowance_requests.sql: reviewed and
-- staged, not run. Applying it is a follow-up step for whoever ships this.
--
-- =============================================================================
-- 1. profiles.avatar_storage_key
-- =============================================================================
-- Nullable, a bare storage key (not a signed URL — every other asset table
-- in this schema stores the key and defers to lib/storage.ts's signedUrl()
-- at display time, since a signed URL embeds an expiry and would go stale
-- sitting in a row). No default: NULL means "no avatar uploaded", the
-- correct starting state for every account that predates this column and
-- every new signup after it.
--
-- No foreign key to an `assets` row: `assets` (0001_init.sql) is scoped to
-- `project_id` — every row's storage key sits under `projects/{projectId}/
-- ...` (lib/storage.ts's buildStorageKey) or `library/...`
-- (buildLibraryStorageKey) for a Character Library entry. An avatar belongs
-- to an ACCOUNT, not a project and not the shared library, so it gets its
-- own top-level prefix (`avatars/{user_id}/...`, see part 2 below) and its
-- own column rather than a synthetic assets row with no project_id to
-- satisfy that table's own shape.
alter table profiles
  add column avatar_storage_key text;

comment on column profiles.avatar_storage_key is
  'Storage key of this account''s avatar in the media bucket (avatars/{user_id}/{uuid}.{ext} — '
  'see lib/storage.ts''s buildAvatarStorageKey), or NULL if none has been uploaded. A bare key, '
  'not a signed URL — resolved through lib/storage.ts''s signedUrl() at display time like every '
  'other asset in this schema, since a signed URL embeds an expiry and would go stale stored in a '
  'row. Replacing an avatar (actions/profile.ts''s uploadAvatar) writes the new key here and '
  'deletes the OLD object from storage in the same action, so this column never points at more '
  'than one live object per account and the bucket does not accumulate orphaned avatar bytes the '
  'way character_ref/composite_ref replacements already do (see lib/storage.ts''s own header).';

-- =============================================================================
-- 2. Storage RLS — a user may write/delete only under their own avatar prefix
-- =============================================================================
-- Path shape: avatars/{user_id}/{uuid}.{ext} — storage.foldername(name)
-- splits on '/', so element 1 is the literal 'avatars' segment and element 2
-- is the owning account's id, mirroring 0005_storage_bucket.sql's own
-- element-1-is-the-scope-key pattern for `projects/{projectId}/...` (element
-- 1 there IS the project id; here element 1 is a fixed literal because an
-- avatar has no project to key off of, so the user id moves to element 2
-- instead).
--
-- Read 0005_storage_bucket.sql's media_select/media_insert/media_update
-- policies first (this migration's own instruction) and follow their shape:
-- same `bucket_id = 'media'` guard, same using/with-check split for
-- select/update, same NOTE that web Server Actions write via
-- createAdminClient() (which bypasses RLS entirely, per 0005's own header)
-- so these policies protect a hypothetical anon/authenticated client path,
-- not the only line of defense — actions/profile.ts's requireUser() +
-- explicit `auth.uid()`-scoped WHERE clauses are that first line, same
-- division of labor 0005's header describes for `projects/...` keys.
--
-- RLS and grants are separate gates in this project (0008's own lesson,
-- restated in AGENTS.md): storage.objects already has RLS enabled by
-- Supabase itself, and a table with RLS on and NO POLICY for a given
-- command is default-deny for that command — there is no insert/update/
-- delete policy for the `avatars/` prefix until this migration adds one,
-- so skipping any one of the three below would silently refuse that
-- command for every session-client caller (there are none today, but see
-- the paragraph above for why that isn't the same as "doesn't matter").
--
-- No avatar_select policy: media_select (0005_storage_bucket.sql) already
-- covers every object in this bucket for an admin (`is_admin()`) but its
-- non-admin half is scoped to `projects/{projectId}/...` keys via a
-- `projects` table join that an `avatars/{user_id}/...` key can never
-- satisfy (there is no project row to find), so it silently excludes
-- avatars for a non-admin session client without this migration doing
-- anything at all. That is the correct default here: every avatar read in
-- this app goes through lib/storage.ts's signedUrl() via the admin client
-- (actions/profile.ts, profile/page.tsx), the same as every other asset in
-- this schema, and a signed URL is deliberately NOT gated by
-- storage.objects RLS at fetch time (it is a bearer token, not an
-- authenticated request) — so there is no session-client read path here to
-- write a policy for, only the write/delete paths a malicious or buggy
-- authenticated client could otherwise reach.
create policy avatar_insert on storage.objects
  for insert
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

create policy avatar_update on storage.objects
  for update
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = auth.uid()::text
  )
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

create policy avatar_delete on storage.objects
  for delete
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = auth.uid()::text
  );
-- =============================================================================
