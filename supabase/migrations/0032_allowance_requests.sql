-- =============================================================================
-- Allowance request -> grant workflow
-- (docs/Account_Usage_and_Cost_Control_Plan_Proposal.md phase 3, explicitly
-- deferred by 0031_account_allowances.sql's header — this is that follow-up).
--
-- NOT APPLIED as of this migration being written — same constraint as 0031:
-- reviewed and staged, not run.
--
-- Shape: an editor who trips the WEEKLY cap (assertWeeklyCapNotExceeded,
-- lib/spend.ts) can ask for more; an admin approves (creating a grant) or
-- denies. A grant raises the account's EFFECTIVE WEEKLY allowance only — see
-- web/lib/spend.ts for why the daily burst guard is deliberately left alone
-- (they guard against different things, and raising both on every grant
-- would silently destroy the daily guard's whole job).
-- =============================================================================

-- =============================================================================
-- 1. allowance_requests — one editor's ask, decided at most once
-- =============================================================================
create table allowance_requests (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references profiles(id) on delete cascade,
  requested_usd  numeric not null,
  reason         text,
  status         text not null default 'pending',
  decided_by     uuid references profiles(id),
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz not null default now()
);

alter table allowance_requests
  add constraint allowance_requests_requested_usd_check check (requested_usd > 0);

-- CHECK, not a Postgres enum — see 0012_render_settings.sql's header for why
-- every "enum-ish" column in this schema is text + CHECK: widening a CHECK
-- to add a status later (e.g. an 'expired' terminal state) is a one-line
-- ALTER, not a type migration every reader of the enum also has to know
-- about.
alter table allowance_requests
  add constraint allowance_requests_status_check
  check (status in ('pending', 'approved', 'denied', 'cancelled'));

comment on table allowance_requests is
  'An editor''s ask for a higher weekly allowance (web/actions/allowance.ts''s requestAllowance) '
  'and its eventual decision. One row per ask — a re-request after a decision is a NEW row, this '
  'table is not updated in place to "re-open" a decided request.';

comment on column allowance_requests.requested_usd is
  'What the editor asked for, in dollars added to their weekly allowance. Purely informational '
  'once decided — an admin may grant a different amount (allowance_grants.amount_usd), including '
  'a smaller one, so this column is never read back as the actual grant size.';

comment on column allowance_requests.reason is
  'Free text the editor may supply explaining the ask. Nullable — a reason is a courtesy to the '
  'admin deciding it, not a requirement to file a request.';

comment on column allowance_requests.status is
  'CHECK-constrained, not a Postgres enum — see this migration''s header. ''pending'' (the only '
  'status an insert may set — see the insert RLS policy below) is the sole actionable value; '
  '''approved''/''denied'' are terminal decisions made by an admin (decideAllowanceRequest, '
  'web/actions/allowance.ts), and ''cancelled'' is the one transition a non-admin may make on '
  'their own row, and only while it is still ''pending'' (see the update RLS policy below).';

comment on column allowance_requests.decided_by is
  'The admin who approved or denied this request. NULL for a request that is still pending, or '
  'one the requester cancelled before any admin looked at it.';

comment on column allowance_requests.decision_note is
  'Free text an admin may leave explaining a decision (most useful on a denial, or on an approval '
  'for less than the amount requested). Nullable — a decision needs no explanation to be valid.';

-- One pending request per user, enforced by the database, not application
-- code (a partial unique index, not a plain unique index on user_id — a
-- user is free to have many DECIDED requests, just never two PENDING ones
-- at once). An application-code "check for an existing pending row, then
-- insert" is a check-then-act race exactly like the CONCURRENCY HOLE
-- lib/spend.ts documents for spend caps: a double-click (or two tabs) can
-- both pass the check before either insert lands, producing two pending
-- requests and, downstream, two grants for one ask. A unique index makes
-- the second insert fail at the database instead, atomically.
create unique index allowance_requests_one_pending_per_user
  on allowance_requests (user_id)
  where status = 'pending';

-- Supports both requireOwnPendingRequest-style lookups (web/actions/
-- allowance.ts) and the sidebar/status read (web/lib/sidebar-budget.ts) —
-- "this user's requests, newest first".
create index allowance_requests_user_id_created_at_idx
  on allowance_requests (user_id, created_at desc);

-- Supports /allowances' pending queue (web/app/(app)/allowances/page.tsx) —
-- "every pending request, oldest first" is the admin's actual worklist.
create index allowance_requests_status_created_at_idx
  on allowance_requests (status, created_at)
  where status = 'pending';

alter table allowance_requests enable row level security;

create policy allowance_requests_select on allowance_requests
  for select
  using (user_id = auth.uid() or is_admin());

-- status is forced to 'pending' here, not merely defaulted: DEFAULT
-- 'pending' governs an insert that omits the column, but says nothing about
-- one that explicitly sets status = 'approved' to skip the admin step
-- entirely. The with check below closes that regardless of what the insert
-- statement sends.
create policy allowance_requests_insert_own on allowance_requests
  for insert
  with check (user_id = auth.uid() and status = 'pending');

-- Two different actors, two different allowed transitions, one policy:
--   - an admin (is_admin()) may update any row to any legal state — that is
--     decideAllowanceRequest's whole job.
--   - a non-admin may touch only their OWN row, and only to cancel it while
--     it is still pending (using) — the with check then re-confirms the new
--     row is still theirs and now 'cancelled'. They may not approve/deny
--     their own request (with check rejects any other status change), and
--     may not touch anyone else's row (using rejects it outright).
create policy allowance_requests_update on allowance_requests
  for update
  using (is_admin() or user_id = auth.uid())
  with check (
    is_admin()
    or (user_id = auth.uid() and status = 'cancelled')
  );

-- =============================================================================
-- 2. allowance_grants — a ledger entry, never mutated once written
-- =============================================================================
create table allowance_grants (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  amount_usd  numeric not null,
  expires_at  timestamptz not null,
  granted_by  uuid not null references profiles(id),
  request_id  uuid references allowance_requests(id),
  note        text,
  created_at  timestamptz not null default now()
);

alter table allowance_grants
  add constraint allowance_grants_amount_usd_check check (amount_usd > 0);

comment on table allowance_grants is
  'A ledger entry raising one account''s EFFECTIVE WEEKLY allowance (web/lib/spend.ts folds the '
  'sum of a user''s unexpired grants into resolveAccountCaps'' weekly figure) — never the daily '
  'burst guard. A row here is never updated or deleted (see the RLS section below): correcting a '
  'mistaken grant means a new, smaller/expired one, or letting this one expire, not rewriting '
  'history.';

comment on column allowance_grants.amount_usd is
  'Dollars added to the account''s weekly allowance while this grant is active (created_at <= now '
  '< expires_at). Defaults to $5 increments in the /allowances UI, but the admin may enter any '
  'positive amount, including one smaller than what was requested.';

comment on column allowance_grants.expires_at is
  'NOT NULL — every grant expires. Defaults (in web/actions/allowance.ts) to the end of the '
  'current Asia/Manila week, the same boundary lib/spend.ts''s startOfManilaWeekIso enforces, so a '
  'grant lasts exactly as long as the weekly allowance it is topping up unless an admin explicitly '
  'extends it. A grant with no expiry would silently outlive the week it was meant for and keep '
  'inflating the allowance indefinitely.';

comment on column allowance_grants.request_id is
  'The allowance_requests row this grant approves, if any. Nullable — an admin may grant an '
  'account extra allowance with no request behind it (a proactive raise), which this column '
  'represents as simply having nothing to point to, not a synthetic self-approved request row.';

comment on column allowance_grants.note is
  'Free text an admin may leave on the grant itself (distinct from decision_note on the request '
  'this may or may not stem from) — the record that survives even for a grant with no request_id.';

-- Supports the active-grants lookup (web/lib/spend.ts's getActiveGrantsUsd,
-- and /users' "active grants" column) — "this user's unexpired grants",
-- i.e. `where user_id = ? and expires_at > now()`. A composite index with
-- expires_at second, not a separate index per column, because every real
-- query filters on both: user_id narrows to one account, expires_at then
-- narrows to the ones still active, and Postgres can satisfy that from a
-- single index scan instead of a bitmap AND of two.
create index allowance_grants_user_id_expires_at_idx
  on allowance_grants (user_id, expires_at);

alter table allowance_grants enable row level security;

create policy allowance_grants_select on allowance_grants
  for select
  using (user_id = auth.uid() or is_admin());

-- Admin only — an editor never creates their own grant, even for
-- themselves; decideAllowanceRequest (web/actions/allowance.ts) is the only
-- writer, and it always runs behind requireAdmin() first (defence in depth,
-- same as every other admin-only Server Action — the second line, not the
-- first, per 0002_rls.sql's own top-of-file note).
create policy allowance_grants_insert_admin on allowance_grants
  for insert
  with check (is_admin());

-- No update, no delete policy: a table with RLS enabled and no policy for a
-- command is default-deny for that command (0002_rls.sql's own header;
-- 0008's grants bug is the reason this fact is stated explicitly rather
-- than assumed obvious). That default is exactly what "a grant is a ledger
-- entry, not mutable state" (this table's comment) requires — there is
-- nothing to opt out of here, the absence of a policy IS the enforcement.

-- =============================================================================
-- 3. user_active_grants_usd — the per-user active-grants sum, mirroring
--    user_spend_usd's (0031_account_allowances.sql) shape and security
--    posture exactly.
-- =============================================================================
-- Same reasoning as user_spend_usd: aggregate in SQL rather than fetch a
-- user's grant rows and reduce() in application code (the /spend under-
-- count bug 0026_cost_aggregates.sql's header describes is the standing
-- reason this schema aggregates dollar sums in Postgres, not JS). `at_ts`
-- is a parameter, not `now()` inlined into the function body, so a caller
-- (and a test) can ask "what was active as of this instant" without
-- depending on wall-clock time at call time — the same testability
-- lib/spend.ts's exported startOfManilaDayIso/startOfManilaWeekIso get from
-- taking `now: Date` as a parameter.
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
    and g.expires_at > at_ts;
$$;

comment on function user_active_grants_usd is
  'Sum of amount_usd for every allowance_grants row belonging to target_user_id that has not yet '
  'expired as of at_ts (expires_at > at_ts — a grant expiring at exactly at_ts is treated as '
  'already gone, matching every other cap check in this schema''s "landing exactly on the '
  'boundary" convention). web/lib/spend.ts folds this into the account''s effective weekly cap. '
  'security invoker, `language sql`, no special grant needed — 0007_grants.sql''s default '
  'privileges already cover any function this migration''s role creates, same as user_spend_usd.';

-- =============================================================================
-- 4. decide_allowance_request — approve-and-grant atomically
-- =============================================================================
-- decideAllowanceRequest (web/actions/allowance.ts) must write the request's
-- decision AND create the grant as one atomic step for an approval — two
-- separate statements from application code leaves a window where the
-- request row is updated to 'approved' but the grant insert fails (a
-- dropped connection, a Postgres hiccup), leaving an approved request with
-- no grant behind it and no way to tell that happened short of an admin
-- noticing the account's allowance didn't actually move. A single
-- PL/pgSQL function wraps both writes in the function's own implicit
-- transaction, so either both happen or neither does.
--
-- Denial does not need this function — it is a single-row update
-- (allowance_requests.status = 'denied') with nothing else to keep in sync,
-- so web/actions/allowance.ts writes that directly through the admin client
-- rather than adding a second single-statement function here for symmetry's
-- own sake.
--
-- security definer, unlike every other function in this file/0031: the
-- caller here is an admin acting through their OWN session client (not the
-- service-role admin client — see web/actions/allowance.ts), and the
-- allowance_requests_update / allowance_grants_insert_admin RLS policies
-- above already let an admin perform both of these writes individually. A
-- security invoker function would work for that reason alone, but this one
-- is still marked security definer and re-checks is_admin() itself in the
-- function body as the FIRST statement, matching is_admin() itself
-- (0002_rls.sql) and user_spend_usd's own admin-adjacent posture: a
-- multi-statement function that touches two tables is exactly the kind of
-- surface where "RLS already covers this" is easy to get subtly wrong (e.g.
-- if a future edit adds a step RLS doesn't expect), so this function does
-- not lean on the caller's RLS context at all — it enforces the admin
-- check itself, once, up front, and is otherwise the only writer of these
-- two tables' post-decision state.
create or replace function decide_allowance_request(
  request_id uuid,
  approve boolean,
  grant_amount_usd numeric,
  grant_expires_at timestamptz,
  note text
)
returns allowance_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  decided_by_id uuid := auth.uid();
  updated_request allowance_requests;
begin
  if not is_admin() then
    raise exception 'decide_allowance_request: % is not an admin', decided_by_id;
  end if;

  update allowance_requests
  set status = case when approve then 'approved' else 'denied' end,
      decided_by = decided_by_id,
      decided_at = now(),
      decision_note = note
  where id = request_id
    and status = 'pending'
  returning * into updated_request;

  if updated_request.id is null then
    raise exception 'decide_allowance_request: request % is not pending (or does not exist)', request_id;
  end if;

  if approve then
    insert into allowance_grants (user_id, amount_usd, expires_at, granted_by, request_id, note)
    values (updated_request.user_id, grant_amount_usd, grant_expires_at, decided_by_id, request_id, note);
  end if;

  return updated_request;
end;
$$;

comment on function decide_allowance_request is
  'Approves or denies an allowance_requests row, and for an approval, inserts the matching '
  'allowance_grants row, in one transaction — see this migration''s header for why a partial '
  'failure here (decision written, grant not) cannot be allowed to happen. security definer: '
  'checks is_admin() itself as its first statement rather than relying on the caller''s RLS '
  'context, and is otherwise the sole post-decision writer of these two tables. Only a ''pending'' '
  'request can be decided (the UPDATE''s own WHERE, re-checked via updated_request.id is null) — '
  'deciding an already-decided or cancelled request raises rather than silently no-opping, so a '
  'second admin racing the first (or a stale page) gets a clear error instead of a duplicate '
  'grant.';

-- =============================================================================
-- 5. allowance_request_directory (view) — /allowances' sortable, searchable
--    admin queue, the same shape user_directory (0028_user_directory.sql)
--    and project_directory (0029_project_directory.sql) give /users and
--    /projects: ordering and `?q=` search need the joined columns (the
--    requester's email/username, the deciding admin's email) in the SAME
--    relation as the ORDER BY + LIMIT/OFFSET, not resolved after the page
--    of requests is already decided.
-- =============================================================================
create view allowance_request_directory
with (security_invoker = true) as
select
  r.id,
  r.user_id,
  p.email as user_email,
  p.username as user_username,
  r.requested_usd,
  r.reason,
  r.status,
  r.decided_by,
  d.email as decided_by_email,
  r.decided_at,
  r.decision_note,
  r.created_at
from allowance_requests r
join profiles p on p.id = r.user_id
left join profiles d on d.id = r.decided_by;

comment on view allowance_request_directory is
  '/allowances'' admin read: allowance_requests LEFT JOINed to the requester''s and (if decided) '
  'deciding admin''s profile columns, so the page can sort/search on them without an N+1 lookup '
  'per row — see user_directory (0028_user_directory.sql) for the identical reasoning. '
  '`security_invoker = true`: this view carries no privilege of its own — an admin sees every row, '
  'requester and decider columns both populated, because allowance_requests_select and profiles_'
  'select_admin already let them read every profiles row (0002_rls.sql, this migration''s RLS '
  'section). A non-admin querying it directly only ever sees their OWN request (allowance_'
  'requests_select''s `user_id = auth.uid()` half) and their own user_email/user_username (their '
  'own profiles row, profiles_select_own) — decided_by_email comes back NULL for them even on a '
  'decided request, since profiles_select_own does not extend to some OTHER user''s (the deciding '
  'admin''s) row. /allowances (web/app/(app)/allowances/page.tsx) is admin-only and reads this '
  'through requireAdmin()''s session client, so that gap never shows up there in practice.';

-- No new grants needed on the tables/index/function above — 0007_grants.sql's
-- `alter default privileges ... grant execute on functions to authenticated`
-- / `... on tables to authenticated` already cover anything this migration's
-- role creates, the same fact every migration since 0026 has leaned on.
-- =============================================================================
