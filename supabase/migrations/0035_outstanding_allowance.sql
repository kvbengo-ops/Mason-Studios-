-- =============================================================================
-- outstanding_allowance_usd — the number nobody has today at the moment an
-- admin decides an allowance request: what could still be spent this Manila
-- week if every non-admin account used every dollar of its own effective
-- weekly allowance. 20 editors x $10/week authorised vs. ~$31 actually
-- funded in the fal account is the concrete case this exists to surface —
-- see this task's own framing.
--
-- NOT APPLIED as of this migration being written — same constraint as
-- 0031/0032/0033: reviewed and staged, not run. I apply migrations myself.
-- =============================================================================
--
-- Definition: for the CURRENT Manila calendar week, sum over accounts of
-- max(0, effective weekly allowance - spent this week) — "effective weekly
-- allowance" being resolveAccountCaps(profile).weeklyCapUsd (role default or
-- per-account override) PLUS that account's currently-unexpired
-- allowance_grants, exactly the figure lib/spend.ts's getEffectiveWeeklyCapUsd
-- already computes for enforcement. This view does not invent a new notion of
-- "allowance" — it sums the same one, per account, in SQL.
--
-- Why this can't be pure SQL with no TypeScript input at all: the ROLE
-- DEFAULT half of that figure lives in render.yaml env vars
-- (WEEKLY_CAP_USD / TRUSTED_WEEKLY_CAP_USD, lib/spend.ts) — a SQL function
-- has no access to those, the same reason account_spend_windows
-- (0031_account_allowances.sql) deliberately does NOT resolve an effective
-- cap itself and leaves that to lib/spend.ts's resolveAccountCaps in
-- application code. The two role defaults this function needs are passed in
-- as ARGUMENTS by the caller (web/lib/db-aggregates.ts's
-- getOutstandingAllowanceUsd, called with WEEKLY_CAP_USD/
-- TRUSTED_WEEKLY_CAP_USD) — everything else (which override applies, which
-- grants are active, what was actually spent) is resolved here, in one
-- bounded SUM/GROUP-free aggregate over `profiles`, not by fetching rows and
-- reducing them in application code. PostgREST's max_rows = 1000
-- (supabase/config.toml) is exactly the ceiling 0026_cost_aggregates.sql's
-- header warns never to risk on a team-wide dollar sum, and lib/spend.ts's
-- own file header cites that same episode as the standing reason this schema
-- never fetch-and-reduces — a per-account fetch-and-reduce across every
-- account in the system is precisely that shape, so this is SUM() in
-- Postgres instead, which has no row cap to silently cross.
--
-- Admins excluded, not shown separately: an admin's own weekly figure
-- defaults to $700 (ADMIN_WEEKLY_CAP_USD = 7 x ADMIN_DAILY_CAP_USD's default
-- of $100, lib/spend.ts) — a single admin account included in this sum would
-- swamp every editor's contribution combined (20 editors x $10/week = $200
-- vs. one admin's $700) and turn "outstanding allowance across all accounts"
-- into "roughly one admin's ceiling plus noise", which defeats the number's
-- purpose: a signal for whether ORDINARY production usage is authorised
-- beyond what the fal account can fund. Admins also aren't the accounts an
-- admin is deciding a GRANT for in this workflow — allowance_requests can
-- only be filed by whoever hits their own weekly cap doing render work, and
-- nothing in this schema treats an admin's role as a production-spend tier
-- (0031_account_allowances.sql's own header: "'trusted_editor' is a SPEND
-- tier, not a VISIBILITY tier" — admin never was one either). A future admin
-- who *does* want the admin figure has it already: /users' per-row "This
-- week" column and the sidebar's own "Team:" line both already show an
-- individual account's (including an admin's own) weekly and daily figures
-- — this function's total is additive across editors/trusted editors only,
-- deliberately not a second copy of those existing per-account reads.
create or replace function outstanding_allowance_usd(
  editor_weekly_default numeric,
  trusted_weekly_default numeric
)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    sum(
      greatest(
        0,
        (
          coalesce(
            p.weekly_cap_override_usd,
            case p.role
              when 'trusted_editor' then trusted_weekly_default
              else editor_weekly_default
            end
          )
          + coalesce(grants.total_usd, 0)
        )
        - coalesce(spent.spend_usd, 0)
      )
    ),
    0
  )
  from profiles p
  left join lateral (
    select sum(g.amount_usd) as total_usd
    from allowance_grants g
    where g.user_id = p.id
      and g.expires_at > now()
  ) grants on true
  left join lateral (
    select sum(r.cost_usd) as spend_usd
    from runs r
    join projects pr on pr.id = r.project_id
    where pr.user_id = p.id
      and r.created_at >= (date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')
  ) spent on true
  where p.role <> 'admin';
$$;

comment on function outstanding_allowance_usd is
  'Sum over non-admin accounts, for the current Manila calendar week, of max(0, effective weekly '
  'allowance - spent this week) — what could still be spent if every editor/trusted_editor used '
  'their full weekly allowance. "Effective weekly allowance" is resolveAccountCaps(profile).'
  'weeklyCapUsd (role default, passed in via editor_weekly_default/trusted_weekly_default since a '
  'SQL function has no access to render.yaml env vars, OR this account''s own '
  'weekly_cap_override_usd) plus its unexpired allowance_grants — the same figure lib/spend.ts''s '
  'getEffectiveWeeklyCapUsd computes for enforcement. Admins are excluded — see this migration''s '
  'header for why folding in a $700/week default would swamp the signal this number exists to be. '
  'One bounded aggregate, no row fetch: see this migration''s header for the max_rows = 1000 '
  'under-reporting bug (0026_cost_aggregates.sql) this shape exists to avoid repeating. Backs '
  '/allowances'' summary tiles and the approve dialog (web/app/(app)/allowances/page.tsx, '
  'web/components/decide-allowance-request-dialog.tsx) via web/lib/db-aggregates.ts''s '
  'getOutstandingAllowanceUsd.';

-- No new grants needed beyond what 0007_grants.sql's default privileges
-- already cover for this role's functions — same note every migration since
-- 0026 has relied on.
-- =============================================================================
