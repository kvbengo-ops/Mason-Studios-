-- =============================================================================
-- 0129_profiles_team.sql
-- A team tag on profiles: which video models an account may use
-- (web/lib/model-access.ts). Orthogonal to role: role still controls spend and
-- permissions, the team only gates models. NULL means no restriction, so
-- nobody loses access on deploy; an admin assigns teams from Accounts Control.
--
-- RLS: nothing to add. profiles has select policies only (0002_rls.sql) and no
-- UPDATE policy for anyone, so no signed-in client can write this column. The
-- only writer is web/actions/accounts-control.ts's setAccountTeam through the
-- service-role client, behind requireAdmin.
-- =============================================================================
alter table public.profiles
  add column team text null
    constraint profiles_team_check check (team in ('hybrid_editor', 'ai_animator'));

comment on column public.profiles.team is
  'Which video models this account may use: hybrid_editor (every model except wan-3.0) or ai_animator '
  '(every model). NULL = unrestricted. Written only by an admin, through setAccountTeam.';
