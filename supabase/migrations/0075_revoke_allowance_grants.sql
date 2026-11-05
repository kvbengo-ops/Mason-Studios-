-- =============================================================================
-- Revoking an allowance grant — the undo 0032 deliberately left out, added
-- back without giving up what that decision was protecting.
-- =============================================================================
-- 0032_allowance_requests.sql gave allowance_grants no UPDATE and no DELETE
-- policy, and said why in the table comment: "A row here is never updated or
-- deleted: correcting a mistaken grant means a new, smaller/expired one, or
-- letting this one expire, not rewriting history."
--
-- That held right up until someone approved the wrong amount. The two escape
-- hatches it names are both worse than they sound. "A new, smaller one" does
-- not work at all — grants SUM (user_active_grants_usd below), so a second
-- grant raises the ceiling further rather than correcting the first. "Letting
-- it expire" means up to a week of an allowance an admin has already decided
-- was wrong, and the only faster path was an UPDATE typed into the Supabase
-- dashboard by hand, which is precisely the un-audited rewrite 0032 was
-- trying to prevent.
--
-- So this does not weaken the ledger rule, it completes it. revoked_at is a
-- SECOND FACT appended to the row, not an edit of the first: the grant, its
-- amount, who granted it and when all stay exactly as written, and the
-- revocation records who ended it and when. History is added to, never
-- rewritten — which is what "append-only" was actually protecting. The four
-- aggregates below stop counting the row; nothing forgets it happened.
--
-- No UPDATE policy is added. The write goes through createAdminClient()
-- (service role, BYPASSRLS) from a requireAdmin()-guarded Server Action, the
-- same shape setTrustedEditor and setWeeklyCapOverride already use for
-- profiles — a table which likewise has no UPDATE policy at all. So the
-- table stays default-deny through PostgREST for every real user JWT,
-- including an admin's own, and "an editor revokes a grant" remains
-- unreachable rather than merely unauthorized.
--
-- WHY FOUR FUNCTIONS. Every place that answers "what is this account's
-- effective weekly allowance" filters on `expires_at > at_ts`, and every one
-- of them now has to exclude revoked rows too. Missing one does not error —
-- it silently keeps a revoked grant funding renders, which is the exact bug
-- this migration exists to make impossible. They are redefined here rather
-- than left to a later reader to find:
--
--   1. user_active_grants_usd            (0032) — enforcement, via lib/spend.ts
--   2. user_active_grants_usd_by_user    (0033) — /users' Active grants column
--   3. outstanding_allowance_usd         (0035) — /allowances' admin tile
--   4. sidebar_budget_snapshot           (0044) — the account menu's two
--                                                 inline grant subqueries
--
-- web/lib/revoked-grants-drift.test.ts asserts this file is the complete set,
-- so a fifth reader added later cannot quietly forget the filter.
-- =============================================================================

alter table allowance_grants
  add column revoked_at timestamptz,
  add column revoked_by uuid references profiles(id);

comment on column allowance_grants.revoked_at is
  'When an admin ended this grant early, or NULL while it still counts. A grant is active when '
  'revoked_at is null AND expires_at > now() — see this migration''s header for why this is an '
  'appended fact rather than a deletion, and why all four aggregates below had to learn it at '
  'once. Set only by web/actions/allowance.ts''s endActiveGrants and web/actions/account.ts''s '
  'zero-allowance writes, both through the service role.';

comment on column allowance_grants.revoked_by is
  'The admin who revoked, mirroring granted_by for the other end of the grant''s life. Not null '
  'exactly when revoked_at is not null; not enforced as a constraint because the single writer '
  'sets both in one statement and a CHECK here would buy nothing a second column could not.';

comment on table allowance_grants is
  'A ledger entry raising one account''s EFFECTIVE WEEKLY allowance (web/lib/spend.ts folds the '
  'sum of a user''s active grants into resolveAccountCaps'' weekly figure) — never the daily burst '
  'guard. Rows are APPENDED TO, never rewritten: a mistaken grant is ended by setting revoked_at '
  '(0075_revoke_allowance_grants.sql), which stops it counting while leaving the original amount, '
  'grantor and timestamp intact. Correcting an amount still means a new grant, not an edit.';

-- Supports "this user's grants that still count" — the same lookup
-- allowance_grants_user_id_expires_at_idx (0032) already serves, now that
-- every such query carries `revoked_at is null` as well. A partial index on
-- that predicate is deliberately NOT added: revoked rows are the rare case
-- by construction (an admin has to act to create one), so the existing
-- composite index still selects nearly the same rows and the extra filter is
-- a cheap recheck on a handful of tuples per account.

-- =============================================================================
-- 1. user_active_grants_usd (0032) — the enforcement path
-- =============================================================================
-- Byte-for-byte 0032's definition with `and g.revoked_at is null` appended.
-- This is the one that matters most: getEffectiveWeeklyCapUsd folds it into
-- the cap assertWeeklyCapNotExceeded refuses renders against, so a revoked
-- grant left counting here is a revoked grant still spending money.
create or replace function user_active_grants_usd(target_user_id uuid, at_ts timestamptz)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(g.amount_usd), 0)
  from allowance_grants g
  where g.user_id = target_user_id
    and g.expires_at > at_ts
    and g.revoked_at is null;
$$;

comment on function user_active_grants_usd is
  'Sum of amount_usd for every ACTIVE allowance_grants row belonging to target_user_id: not '
  'expired as of at_ts (expires_at > at_ts — a grant expiring at exactly at_ts is treated as '
  'already gone, matching every other cap check in this schema''s "landing exactly on the '
  'boundary" convention) and not revoked (revoked_at is null, 0075_revoke_allowance_grants.sql). '
  'web/lib/spend.ts folds this into the account''s effective weekly cap. security invoker, '
  '`language sql`, no special grant needed — 0007_grants.sql''s default privileges already cover '
  'any function this migration''s role creates, same as user_spend_usd.';

-- =============================================================================
-- 2. user_active_grants_usd_by_user (0033) — the batched twin
-- =============================================================================
create or replace function user_active_grants_usd_by_user(target_user_ids uuid[], at_ts timestamptz)
returns table(user_id uuid, total_usd numeric, grant_count integer)
language sql
stable
security invoker
set search_path = public
as $$
  select g.user_id, sum(g.amount_usd) as total_usd, count(*)::integer as grant_count
  from allowance_grants g
  where g.user_id = any(target_user_ids)
    and g.expires_at > at_ts
    and g.revoked_at is null
  group by g.user_id;
$$;

comment on function user_active_grants_usd_by_user is
  'Batched twin of user_active_grants_usd: sum(amount_usd) and count(*) of every ACTIVE '
  '(expires_at > at_ts and revoked_at is null) allowance_grants row, grouped by user_id, for '
  'every id in target_user_ids. Backs web/app/(app)/users/page.tsx''s Active grants column — '
  'replaces an unbounded fetch-and-reduce in JS that silently truncated past PostgREST''s '
  'max_rows = 1000 (supabase/config.toml). A user with no active grants has no row in the result '
  '(plain GROUP BY, no LEFT JOIN against target_user_ids) — callers read a missing key as $0/0 '
  'grants, same contract as every other Map-shaped aggregate in web/lib/db-aggregates.ts. '
  'security invoker, `language sql`, no special grant needed — 0007_grants.sql''s default '
  'privileges already cover any function this migration''s role creates.';

-- =============================================================================
-- 3. outstanding_allowance_usd (0035) — the admin's "authorised vs. funded"
-- =============================================================================
-- Revoking has to move this number too, or /allowances keeps warning an admin
-- that outstanding allowance exceeds account funds using allowance they have
-- already taken back.
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
      and g.revoked_at is null
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
  'weekly_cap_override_usd) plus its ACTIVE allowance_grants (unexpired and not revoked, '
  '0075_revoke_allowance_grants.sql) — the same figure lib/spend.ts''s getEffectiveWeeklyCapUsd '
  'computes for enforcement. Admins are excluded — see 0035_outstanding_allowance.sql''s header '
  'for why folding in a $700/week default would swamp the signal this number exists to be. One '
  'bounded aggregate, no row fetch: see that migration''s header for the max_rows = 1000 '
  'under-reporting bug (0026_cost_aggregates.sql) this shape exists to avoid repeating. Backs '
  '/allowances'' summary tiles and the approve dialog (web/app/(app)/allowances/page.tsx, '
  'web/components/decide-allowance-request-dialog.tsx) via web/lib/db-aggregates.ts''s '
  'getOutstandingAllowanceUsd.';

-- =============================================================================
-- 4. sidebar_budget_snapshot (0044) — the account menu's own two subqueries
-- =============================================================================
-- Its active_grants_usd column calls user_active_grants_usd above and so is
-- already fixed by (1). The two INLINE subqueries beside it are not — they
-- re-state the predicate rather than calling the function (0044's own comment
-- explains why: they need count and min(expires_at), which that function does
-- not return). Restated predicates are exactly what drifts, so both get the
-- filter here and the drift test names this function.
create or replace function sidebar_budget_snapshot(
  target_user_id uuid,
  day_start_ts timestamptz,
  week_start_ts timestamptz,
  now_ts timestamptz
)
returns table (
  daily_spent_usd numeric,
  weekly_spent_usd numeric,
  global_spent_today_usd numeric,
  active_grants_usd numeric,
  grant_count integer,
  grant_earliest_expires_at timestamptz,
  pending_request_id uuid,
  pending_request_usd numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    user_spend_usd(target_user_id, day_start_ts, now_ts)   as daily_spent_usd,
    user_spend_usd(target_user_id, week_start_ts, now_ts)  as weekly_spent_usd,
    spend_total_usd(day_start_ts, now_ts)                  as global_spent_today_usd,
    user_active_grants_usd(target_user_id, now_ts)         as active_grants_usd,

    (
      select count(*)::integer
      from allowance_grants
      where user_id = target_user_id
        and expires_at > now_ts
        and revoked_at is null
    ) as grant_count,
    (
      select min(expires_at)
      from allowance_grants
      where user_id = target_user_id
        and expires_at > now_ts
        and revoked_at is null
    ) as grant_earliest_expires_at,

    (
      select id
      from allowance_requests
      where user_id = target_user_id
        and status = 'pending'
      limit 1
    ) as pending_request_id,
    (
      select requested_usd
      from allowance_requests
      where user_id = target_user_id
        and status = 'pending'
      limit 1
    ) as pending_request_usd;
$$;

comment on function sidebar_budget_snapshot is
  'One-round-trip replacement for the sidebar footer''s six concurrent reads (web/lib/sidebar-'
  'budget.ts''s getSidebarBudget) -- see 0044_sidebar_budget_snapshot.sql''s header for the '
  'measured Supabase concurrency ceiling that made firing them in parallel the cost, not the fix. '
  'Calls user_spend_usd/spend_total_usd/user_active_grants_usd (0031/0032, redefined by '
  '0040_include_archived_cost_in_spend_reads.sql and 0075_revoke_allowance_grants.sql) rather '
  'than reimplementing their SQL, so the sidebar''s figures can never drift from what '
  'assertWithinSpendCaps enforces. Its two inline grant subqueries carry the same active '
  'predicate by hand (expires_at > now_ts and revoked_at is null) because they need count and '
  'min(expires_at), which that function does not return. day_start_ts/week_start_ts/now_ts are '
  'computed in TypeScript (web/lib/spend.ts''s startOfManilaDayIso/startOfManilaWeekIso, '
  'Asia/Manila day and Monday-reset week) and passed in -- this function computes no time '
  'boundary of its own. Returns raw spent/grant/pending-request figures only, never a cap or a '
  'remaining amount -- caps stay ENV, resolved by web/lib/spend.ts''s resolveAccountCaps.';

-- No new grants needed beyond what 0007_grants.sql's default privileges
-- already cover for this role's functions — same note every migration since
-- 0026 has relied on.
