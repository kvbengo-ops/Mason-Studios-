-- =============================================================================
-- 0130_profiles_last_seen.sql
-- Presence heartbeat for Accounts Control's green/red dot. The app's layout
-- calls touchPresence() every 60s while a tab is visible; it writes the
-- caller's own row through the service-role client after requireUser.
--
-- RLS: nothing to add, for the same reason as 0129: profiles has no UPDATE
-- policy, so no client can write this column directly.
-- =============================================================================
alter table public.profiles
  add column last_seen_at timestamptz null;

comment on column public.profiles.last_seen_at is
  'Last presence heartbeat (actions/presence.ts touchPresence). Accounts Control shows green within 2 minutes.';
