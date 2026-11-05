-- =============================================================================
-- elements — an operator's own reusable @tag library: characters, products,
-- and voices they want to reference by name across MULTIPLE projects,
-- without re-uploading or re-describing them each time.
--
-- Why this is a new table and not a reuse of `characters` (per the
-- standing decision — see that table's own migration for the fuller
-- argument, which this table inherits rather than repeats):
--
--   - `characters` is the admin-curated, everyone-reads brand library
--     (characters_select's `using (true)`) — the deliberate ONE asymmetry
--     in this whole schema, "editors pick, admins curate." elements is the
--     opposite shape on purpose: every operator's own private set, visible
--     to nobody else's queries but its owner (and, read-only, an admin —
--     see the RLS section below). Folding this into `characters` would
--     either open the brand library to every operator's junk uploads, or
--     require a visibility column bolted onto a table whose entire RLS
--     story is currently one unconditional `true`.
--   - `characters` only ever models one category (a person). elements
--     spans three — character, product, and voice — because the @tag
--     surface an operator types into is one flat namespace: "@jen" might
--     resolve to a face, "@blue-bottle" to a product shot, "@narrator-2"
--     to a voice profile, and the picker/autocomplete reading this table
--     needs one place to look them all up, not three.
--
-- Why `asset_id`, not a copied `storage_key` (unlike `characters`, which
-- deliberately copies rather than points — see that migration's header):
-- an operator registers an element FROM an upload or a generation that
-- already happened inside some project's own pipeline, producing an
-- ordinary `assets` row there. `characters` predates `scene_versions` and
-- needed a copy because a library entry has to survive independently of
-- whatever project it was built in and Storage has no cheap "reference,
-- not copy" primitive; here the underlying asset is what the element IS,
-- not raw material for a copy, so this table points at it directly. The
-- consequence is deliberate too: this is a pointer, not an archive, so
-- deleting the source asset takes the element with it (`on delete cascade`
-- below) rather than orphaning a nameless row — see the column comment.
--
-- Why user-scoped (`user_id`) rather than project-scoped: the whole point
-- is reuse ACROSS projects, so an element cannot hang off one
-- `project_id` the way `assets` does. It hangs off the operator instead,
-- exactly like `projects.user_id` itself does — not off any parent
-- project, plural or singular.
--
-- `unique (user_id, name)`: the @tag an operator types resolves by name
-- within their own set (web/lib/elements.ts's tag resolver, once it
-- exists) — two rows named "@jen" for the same operator would make that
-- resolution ambiguous. Different operators may reuse the same name
-- freely; there is no cross-user collision to prevent.
-- =============================================================================

create table elements (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id),
  name        text not null,
  description text,
  category    text not null check (category in ('character', 'product', 'voice')),
  asset_id    uuid not null references assets(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

comment on table elements is
  'An operator''s own reusable @tag library (character/product/voice), resolved by name within '
  'their own set when a prompt references "@name". Owner-only, unlike the admin-curated, '
  'everyone-reads `characters` table — see this migration''s header for the full contrast.';

comment on column elements.category is
  'Which picker/autocomplete surface this element belongs to. Our own product vocabulary, CHECK '
  'not a native enum — same reasoning as assets.kind / scenes.status (see 0001_init.sql and '
  'web/types/db.ts''s "Hand-maintained enum aliases" header).';

comment on column elements.asset_id is
  'The upload or generation this element points AT — a pointer into an already-existing `assets` '
  'row, not a copy of one (contrast `characters.storage_key`, which IS a copy; see this '
  'migration''s header for why the two tables made opposite choices). `on delete cascade`: an '
  'element with its source asset gone has nothing left to show in the picker or the @tag hover '
  'preview, so it goes with it rather than surviving as a dangling name.';

-- ---------------------------------------------------------------------------
-- RLS — owner-only read and write, admin read-only, mirroring `projects`'
-- own policies in 0002_rls.sql exactly: elements.user_id is a direct column
-- on this table (not reached through a parent join) just like
-- projects.user_id is, so the same shape applies unchanged. This is NOT
-- `characters`' shape (everyone reads, admin writes) — see this migration's
-- header for why this table is the asymmetric opposite of that one.
-- ---------------------------------------------------------------------------
alter table elements enable row level security;

create policy elements_select on elements
  for select
  using (user_id = auth.uid() or is_admin());

create policy elements_insert on elements
  for insert
  with check (user_id = auth.uid());

create policy elements_update on elements
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy elements_delete on elements
  for delete
  using (user_id = auth.uid());

-- Picker/autocomplete read path: an operator's own elements, grouped by
-- category (the picker's tabs) and newest first within each — same
-- "most recent asset of a kind first" convention characters_created_at_idx
-- (0020_characters.sql) already established for a browsable library.
create index elements_user_id_category_created_at_idx
  on elements (user_id, category, created_at desc);
