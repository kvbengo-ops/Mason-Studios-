-- =============================================================================
-- One column comment, re-issued — because 0075 can never carry it.
-- =============================================================================
-- 0075_revoke_allowance_grants.sql was applied to production on 2026-09-03
-- from an unpushed working copy, before it existed on any branch. The DDL
-- production holds is identical to what that file now says, verified
-- statement by statement against supabase_migrations.schema_migrations, with
-- one exception: this comment.
--
-- The file's own text changed after it ran, when revokeActiveGrants was
-- renamed to endActiveGrants and a second writer (actions/account.ts's
-- zero-allowance path) was added. Production still holds the sentence as it
-- was applied, naming a function that no longer exists in the codebase.
--
-- WHY A NEW FILE RATHER THAN EDITING 0075. The migration ledger already
-- records version 0075, so `supabase db push` skips that file entirely — the
-- corrected sentence cannot reach production through it by any normal route,
-- now or later. And 0075 is not idempotent (its `alter table ... add column`
-- would error on a re-run), so it cannot simply be replayed. A separate
-- one-statement migration is the only path that actually lands.
--
-- Cosmetic on purpose: this changes a database doc comment and nothing else.
-- No DDL, no data, no behaviour. It exists so that someone reading the schema
-- in a year is not sent looking for a function that was renamed before they
-- arrived.
-- =============================================================================

comment on column allowance_grants.revoked_at is
  'When an admin ended this grant early, or NULL while it still counts. A grant is active when '
  'revoked_at is null AND expires_at > now() — see 0075_revoke_allowance_grants.sql''s header for '
  'why this is an appended fact rather than a deletion, and why all four aggregates had to learn '
  'it at once. Two writers, both through the service role behind requireAdmin(): '
  'web/actions/allowance.ts''s endActiveGrants, and web/actions/account.ts''s zero-allowance '
  'writes (setWeeklyCapOverride and setAllEditorsWeeklyCap, which revoke when the value is 0).';
