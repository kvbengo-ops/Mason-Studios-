-- =============================================================================
-- Put is_active() back on the six write policies 0085 rewrote, and stop
-- assets_insert admitting one account's user_id beside another's project_id.
-- =============================================================================
--
-- TWO FIXES, ONE MIGRATION, because they touch the same predicates and
-- splitting them would mean rewriting each policy twice.
--
-- -----------------------------------------------------------------------------
-- 1. THE REGRESSION. 0085 dropped the account-status gate from six policies.
-- -----------------------------------------------------------------------------
--
-- 0053_active_gate_on_child_writes.sql put `is_active()` on the nine
-- scenes/assets/runs write policies: an account that has been rejected or
-- deactivated must not be able to write project children, and 0052 had only
-- gated projects_insert_own.
--
-- 0085 needed those predicates to admit a new owner shape, and used
-- `alter policy ... using (...)`, which REPLACES the predicate outright. The
-- replacement was written from the ownership rule alone, so `is_active()`
-- went with it -- silently, because nothing in the new expression refers to
-- what it replaced. Six policies lost the gate:
--
--     assets_insert  assets_update  assets_delete
--     runs_insert    runs_update    runs_delete
--
-- scenes_* kept theirs only because 0085 had no reason to touch scenes.
--
-- Confirmed against production before writing this, by asking every one of the
-- nine policies whether its expression still mentions is_active(): three yes,
-- six no. And confirmed as REACHABLE by the store suite --
-- TestRLSRejectedAccountCannotWriteProjectChildren fails on 0085, with a
-- rejected account inserting a run and an asset into its own project and
-- deleting its own spend rows. That test exists for exactly this and it was
-- not run: it needs a Postgres that CI would have provided, and CI has been
-- blocked on an unpaid bill.
--
-- WHAT IT DID NOT COST, stated so this is not read as worse than it is: every
-- write in this app goes through the service-role client, which bypasses RLS
-- entirely (0002_rls.sql's header). No rejected account could reach these
-- tables through the product. This is the second line failing, not the first.
--
-- -----------------------------------------------------------------------------
-- 2. assets_insert admitted my user_id with your project_id.
-- -----------------------------------------------------------------------------
--
-- 0085's version:
--
--     with check (
--       assets.user_id = auth.uid()
--       or exists (select 1 from projects p
--                   where p.id = assets.project_id and p.user_id = auth.uid())
--     )
--
-- The branches are independent and assets_owner_present_check permits BOTH
-- columns being set, so naming my own user_id was enough to insert into
-- somebody else's project -- the second branch was never consulted, and the
-- row then appears for that project's owner through assets_select. Proved on
-- production inside a rolled-back transaction, as the `authenticated` role
-- with request.jwt.claims set: the insert was ADMITTED.
--
-- Permissive policies OR together. A branch that is too wide cannot be
-- narrowed by the branch beside it -- the same shape as
-- 0048_fix_media_policy_folder_index.sql, where media_insert matching on a
-- project id alone made avatar_insert's own restriction irrelevant.
--
-- The fix is one clause: the personal branch also requires that there is no
-- project. An asset belongs to an account or to a project, and if it names a
-- project, that project must be the caller's.
--
-- INSERT ONLY for this half. assets_select keeps both branches independent on
-- purpose: an admin reads personal assets, and a project's owner reads
-- everything in their project -- including, if one ever existed, a row like
-- the above, which is exactly who would need to find it. update/delete are
-- ownership tests over rows that already exist; the hole was about CREATING a
-- row that names two owners.
--
-- -----------------------------------------------------------------------------
-- Shape note: `is_active() and (...)`, with the ownership rule parenthesised.
-- Written this way rather than distributing is_active() into each branch so
-- that a future widening of the ownership rule cannot drop the gate from one
-- branch and keep it in the other -- which is a smaller version of the mistake
-- this migration exists to fix.
-- -----------------------------------------------------------------------------

-- ---- assets ----------------------------------------------------------------

alter policy assets_insert on assets
  with check (
    is_active()
    and (
      (assets.user_id = auth.uid() and assets.project_id is null)
      or exists (
        select 1 from projects p
        where p.id = assets.project_id
          and p.user_id = auth.uid()
      )
    )
  );

alter policy assets_update on assets
  using (
    is_active()
    and (
      assets.user_id = auth.uid()
      or exists (
        select 1 from projects p
        where p.id = assets.project_id
          and p.user_id = auth.uid()
      )
    )
  )
  with check (
    is_active()
    and (
      assets.user_id = auth.uid()
      or exists (
        select 1 from projects p
        where p.id = assets.project_id
          and p.user_id = auth.uid()
      )
    )
  );

alter policy assets_delete on assets
  using (
    is_active()
    and (
      assets.user_id = auth.uid()
      or exists (
        select 1 from projects p
        where p.id = assets.project_id
          and p.user_id = auth.uid()
      )
    )
  );

-- ---- runs ------------------------------------------------------------------

alter policy runs_insert on runs
  with check (
    is_active()
    and (
      runs.user_id = auth.uid()
      or exists (
        select 1 from projects p
        where p.id = runs.project_id
          and p.user_id = auth.uid()
      )
    )
  );

alter policy runs_update on runs
  using (
    is_active()
    and (
      runs.user_id = auth.uid()
      or exists (
        select 1 from projects p
        where p.id = runs.project_id
          and p.user_id = auth.uid()
      )
    )
  )
  with check (
    is_active()
    and (
      runs.user_id = auth.uid()
      or exists (
        select 1 from projects p
        where p.id = runs.project_id
          and p.user_id = auth.uid()
      )
    )
  );

alter policy runs_delete on runs
  using (
    is_active()
    and (
      runs.user_id = auth.uid()
      or exists (
        select 1 from projects p
        where p.id = runs.project_id
          and p.user_id = auth.uid()
      )
    )
  );

comment on policy assets_insert on assets is
  'Insert an asset into your OWN project (through projects.user_id), or a personal one with no '
  'project at all (assets.user_id, 0085) -- and only while your account is active (is_active(), '
  '0053, restored by 0086). The `project_id is null` on the personal branch is not redundant: '
  'without it (0085 as shipped) a caller could insert user_id = themselves alongside another '
  'account''s project_id, and the row would then be visible to that project''s owner through '
  'assets_select. Permissive policies OR together, so a branch that is too wide cannot be narrowed '
  'by the branch beside it -- see 0048_fix_media_policy_folder_index.sql for the same shape in '
  'storage.';

comment on policy runs_insert on runs is
  'Record a run against your OWN project, or against yourself for a project-less charge '
  '(runs.user_id, 0085) -- and only while your account is active (is_active(), 0053, restored by '
  '0086, which 0085''s `alter policy` had replaced away).';
