-- =============================================================================
-- Put is_active() on the elements write policies
--
-- 0065 created `elements` with owner-only write policies but no approval
-- gate, so a suspended or not-yet-approved account could insert, update and
-- delete rows in it.
--
-- This is the same half-finished shape 0053 exists to correct. 0052 added
-- is_active() to projects_insert_own ONLY, and 0053's own header describes
-- chasing it down through scenes, assets and runs afterwards — a new table
-- landing without the gate is that story starting over, so it is closed here
-- rather than left as the next person's surprise.
--
-- SEVERITY IS LOW AND SAYING SO IS PART OF THE RECORD. An element costs
-- nothing to create; it is a name pointing at an asset. And every live path
-- into this table goes through a Server Action behind requireUser, which
-- already redirects an unapproved account to /pending via canUseApp. So this
-- closes a gap in the second line of defence, not the first.
--
-- What it is NOT is cosmetic. RLS is the layer that still holds when the
-- TypeScript guard is the thing that was forgotten, which is the entire
-- reason 0002 wrote these policies in the first place. A table whose write
-- policies disagree with every sibling table's is also a table the next
-- person copies from.
--
-- SELECT is deliberately left alone. is_active() gates WRITES across this
-- schema; reads stay owner-or-admin, matching scenes/assets/runs, so a
-- suspended operator can still see what they made and an admin reviewing an
-- account is not blocked from looking at it.
-- =============================================================================

drop policy elements_insert on elements;

create policy elements_insert on elements
  for insert
  with check (
    is_active()
    and user_id = auth.uid()
  );

drop policy elements_update on elements;

create policy elements_update on elements
  for update
  using (
    is_active()
    and user_id = auth.uid()
  )
  with check (
    is_active()
    and user_id = auth.uid()
  );

drop policy elements_delete on elements;

create policy elements_delete on elements
  for delete
  using (
    is_active()
    and user_id = auth.uid()
  );
