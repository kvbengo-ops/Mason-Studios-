-- =============================================================================
-- Peer approval — a trusted editor may decide another editor's allowance
-- request
--
-- 0032_allowance_requests.sql built the request -> grant workflow with a
-- single decider: is_admin(). That made one person the queue's bottleneck.
-- An editor who trips the WEEKLY cap (assertWithinSpendCaps, web/lib/
-- spend.ts) stops working until an admin happens to look at /allowances,
-- and the asks that pile up there are overwhelmingly small — one more ad's
-- worth of headroom, not a budget renegotiation.
--
-- This migration widens WHO may say yes. It does not widen WHAT a yes does:
-- a grant still raises the account's EFFECTIVE WEEKLY allowance only (lib/
-- spend.ts's getEffectiveWeeklyCapUsd), never the daily burst guard and
-- never GLOBAL_DAILY_CAP_USD. No number of peer approvals can move what the
-- team spends in a day. The worst case of a bad peer approval is one
-- editor's week.
--
-- Authority rides on the EXISTING 'trusted_editor' role (0031_account_
-- allowances.sql). No new role, no can_approve column, no second tier: that
-- role already means "we trust this account with more money", and admins
-- already choose who holds it on /users. Attribution needed nothing either
-- — allowance_requests.decided_by and allowance_request_directory's
-- decided_by_email already name whoever decided each row, so a peer
-- approval is as auditable as an admin one with no schema change.
--
-- -----------------------------------------------------------------------------
-- The split with the application, and why it is where it is
-- -----------------------------------------------------------------------------
-- Three bounds keep a peer's yes smaller than an admin's. Only TWO of them
-- are here:
--
--   1. Is this account an approver at all?            -> this file
--   2. Is this their own request?                     -> this file
--   3. Is the amount within their ceiling?            -> TypeScript
--
-- (3) is not missing by oversight. The ceiling is WEEKLY_CAP_USD, a
-- render.yaml env var; a Postgres function has no access to it, which is
-- the same reason outstanding_allowance_usd (0035) takes the editor and
-- trusted-editor weekly defaults as PARAMETERS rather than reading them.
-- Hard-coding a copy here would create two numbers that must move together
-- and silently would not. So this file owns the questions answerable from
-- auth.uid() alone, and web/lib/allowance.ts owns the numeric one —
-- precisely the division grantExpiryError and this function already had
-- before P6 (0032's header: expiry bounds live in TS, atomicity lives
-- here).
--
-- The residual: a trusted editor who crafts a direct PostgREST call could
-- over-grant a COLLEAGUE, since only the app enforces the amount. That is
-- the same exposure MAX_GRANT_EXPIRY_DAYS has always had for admins. It is
-- recorded, not fixed — if the trusted-editor set ever stops being small
-- and hand-picked, the fix is a literal fuse in this function refusing any
-- non-admin grant above a hard number, accepting the drift that costs.
-- =============================================================================

-- =============================================================================
-- 1. can_approve_allowance() — a SECOND predicate, deliberately not a wider
--    is_admin()
-- =============================================================================
-- is_admin() (0002_rls.sql:12) is load-bearing for far more than this
-- workflow: the Character Library, /users, /spend, and every cross-account
-- read policy in 0002_rls.sql. Widening it to include trusted editors would
-- have handed them all of that as a side effect nobody decided to grant.
-- This is a separate function, used in exactly the four places below, and it
-- must stay that way.
--
-- The status half is not decoration. is_admin() can ignore profiles.status
-- because admins are trusted by role — requiresAccountApproval (web/lib/
-- account-approval.ts) exempts them, and 0055_admin_bypasses_account_
-- approval.sql made that explicit. 'trusted_editor' is the FIRST role
-- requiring approval to appear inside a privileged predicate, so the check
-- has to come with it: without `status = 'active'`, an account that an admin
-- suspended (or has not yet approved) would still be able to approve grants
-- by calling decide_allowance_request directly, even though requireApprover
-- -> requireUser -> canUseApp bounces them to /pending in the app. This
-- expression is canUseApp's exact rule — admins by role, editor tiers by
-- approval — so the two lines cannot disagree.
create or replace function can_approve_allowance()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid()
      and (role = 'admin' or (role = 'trusted_editor' and status = 'active'))
  );
$$;

comment on function can_approve_allowance() is
  'True when the calling account may decide SOMEBODY''s allowance request: an admin, or an '
  '''active'' trusted_editor (0031_account_allowances.sql, 0052_account_approval.sql). The database '
  'twin of web/actions/guard.ts''s isApprover, exactly as is_admin() is of isAdmin(). NOT a '
  'replacement for is_admin() and never to be substituted for it: is_admin() also gates the '
  'Character Library, /users, /spend and every cross-account read in 0002_rls.sql, none of which a '
  'trusted editor gains here. Answers only "may this account decide anything at all" — whether it '
  'may decide a PARTICULAR request (not its own, not one over its ceiling) is web/lib/allowance.ts''s '
  'decisionBlockReason, plus this file''s own self-decision raise below.';

-- =============================================================================
-- 2. RLS — three policies widen, and deliberately only three
-- =============================================================================
-- `alter policy`, not drop + create: same object, same privilege, only a
-- broader `using`. 0033_allowance_requests_rls_fix.sql's header states the
-- reasoning and the one incident (SQLSTATE 42P16) that makes the heavier
-- form worth actively steering away from.

-- The queue itself. An approver reads every requester's row; everyone else
-- still reads only their own.
alter policy allowance_requests_select on allowance_requests
  using (user_id = auth.uid() or can_approve_allowance());

comment on policy allowance_requests_select on allowance_requests is
  'Own rows always; every row for an approver (can_approve_allowance(), this migration) — widened '
  'from is_admin() when trusted editors gained the right to decide requests. This is the one '
  'privacy widening peer approval requires, and it IS the feature: an approver who cannot read the '
  'queue cannot work it.';

-- Required, not cosmetic. user_active_grants_usd_by_user (0033:82) is
-- `security invoker`, so /allowances' per-requester "active grants" figure
-- is read under the caller's own RLS. Left on is_admin(), that figure would
-- come back $0 for every requester except the peer themselves — not an
-- error, just a wrong number in front of someone deciding whether to add to
-- it, which is the worst possible shape for this particular bug.
alter policy allowance_grants_select on allowance_grants
  using (user_id = auth.uid() or can_approve_allowance());

comment on policy allowance_grants_select on allowance_grants is
  'Own grants always; every grant for an approver (can_approve_allowance(), this migration). '
  'Widened from is_admin() with allowance_requests_select above, and for a concrete reason: '
  'user_active_grants_usd_by_user (0033) is security invoker, so /allowances'' "active grants" '
  'column and the approve dialog''s context both read this table as the CALLER. Without this, a '
  'trusted editor sees $0 of existing grants on every request but their own.';

-- The one that is easy to miss and breaks the page silently if it is.
--
-- allowance_request_directory (0032:337) is `security_invoker = true` and
-- joins profiles for the requester's email/username:
--
--     from allowance_requests r
--     join profiles p on p.id = r.user_id      <-- INNER join
--
-- Widening allowance_requests_select alone is not enough. If RLS still
-- hides the REQUESTER'S profile row from a trusted editor, that inner join
-- drops the request row entirely — /allowances renders an empty queue, with
-- no error anywhere to explain why, for the exact accounts the feature was
-- built for. The left join to the decider's profile has the same shape one
-- column over (decided_by_email would read NULL on every decided row).
--
-- The policy KEEPS ITS NAME. Renaming it would mean dropping and recreating
-- a security-critical policy and chasing six comment references across
-- 0020/0028/0031/0032 for a cosmetic gain; the comment below records that
-- the name is now historical.
alter policy profiles_select_admin on profiles
  using (can_approve_allowance());

comment on policy profiles_select_admin on profiles is
  'HISTORICAL NAME — the predicate is can_approve_allowance() (this migration), not is_admin(): '
  'trusted editors read every profiles row too, because allowance_request_directory (0032) is '
  'security_invoker and INNER JOINs profiles for the requester''s email. Left on is_admin(), that '
  'join silently drops every request row from a trusted editor''s queue and /allowances renders '
  'empty with no error. Narrower alternative, rejected for now: gate on `exists (select 1 from '
  'allowance_requests r where r.user_id = profiles.id or r.decided_by = profiles.id)` — it puts a '
  'subquery on the hottest table in the app (every requireUser() call reads profiles) for a privacy '
  'gain nobody has asked for.';

-- -----------------------------------------------------------------------------
-- What deliberately did NOT change, and why leaving it is the safer half
-- -----------------------------------------------------------------------------
-- allowance_requests_update (0032:121, narrowed by 0033) and
-- allowance_grants_insert_admin (0032:195) stay on is_admin().
--
-- They are not in the decision path at all. decide_allowance_request is
-- `security definer` and neither table carries `force row level security`
-- (0038 and 0054 both note the absence for other tables), so the function
-- runs as its owner and RLS on these two tables never applies to it — which
-- is exactly why it has always re-checked the caller's role itself as its
-- first statement rather than trusting the caller's RLS context.
--
-- Widening them would therefore buy nothing and open something: a
-- session-token write path straight at PostgREST, letting a trusted editor
-- PATCH allowance_requests rows or INSERT allowance_grants directly,
-- bypassing the atomic decision this whole feature routes through. The
-- read side is what peer approval needs; the write side stays shut.
-- =============================================================================

-- =============================================================================
-- 3. decide_allowance_request — approver check, and nobody decides their own
-- =============================================================================
-- Same signature, same atomic decision-plus-grant, same `where status =
-- 'pending'` race handling as 0032:275. Two changes only:
--
--   - the first statement checks can_approve_allowance() instead of
--     is_admin();
--   - a new second statement refuses a self-decision, BEFORE the UPDATE, so
--     one never writes even partially.
--
-- The self-decision rule has no admin carve-out, on purpose. One uniform
-- rule is smaller than a rule plus an exception, and it removes the only
-- shape of this feature anyone would have to think about twice ("could an
-- approver just grant themselves more?"). An admin who genuinely needs more
-- allowance has two paths that do not involve deciding their own request:
-- another admin, or a per-account cap override on /users.
--
-- A request id that does not exist leaves requester_id NULL, `null =
-- decided_by_id` is NULL rather than true, and control falls through to the
-- UPDATE — which matches no row and raises the existing 'is not pending (or
-- does not exist)'. The pre-existing error for a missing request is
-- unchanged, not shadowed by the new one.
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
  requester_id uuid;
  updated_request allowance_requests;
begin
  if not can_approve_allowance() then
    raise exception 'decide_allowance_request: % is not an approver', decided_by_id;
  end if;

  select user_id into requester_id from allowance_requests where id = request_id;

  if requester_id = decided_by_id then
    raise exception 'decide_allowance_request: % may not decide their own request', decided_by_id;
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
  'allowance_grants row, in one transaction — see 0032_allowance_requests.sql''s header for why a '
  'partial failure here (decision written, grant not) cannot be allowed to happen. security '
  'definer: checks the caller itself as its first statements rather than relying on the caller''s '
  'RLS context, and is otherwise the sole post-decision writer of these two tables. Two caller '
  'rules, both raised here and both mirrored in web/lib/allowance.ts''s decisionBlockReason so an '
  'operator reads a sentence rather than a 500: the caller must be an APPROVER (can_approve_'
  'allowance() — an admin or an active trusted editor, this migration''s widening of the original '
  'is_admin() check), and NOBODY may decide their own request, admins included. The amount ceiling '
  'on a non-admin approver is NOT enforced here — it is WEEKLY_CAP_USD, a render.yaml env var this '
  'function cannot read; see this migration''s header. Only a ''pending'' request can be decided '
  '(the UPDATE''s own WHERE, re-checked via updated_request.id is null) — deciding an '
  'already-decided or cancelled request raises rather than silently no-opping, so a second approver '
  'racing the first (or a stale page) gets a clear error instead of a duplicate grant.';

-- No new grants needed: 0007_grants.sql's default privileges already cover
-- any function this migration's role creates, the same fact every migration
-- since 0026 has leaned on.
-- =============================================================================
