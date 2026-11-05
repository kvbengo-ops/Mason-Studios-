-- =============================================================================
-- The Elements Library becomes SHARED: everyone browses and downloads, the
-- owner or an admin edits and removes.
--
-- This reverses 0065_elements.sql's central choice, which made `elements` "the
-- asymmetric opposite" of `characters` — owner-only read, owner-only write. The
-- Elements Library took the Character Library's sidebar slot (nav-links.tsx), so
-- it is the library operators actually see, and it was the one nobody could see
-- into. It supersedes AGENTS.md's "per-account `elements` rows" note for
-- READING; that line described this table's old contract and no longer does.
--
-- BOTH KINDS, images and audio. An earlier draft of this change shared images
-- only and left audio owner-private. That split was dropped deliberately: there
-- is one table, one picker, one grid and one `category` column, and a rule that
-- admits half the rows would have to be restated in the select policy, the
-- loader, the grid, the download control and every test — five places to
-- disagree, in exchange for a distinction no product surface makes.
--
-- NUMBERED 0091, leaving a gap. 0087-0090 were taken by branches that are not
-- merging, and migrations apply in filename sort order
-- (.github/workflows/ci.yml), so a gap costs nothing while a number reused by
-- two branches costs a merge that cannot be applied twice. This file was 0090 in
-- an earlier draft and was never applied anywhere (proven before renumbering: no
-- `elements` policy on any database read `true`), so renumbering rewrote no
-- applied migration.
--
-- ---------------------------------------------------------------------------
-- What changes, per verb
-- ---------------------------------------------------------------------------
--   select  was `user_id = auth.uid() or is_admin()`; now `true`. "Everyone"
--           means every signed-in account and nobody else: anon holds no grant
--           on this table (0007_grants.sql, proven by rls_anon_test.go), the
--           media bucket stays PRIVATE, and every picture and clip is still
--           reached through a signed URL minted by the service role. Sharing
--           the rows is not making the bucket public, and this migration adds
--           no storage.objects policy.
--
--   insert  UNCHANGED — `is_active() and user_id = auth.uid()` (0068). The
--           uploader is the authenticated account and cannot be a value the
--           client supplied; that was already true and stays true.
--
--   update  was owner-only; now `is_active() and (user_id = auth.uid() or
--           is_admin())`.
--
--   delete  was owner-only; now `is_active() and (user_id = auth.uid() or
--           is_admin())`.
--
-- Admins get EDIT here, not only DELETE. The difference is deliberate and comes
-- from the product requirement rather than from taste: an admin is expected to
-- be able to correct a bad description or a misleading @name in this library,
-- not only to remove the row. What that costs is stated where it is paid —
-- actions/elements.ts's updateElement follows a rename through the OWNER's
-- prompts, never the admin's, so an admin renaming somebody's tag repairs that
-- person's scenes instead of breaking them.
--
-- ---------------------------------------------------------------------------
-- THE FORGED-REFERENCE HOLE, and why the fix is a trigger
-- ---------------------------------------------------------------------------
-- `elements.asset_id` POINTS at an `assets` row rather than copying it (0065's
-- column comment). Sharing the rows means the grid has to render other people's
-- pictures, which means `assets_select` has to admit the assets behind them —
-- and THAT is where a naive widening becomes an arbitrary-file read.
--
-- Nothing in 0065 ties an element to an asset its own owner owns.
-- `elements_insert` checks `user_id = auth.uid()` and says nothing about
-- `asset_id`. So an account could insert an element naming SOMEBODY ELSE's
-- asset id and, under a branch that admitted "any asset some element points
-- at", make that asset readable — its storage_key handed straight to the
-- attacker's own library page and signed for them by the service role. That is
-- a forged pointer turning a shared surface into an arbitrary-file read.
--
-- Two independent answers, because they fail differently:
--
--   1. A TRIGGER refuses the forged row at write time, from every client. The
--      predicate is OWNERSHIP, not visibility: the asset must be owned by the
--      element's own user_id, either directly (assets.user_id, 0085) or through
--      the project that holds it (projects.user_id). SECURITY DEFINER so that
--      RLS on `assets` cannot change the answer — a check that quietly depends
--      on what the caller can see is a check that means something different for
--      the service role than for a session, and every write in this app arrives
--      through the service role (0002_rls.sql's header).
--
--      It also pins `user_id` immutable. That column is what the update and
--      delete policies authorise against; a row that could change hands would
--      defeat both.
--
--   2. The assets_select branch RESTATES the ownership condition rather than
--      trusting that the trigger has always been there. Rows written before this
--      migration were never checked, so a policy that assumed provenance would
--      be assuming exactly the thing that was never enforced.
--
-- ---------------------------------------------------------------------------
-- What does NOT change
-- ---------------------------------------------------------------------------
-- @TAG RESOLUTION STAYS PER-OWNER. `unique (user_id, name)` means "@jen"
-- identifies one row within one account's set, and two operators may each have
-- their own — rls_elements_test.go's last subtest exists to pin that. A global
-- resolver would have to invent a tiebreak, so browsing and resolving are two
-- different reads and only browsing got wider: lib/element-library.ts keeps its
-- `ownerId` filter for both consoles, and the library page passes null. Reading
-- somebody else's element tells you it exists; it does not put it in your
-- vocabulary, and it does not let you rename their tag.
--
-- PROJECTS STAY PRIVATE. `projects_select` is untouched, and the assets branch
-- below admits ONE asset per shared element, by id, not a project's contents.
-- `useCharacter`-style project copies are unaffected: nothing here changes how
-- an asset is copied into a project or who may read a project's own rows.
-- =============================================================================

drop policy elements_select on elements;

create policy elements_select on elements
  for select
  using (true);

comment on policy elements_select on elements is
  'Every signed-in account reads the whole library -- the shared half of the Elements Library '
  '(0091). anon holds no grant on this table (0007_grants.sql), so "everyone" stops at the app '
  'boundary, and the media bucket stays private: rows are shared, objects are still reached only '
  'through service-role signed URLs. WRITING is not shared -- see elements_update/elements_delete, '
  'which admit the owner or an admin and nobody else.';

drop policy elements_update on elements;

create policy elements_update on elements
  for update
  using (
    is_active()
    and (user_id = auth.uid() or is_admin())
  )
  with check (
    is_active()
    and (user_id = auth.uid() or is_admin())
  );

comment on policy elements_update on elements is
  'The owner, or an admin. Admins edit here, not only delete, because correcting a bad '
  'description or a misleading @name in a shared library is expected of them. The `with check` half repeats the predicate so an update cannot hand the '
  'row to another account; elements_guard_asset_ownership() pins user_id immutable besides.';

drop policy elements_delete on elements;

create policy elements_delete on elements
  for delete
  using (
    is_active()
    and (user_id = auth.uid() or is_admin())
  );

comment on policy elements_delete on elements is
  'The owner, or an admin as moderator. Deleting an element removes a NAME, never the picture: '
  'actions/elements.ts leaves the asset row and its storage object alone (two elements may point '
  'at one upload), and every scene that already rendered holds its own copy.';

comment on table elements is
  'The shared @tag library: every signed-in account reads and downloads every entry, the owner '
  'adds their own, and the owner or an admin may edit and remove. Was owner-only read until '
  '0091_shared_elements_library.sql. RESOLUTION IS STILL PER-OWNER -- `unique (user_id, name)` '
  'means "@name" identifies one row only within its owner''s set, so browsing another account''s '
  'entry does not make it typeable in your own prompt.';

comment on column elements.asset_id is
  'The upload or generation this element points AT -- a pointer into an already-existing `assets` '
  'row, not a copy of one (contrast `characters.storage_key`, which IS a copy). Since 0091 that '
  'pointer is CHECKED: elements_guard_asset_ownership() refuses a row whose asset is not owned by '
  'the element''s own user_id, which is what stops a forged asset_id turning the shared library '
  'into an arbitrary-file read. `on delete cascade`: an element with its source asset gone has '
  'nothing left to show, so it goes with it rather than surviving as a dangling name.';

-- ---------------------------------------------------------------------------
-- Does this account own this asset?
--
-- The single definition of "owns", used by BOTH the write-time trigger and the
-- read-time policy branch below, so the two can never drift into disagreeing.
-- An asset belongs to an account directly (assets.user_id, 0085's project-less
-- shape) or through the project that holds it (projects.user_id) -- the same
-- two-branch ownership assets_select itself is built on.
--
-- SECURITY DEFINER so the answer does not depend on what the CALLER can see.
-- A visibility-based check means one thing for a session client and another for
-- the service role that makes every write in this app, and the question here is
-- ownership, which is not a matter of perspective.
-- ---------------------------------------------------------------------------
create or replace function account_owns_asset(account_id uuid, target_asset_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from assets a
    left join projects p on p.id = a.project_id
    where a.id = target_asset_id
      and (a.user_id = account_id or p.user_id = account_id)
  );
$$;

comment on function account_owns_asset(uuid, uuid) is
  'Whether `account_id` owns `target_asset_id`, directly (assets.user_id) or through the project '
  'holding it (projects.user_id) -- the same two ownership branches assets_select uses. One '
  'definition shared by 0091''s write-time trigger and its read-time policy branch so the two '
  'cannot drift. security definer because ownership is not a question of who is asking.';

-- ---------------------------------------------------------------------------
-- Write-time guard: an element may only point at its own owner's asset.
-- ---------------------------------------------------------------------------
create or replace function elements_guard_asset_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    -- user_id is what elements_update and elements_delete authorise against.
    -- A row that could change hands would defeat both of them.
    if new.user_id is distinct from old.user_id then
      raise exception 'elements.user_id is immutable (row %).', old.id
        using errcode = 'check_violation';
    end if;

    -- An unchanged pointer needs no re-proof: it was checked when it was set,
    -- and re-checking here would refuse an ordinary rename of a row whose
    -- project was since handed elsewhere.
    if new.asset_id is not distinct from old.asset_id then
      return new;
    end if;
  end if;

  if not account_owns_asset(new.user_id, new.asset_id) then
    raise exception
      'elements.asset_id must reference an asset owned by the element''s own account; '
      'refusing asset % for account %.', new.asset_id, new.user_id
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

comment on function elements_guard_asset_ownership() is
  'Refuses an element pointing at an asset its own owner does not own, and pins user_id immutable. '
  'This is what stops the shared library (0091) becoming an arbitrary-file read: without it an '
  'account could insert an element naming somebody else''s asset id and have the grid sign that '
  'object for them. A TRIGGER rather than a policy because every write in this app arrives through '
  'the service role, which bypasses RLS but not this.';

create trigger elements_guard_asset_ownership
  before insert or update on elements
  for each row
  execute function elements_guard_asset_ownership();

-- ---------------------------------------------------------------------------
-- assets_select gains ONE branch: the asset behind a shared element.
--
-- Restated in full rather than altered as a fragment, because `alter policy ...
-- using (...)` REPLACES the predicate outright -- which is how 0085 dropped
-- is_active() from six policies and needed 0086 to put it back. The first three
-- branches are 0085's as corrected by 0086, unchanged; the fourth is new.
--
-- THE OWNERSHIP CONDITION IS RESTATED HERE, not assumed from the trigger.
-- Element rows written before 0091 were never checked, so a branch that trusted
-- provenance would be trusting precisely the thing nothing enforced. As written,
-- a pre-existing forged row exposes nothing: the asset is admitted only if the
-- element's owner really owns it.
--
-- SELECT ONLY, and one asset at a time by id. insert/update/delete on `assets`
-- are untouched, so a shared element grants nobody a write; and this admits the
-- asset a shared element points at, never a project's contents -- projects stay
-- private, projects_select is not touched by this migration.
-- ---------------------------------------------------------------------------
alter policy assets_select on assets
  using (
    assets.user_id = auth.uid()
    or (assets.user_id is not null and is_admin())
    or exists (
      select 1 from projects p
      where p.id = assets.project_id
        and (p.user_id = auth.uid() or is_admin())
    )
    or exists (
      select 1 from elements e
      where e.asset_id = assets.id
        and account_owns_asset(e.user_id, assets.id)
    )
  );

comment on policy assets_select on assets is
  'Own project-backed assets (through projects.user_id), own personal assets (assets.user_id, '
  '0085), anything an admin reads -- plus, since 0091, the asset behind a shared Elements Library '
  'row, because `elements.asset_id` is a POINTER rather than a copy and the shared grid has to '
  'render other people''s pictures. That fourth branch re-proves that the element''s owner owns '
  'the asset rather than trusting it: rows predating 0091''s trigger were never checked, so a '
  'forged asset_id exposes nothing. SELECT only -- assets_insert/update/delete are untouched, so a '
  'shared element hands nobody a write on the object behind it.';

-- =============================================================================
-- element_creators() -- who saved each element, as a display name
-- =============================================================================
-- The grid names the owner beside every card, and an editor cannot read another
-- account's `profiles` row: profiles_select_own covers their own, and
-- profiles_select_admin covers approvers only.
--
-- The same judgement made for every other cross-account display name here:
-- rather than widen a profiles policy -- which hands every editor the whole table for
-- every purpose, including the ones nobody decided to grant -- this is a
-- security definer function returning ONE fixed projection (id, display name) of
-- ONE fixed set (accounts that have actually saved at least one element). Not a
-- view: a view needs a policy behind it and stays reachable by whatever column
-- selection the caller chooses.
--
-- Bounded on both ends. The set is only accounts whose entries the caller can
-- already see under elements_select, so it discloses no account the grid does
-- not already show; and `is_active()` in the WHERE means an unapproved or
-- suspended caller gets an empty result rather than a user directory.
--
-- No grant statement: 0007_grants.sql's `alter default privileges ... grant
-- execute on functions to authenticated` already covers a function created
-- afterwards.
create or replace function element_creators()
returns table (
  id           uuid,
  display_name text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    p.id,
    -- username is nullable (0015_profile_username.sql added it to an existing
    -- table), and a card reading "saved by --" is worse than one naming the
    -- address the account signed up with.
    coalesce(p.username, p.email) as display_name
  from profiles p
  where is_active()
    and exists (select 1 from elements e where e.user_id = p.id);
$$;

comment on function element_creators() is
  'Display name per account that has saved at least one element, for the "saved by" line on a '
  'card. security definer because an editor cannot read another account''s profiles row; '
  'deliberately a fixed projection of a fixed set rather than a widening of profiles_select_admin '
  'Returns '
  'EMPTY for an unapproved or suspended caller (the is_active() in the WHERE), so a blocked '
  'account learns nothing about who exists.';
