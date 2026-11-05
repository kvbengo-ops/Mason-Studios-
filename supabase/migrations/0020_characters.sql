-- =============================================================================
-- characters — the shared, admin-curated Character Library
--
-- Every project so far has carried exactly one character, built from scratch
-- on that project's own Character step: an operator either uploads a photo
-- or types a description and generates one, and both live only on that
-- project (`assets` for the photo, `projects.character_desc` for the text).
-- There was nowhere to save a character *between* projects, so a brand that
-- shoots the same spokesperson every month paid to re-describe or
-- re-upload them every single time, and every project's reference drifted
-- independently of every other project's.
--
-- This table is that shared save point. It is deliberately its own table,
-- not a repurposed `assets` row: `assets` is scoped to a `project_id` (see
-- 0001_init.sql) and a library character has no project until an operator
-- picks it — it is the thing projects copy FROM, not a thing that belongs
-- to one.
--
-- ---------------------------------------------------------------------------
-- Why `description` lives on this row, not just the photo
-- ---------------------------------------------------------------------------
-- `projects.character_desc` is not cosmetic — it's what web/lib/claude.ts's
-- compiler reads on every scene to keep the same person described the same
-- way across up to eighteen clips (see 0013_project_direction.sql). A
-- library entry that stored only a picture would hand an editor a face with
-- no words to repeat, and the compiler would fall back to inferring a
-- description from nothing, which is exactly the drift this table exists to
-- stop. So `description` is a first-class column here, copied alongside the
-- photo every time a project "uses" a character (web/actions/character.ts's
-- useCharacter) — never generated fresh per project the way it used to be.
--
-- It is nullable rather than `not null`: an admin who uploads a real photo
-- without typing a description is exactly as valid a library entry as an
-- operator uploading straight to a project always was (character/page.tsx's
-- "upload OR describe" — either is sufficient, see assertHasCharacter). What
-- must not happen is a description with no photo at all, which is why
-- `storage_key` below has no such escape hatch: an entry with nothing to
-- look at isn't pickable from a grid of thumbnails.
--
-- ---------------------------------------------------------------------------
-- RLS: every authenticated user may read; only an admin may write
-- ---------------------------------------------------------------------------
-- This is the one deliberate asymmetry in the whole feature — "editors
-- pick, admins curate" is brand control, not an accident, and it has to
-- hold even against a client that ignores our UI. 0002_rls.sql already
-- expresses "admin" exactly once, as the security-definer `is_admin()`
-- helper (avoids the recursive-RLS trap of a `profiles` policy querying
-- `profiles`) — this migration reuses that helper rather than inventing a
-- second notion of admin, and reuses the read-everyone/write-admin shape
-- `profiles_select_admin` already established there instead of the
-- read-own/write-own shape every *other* table in this schema uses (those
-- are all project-owned; this table is nobody's).
--
-- Read is unconditional (`using (true)`) rather than gated through
-- `is_admin()` at all: unlike every table added since 0002, there is no
-- owner to fall back to here, and the entire point of a *shared* library is
-- that every signed-in operator — editor or admin — can browse it. Write
-- policies are the actual boundary, one per statement (insert/update/delete)
-- so a future policy change to one verb can't silently loosen another.
--
-- Grants are the separate gate 0007_grants.sql's own comment warns about: a
-- table with RLS enabled and no grant returns a blanket 403 to every role
-- regardless of policy, and 0007 has already been bitten by exactly that.
-- No grant statement is needed here because 0007 covers it in advance —
-- `alter default privileges ... grant select, insert, update, delete on
-- tables to authenticated` applies to any table created afterward by the
-- same migration role, this one included; `service_role` (what every write
-- in this feature actually uses — see below) is covered the same way. This
-- migration's own live-verification step re-checks that assumption rather
-- than taking it on faith.
--
-- Note the shape of who actually issues writes: every INSERT/UPDATE/DELETE
-- in web/actions/character-library.ts still goes through
-- `createAdminClient()` (the service-role key, which bypasses RLS
-- entirely — see 0002_rls.sql's own header note), with the admin check done
-- in application code first (`requireAdmin()` in actions/guard.ts). These
-- policies are not that boundary; they are the backstop for any
-- anon/authenticated client path, present or future, exactly as 0002's
-- header already documents for every other table.
-- =============================================================================

create table characters (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  description    text,
  storage_key    text not null,
  created_by     uuid not null references profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table characters is
  'Admin-curated Character Library (brand control): every authenticated user may read, only an '
  'admin may write. "Use" (web/actions/character-library.ts) copies both storage_key and '
  'description into a project — see this migration''s header for why the description is a column '
  'here and not just baked into the photo.';

comment on column characters.description is
  'Optional, like projects.character_desc (same reasoning: a photo alone is a valid library entry, '
  'per assertHasCharacter''s upload-OR-describe rule) — but when present, copied verbatim into '
  'projects.character_desc on Use, never regenerated per project.';

comment on column characters.storage_key is
  'Points at the library''s own copy under the media bucket (see web/lib/storage.ts), never a '
  'project''s copy. Use() calls Storage''s server-side copy to duplicate the object into the '
  'project rather than referencing this key directly — see useCharacter''s doc comment for why '
  'pointing instead of copying was rejected.';

-- Library-browse order: newest first, same convention character/page.tsx
-- already uses for "most recent asset of a kind".
create index characters_created_at_idx on characters (created_at desc);

alter table characters enable row level security;

create policy characters_select on characters
  for select
  using (true);

create policy characters_insert_admin on characters
  for insert
  with check (is_admin());

create policy characters_update_admin on characters
  for update
  using (is_admin())
  with check (is_admin());

create policy characters_delete_admin on characters
  for delete
  using (is_admin());
