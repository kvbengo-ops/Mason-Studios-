-- =============================================================================
-- Storage bucket: media
--
-- Backs `lib/storage.ts` (web) — the only file in the repo that touches
-- `supabase.storage`, so the storage vendor can be swapped in one place if
-- needed later. Private bucket; every read goes through a signed URL
-- (`storage.ts#signedUrl`), never a public URL.
--
-- RLS policies mirror the project-ownership model in 0002_rls.sql: a user
-- may act on an object only if the `{projectId}` path segment (see the key
-- shape in lib/storage.ts: `projects/{projectId}/{kind}/{uuid}.{ext}`)
-- belongs to a project they own, or read-only if they're an admin.
--
-- NOTE: web Server Actions write via `createAdminClient()`, which bypasses
-- these policies entirely (same caveat as 0002_rls.sql) — they exist to
-- protect any future anon/authenticated client path, not as the only line
-- of defense.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

-- Path shape: projects/{projectId}/{kind}/{uuid}.{ext}
-- storage.foldername(name) splits on '/', so element 1 (1-indexed) is
-- always the project id for every object we write.
create policy media_select on storage.objects
  for select
  using (
    bucket_id = 'media'
    and exists (
      select 1 from projects p
      where p.id::text = (storage.foldername(name))[1]
        and (p.user_id = auth.uid() or is_admin())
    )
  );

create policy media_insert on storage.objects
  for insert
  with check (
    bucket_id = 'media'
    and exists (
      select 1 from projects p
      where p.id::text = (storage.foldername(name))[1]
        and p.user_id = auth.uid()
    )
  );

create policy media_update on storage.objects
  for update
  using (
    bucket_id = 'media'
    and exists (
      select 1 from projects p
      where p.id::text = (storage.foldername(name))[1]
        and p.user_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'media'
    and exists (
      select 1 from projects p
      where p.id::text = (storage.foldername(name))[1]
        and p.user_id = auth.uid()
    )
  );

create policy media_delete on storage.objects
  for delete
  using (
    bucket_id = 'media'
    and exists (
      select 1 from projects p
      where p.id::text = (storage.foldername(name))[1]
        and p.user_id = auth.uid()
    )
  );
