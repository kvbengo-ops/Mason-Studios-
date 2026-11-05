-- =============================================================================
-- Fix the media_* policies on storage.objects: the project id lives at
-- storage.foldername(name)[2], not [1].
--
-- 0005_storage_bucket.sql shipped all four media policies comparing
--
--   p.id::text = (storage.foldername(name))[1]
--
-- and a comment above them asserting "element 1 (1-indexed) is always the
-- project id for every object we write". That comment is wrong, and the
-- policies inherited the mistake.
--
-- The keys the worker actually writes (worker/internal/store/storage.go:70-97)
-- all carry a literal `projects/` prefix:
--
--   projects/{projectId}/clip/{sceneId}.{ext}
--   projects/{projectId}/final/final.{ext}
--   projects/{projectId}/poster/{sceneId}.{ext}
--   projects/{projectId}/final/poster.{ext}
--
-- storage.foldername() splits on '/' and drops the trailing filename, so for
-- `projects/<uuid>/clip/x.mp4` it returns `{projects, <uuid>, clip}`. Element
-- [1] is therefore the literal string 'projects' — never a uuid — and
-- `p.id::text = 'projects'` cannot match any row. The project id is at [2].
--
-- ---------------------------------------------------------------------------
-- What this was actually doing
-- ---------------------------------------------------------------------------
-- Denying everyone. Not leaking — locking out. Verified against a real
-- Postgres with RLS enforced on storage.objects: as the OWNING user, a select
-- over their own media object returns 0 rows, and an insert into their own
-- project's folder fails with "new row violates row-level security policy".
-- The `or is_admin()` branch in media_select does not help either, because the
-- failing comparison sits outside it.
--
-- It went unnoticed because nothing exercises these policies. web/lib/storage.ts
-- is by its own first line "the only file in the repo allowed to touch
-- supabase.storage", and every call in it goes through createAdminClient() —
-- the service role, which bypasses RLS entirely. The real protection today is
-- application-level: the server decides which signed URL to hand a caller.
--
-- ---------------------------------------------------------------------------
-- Why fix rather than drop
-- ---------------------------------------------------------------------------
-- These policies exist to be the layer that catches an application-code
-- mistake. A policy that matches nothing cannot catch anything, so today that
-- layer is decorative. Correcting the index is what makes it real.
--
-- Worth stating plainly: this GRANTS access that currently resolves to nobody.
-- That is a genuine behaviour change rather than a tightening. It is safe here
-- because the grant is exactly the one the policy was written to express — the
-- project's owner, plus an admin on select — and because no caller reaches
-- storage as `authenticated` today, so nothing observable changes until one
-- does.
--
-- 0034_profile_avatar.sql's avatar policies are correct as written:
-- `avatars/{user_id}/{uuid}.{ext}` yields `{avatars, user_id}`, and those
-- policies already read the literal from [1] and the id from [2]. Same shape,
-- correct indices — 0005 is the outlier.
--
-- ---------------------------------------------------------------------------
-- Why [1] = 'projects' is pinned, and not just the index corrected
-- ---------------------------------------------------------------------------
-- Correcting [1] -> [2] alone would match a project id in the second segment
-- under ANY first segment. Since this migration grants access that previously
-- resolved to nobody, that is not academic: an authenticated user could then
-- write to `library/{their own project id}/...` — colliding with the
-- `library/` namespace buildLibraryStorageKey owns — and, worse,
-- `avatars/{their own project id}/...`.
--
-- That second one punches through 0034 outright. Postgres ORs permissive
-- policies together, so avatar_insert's careful
-- `[1] = 'avatars' and [2] = auth.uid()::text` restriction stops mattering the
-- moment media_insert independently admits the same row on a project-id match
-- alone. Verified both inserts succeeding against a real Postgres before this
-- pin was added.
--
-- Pinning the literal costs nothing, restores the symmetry 0034 already has,
-- and keeps each namespace owned by exactly one policy.
--
-- ---------------------------------------------------------------------------
-- alter policy, not drop + create
-- ---------------------------------------------------------------------------
-- Same object, same command, same privilege — only the predicate changes, so
-- `alter policy` is the narrower statement, following 0033's precedent. Each
-- policy's clauses are altered exactly as 0005 declared them: select and
-- delete carry `using` only, insert carries `with check` only, and update
-- carries both.
-- =============================================================================

alter policy media_select on storage.objects
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = 'projects'
    and exists (
      select 1 from projects p
      where p.id::text = (storage.foldername(name))[2]
        and (p.user_id = auth.uid() or is_admin())
    )
  );

alter policy media_insert on storage.objects
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = 'projects'
    and exists (
      select 1 from projects p
      where p.id::text = (storage.foldername(name))[2]
        and p.user_id = auth.uid()
    )
  );

alter policy media_update on storage.objects
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = 'projects'
    and exists (
      select 1 from projects p
      where p.id::text = (storage.foldername(name))[2]
        and p.user_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = 'projects'
    and exists (
      select 1 from projects p
      where p.id::text = (storage.foldername(name))[2]
        and p.user_id = auth.uid()
    )
  );

alter policy media_delete on storage.objects
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = 'projects'
    and exists (
      select 1 from projects p
      where p.id::text = (storage.foldername(name))[2]
        and p.user_id = auth.uid()
    )
  );
-- =============================================================================
