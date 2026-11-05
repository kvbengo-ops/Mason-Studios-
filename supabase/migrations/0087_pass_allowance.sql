-- =============================================================================
-- Credit passing — an editor hands part of their own weekly headroom to
-- another editor, with nobody's approval
--
-- See docs/credit_passing_plan.md for the design and docs/credit-passing-
-- todo.md for the split with the application. The short version of why this
-- needs no approval workflow at all: A PASS IS ZERO-SUM. It writes TWO
-- allowance_grants rows — `+X` to the recipient and `−X` to the sender, same
-- expiry — so the team's total headroom is exactly what it was a moment
-- before. Nothing here can create allowance; it can only move it. That is
-- the entire argument, and it is why 0032's approve-then-grant handshake has
-- no counterpart in this file.
--
-- STAGED, NOT APPLIED — verified before this file was revised: 0086 is the
-- highest version in supabase_migrations.schema_migrations, this file appears
-- in no migration history, and it is still untracked in git. So the security
-- fix below EDITS THIS FILE IN PLACE rather than adding a forward migration:
-- there is no database anywhere that has run the insecure definition, and
-- shipping it followed by a patch would put a function that trusts
-- browser-supplied headroom into the history of every future `db reset`.
-- (A developer who hand-applied this file to a local database DOES have the old
-- five-argument function; section 2's `drop function` removes it by its old
-- identity, so re-running this file is enough to fix such a machine.)
--
-- Deploy order is MIGRATION FIRST, THEN WEB, and with this revision it is no
-- longer only about version reporting — the two halves no longer speak the same
-- language:
--
--   * Web ahead of the migration: the Server Action calls a six-argument
--     pass_allowance that does not exist yet. PostgREST answers PGRST202
--     ("function not found"), every pass fails, and no money moves.
--   * Migration ahead of the web: the old five-argument function is dropped and
--     the old Server Action's call fails the same way. Also safe, also visible,
--     and it is the direction that leaves no window in which the insecure
--     signature is reachable.
--
-- Both orders fail closed; only one of them ever exposes the old function, so
-- migration first. web/lib/version.ts must also name the highest applied
-- migration, or the sidebar and /api/health report schemaDrift on sight.
--
-- -----------------------------------------------------------------------------
-- NO GRANT AGGREGATE IS REDEFINED HERE. Read that literally.
-- -----------------------------------------------------------------------------
-- user_active_grants_usd, user_active_grants_usd_by_user,
-- outstanding_allowance_usd and sidebar_budget_snapshot are untouched, and
-- so are lib/spend.ts's and /profile's two row selects. All six already
-- SUM amount_usd over a user's active grants; a −X row is simply a smaller
-- sum. That is the whole reason the ledger carries the debit instead of a
-- transfers table with its own arithmetic: six sites that already agree keep
-- agreeing, for free.
--
-- So there is nothing to add to web/lib/revoked-grants-drift.test.ts. If a
-- later reader arrives here intending to "helpfully" register a seventh
-- site, the thing to register is that no seventh site exists.
--
-- -----------------------------------------------------------------------------
-- The split with the application
-- -----------------------------------------------------------------------------
-- Identical in shape to 0074_peer_allowance_approval.sql's, for the identical
-- reason. THIS FILE OWNS EVERY MONEY DECISION: who may pass, to whom, how much
-- is actually available, and when it expires. web/lib/transfer.ts's
-- passBlockReason owns turning each of those refusals into a sentence a person
-- reads — it is a message, never a gate.
--
-- The application supplies exactly two figures, and only because SQL cannot
-- produce them: the sender's weekly BASE cap (WEEKLY_CAP_USD /
-- TRUSTED_WEEKLY_CAP_USD from render.yaml, or the account's override) and the
-- in-flight render estimate (each queued scene priced through lib/models.ts's
-- TypeScript rate table). Everything else — spend so far, active grants, the
-- expiry — is computed inside pass_allowance under its lock.
--
-- An earlier draft of this file let the CALLER supply the finished headroom
-- figure while the function was callable by `authenticated`, which meant an
-- editor could call it straight through PostgREST and name their own balance.
-- Section 2 records that finding and the three changes that close it. Read
-- that block before adding another parameter to this function.
-- =============================================================================

-- =============================================================================
-- 1. allowance_grants.transfer_peer_id — the counterparty, on BOTH halves
-- =============================================================================
-- `if not exists`, matching 0083/0085, so re-running this file over a database
-- where a developer hand-applied the pre-revision version is how they pick up
-- the security fix in section 2 rather than an error on line 83.
alter table allowance_grants
  add column if not exists transfer_peer_id uuid references profiles(id);

comment on column allowance_grants.transfer_peer_id is
  'The OTHER party to a pass (0087_pass_allowance.sql), set on both halves: the sender on the '
  'recipient''s +X row, the recipient on the sender''s −X row. NULL on every grant an approver '
  'issued (0032''s workflow) and on every row that existed before 0087 — `transfer_peer_id is '
  'null` is therefore exactly "this is an ordinary grant, not half of a pass", which is what '
  'lib/spend.ts''s getActiveGrantsSummary splits grantedInUsd from receivedUsd/passedOutUsd on. '
  'Not a foreign key to a transfers table, because there is no transfers table: the two rows ARE '
  'the transfer, and each party reads their own half through the allowance_grants_select policy '
  'they already had.';

-- A SPLIT OF THE OLD CHECK, NOT A WEAKENING. Stated plainly because the next
-- reader will see `amount_usd > 0` disappear and reasonably assume the
-- ledger stopped being guarded.
--
-- The old constraint said one thing: an amount must be positive. The new one
-- says two:
--
--   1. amount_usd <> 0             — a zero-dollar grant is still nonsense,
--                                    and this half is UNCONDITIONAL, so it
--                                    binds the new transfer rows too.
--   2. amount_usd > 0 OR transfer_peer_id is not null
--                                  — only half of a PASS may be negative.
--
-- Every row the old constraint accepted, this one accepts. Every row it
-- refused, this one still refuses, except the single new shape the feature
-- exists to write: a debit that names its counterparty. A negative amount
-- with no peer id — the shape a bug or a hand-written INSERT would produce —
-- is refused exactly as it was before this migration.
alter table allowance_grants drop constraint if exists allowance_grants_amount_usd_check;
alter table allowance_grants
  add constraint allowance_grants_amount_usd_check
  check (amount_usd <> 0 and (amount_usd > 0 or transfer_peer_id is not null));

comment on constraint allowance_grants_amount_usd_check on allowance_grants is
  'A SPLIT of 0032''s `amount_usd > 0`, not a relaxation of it: zero is still refused '
  'unconditionally, and a negative amount is refused unless it carries a transfer_peer_id — i.e. '
  'unless it is the sender''s half of a pass (0087_pass_allowance.sql). The only new row shape '
  'this admits is the one pass_allowance writes.';

-- =============================================================================
-- 2. pass_allowance — both halves, or neither
-- =============================================================================
-- One PL/pgSQL function for the same reason decide_allowance_request is one
-- (0032's header): two statements from application code leave a window where
-- the recipient has been credited and the sender never debited, which is
-- precisely the "a pass cannot mint headroom" property the feature rests on.
-- Inside a function both inserts share one implicit transaction.
--
-- -----------------------------------------------------------------------------
-- WHY THIS IS SERVICE-ROLE-ONLY, AND WHY THE SENDER IS A PARAMETER
-- -----------------------------------------------------------------------------
-- An earlier draft of this file took the sender's spendable headroom as
-- `p_sender_headroom_usd` and was callable by `authenticated`. Those two facts
-- together were the bug: PostgREST exposes every function `authenticated` may
-- execute, so an editor did not need the dialog, the Server Action, or even the
-- app — one `rpc/pass_allowance` call with a headroom of their choosing moved
-- as much allowance as they cared to name. The sender was honestly derived from
-- auth.uid(), and it made no difference: they were lying about their own
-- balance, not about who they were. `p_expires_at` was the same shape of hole
-- one column over — an arbitrary future date turned a week's headroom into a
-- permanent cap change that no approver ever saw.
--
-- The fix follows reserve_image_attempt (0083) exactly, because this is the
-- same problem: a money decision that depends on ONE figure the database cannot
-- compute for itself. That function is revoked from `authenticated` and takes
-- its ceilings as parameters, because the caps live in render.yaml env vars; it
-- is safe because the only thing that can call it is the service-role client,
-- which no browser holds.
--
-- So, three changes, and they only work together:
--
--   1. REVOKED from public/anon/authenticated (section 2b below). A browser
--      cannot reach this function at all, whatever it puts in the body.
--   2. The sender is `p_from_user_id`. It has to be: the service-role client
--      has no auth.uid() — `auth.uid()` under it is NULL — so the old
--      derivation would have made every caller anonymous and every lookup
--      empty. The Server Action authenticates the real editor with
--      requireUser() and passes that id, which is the SAME trust structure
--      reserve_image_attempt uses for its personal shape (0085 section 5).
--      This is a widening of trust from "auth.uid() cannot be forged" to "only
--      the service role can call this at all", and it is why (1) is not
--      optional.
--   3. The headroom is COMPUTED HERE, under the lock, from the two terms the
--      database owns authoritatively: the sender's spend this week
--      (user_spend_usd) and their active grants (user_active_grants_usd).
--
-- WHAT STILL ARRIVES AS A PARAMETER, and why that is not the same hole:
--
--   * p_weekly_base_cap_usd — WEEKLY_CAP_USD / TRUSTED_WEEKLY_CAP_USD, or the
--     account's weekly_cap_override_usd. Env vars a Postgres function cannot
--     read, which is the same reason outstanding_allowance_usd (0035) and
--     reserve_image_attempt (0083) both take their ceilings as arguments.
--   * p_held_usd — renders already queued or rendering but not yet billed
--     (lib/spend.ts's getInFlightSpend). This one is not merely inconvenient to
--     compute here, it is impossible: the figure is each in-flight scene priced
--     through lib/models.ts's TypeScript rate table, resolved through the
--     scene-override merge. There is no SQL expression for it.
--
-- Both are computed by the server from its own admin-client reads and neither
-- is reachable from a browser, which is the property that matters — the old
-- `p_sender_headroom_usd` failed not because it was a parameter but because an
-- untrusted client could set it. They are still validated below rather than
-- trusted, because a wrong sign on either one manufactures headroom.
--
-- security definer for the same reason decide_allowance_request is:
-- allowance_grants has an INSERT policy of is_admin() and no UPDATE/DELETE
-- policy at all (0032, kept by 0075), and none of that changes here — this
-- function is the write path, running as its owner.
--
-- search_path = '' with every object schema-qualified, matching
-- reserve_image_attempt rather than this file's own transfer_recipients: no
-- caller-controlled search_path can resolve `profiles`, `allowance_grants` or
-- either spend function to something else. The spend functions are SECURITY
-- INVOKER and therefore run as this function's owner, which is what lets them
-- see every row they need.

-- Dropped by its old identity first: the argument list changed, so `create or
-- replace` would leave the insecure five-argument version standing beside the
-- new one, still callable by `authenticated`, and PostgREST would happily route
-- to it. Harmless on a database that never had it.
drop function if exists public.pass_allowance(uuid, numeric, numeric, timestamptz, text);

create or replace function public.pass_allowance(
  p_from_user_id        uuid,
  p_to_user_id          uuid,
  p_amount_usd          numeric,
  p_weekly_base_cap_usd numeric,
  p_held_usd            numeric,
  p_note                text
)
-- Returns the expiry it actually wrote. The caller no longer chooses it (see
-- section 2a), so this is how the Server Action reports "expires Monday"
-- without recomputing a boundary the database has already decided.
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sender_role      text;
  v_sender_status    text;
  v_recipient_role   text;
  v_recipient_status text;
  v_now              timestamptz;
  v_week_start       timestamptz;
  v_expires_at       timestamptz;
  v_used             numeric;
  v_grants           numeric;
  v_available        numeric;
begin
  -- Trust boundary, checked in the order a person would ask the questions,
  -- so the FIRST true refusal is the one reported.
  --
  -- NaN is called out by name because numeric NaN does not behave like a
  -- float one in comparisons: Postgres sorts NaN ABOVE every other numeric,
  -- so `p_amount_usd <= 0` is FALSE for NaN and a bare positivity check
  -- would wave it straight through into the ledger. `= 'NaN'::numeric` is
  -- the reliable test — NaN = NaN is true for numeric.
  if p_amount_usd is null or p_amount_usd = 'NaN'::numeric or p_amount_usd <= 0 then
    raise exception 'pass_allowance: amount must be a positive number, got %', p_amount_usd
      using errcode = 'invalid_parameter_value';
  end if;

  if p_from_user_id is null then
    raise exception 'pass_allowance: sender is required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- THE TWO REMAINING SERVER-SUPPLIED TERMS, validated rather than trusted.
  --
  -- NULL is the dangerous value and gets its own refusal for the reason
  -- reserve_image_attempt states about a NULL cap (0083): `X > NULL` is NULL,
  -- which is not true, so a forgotten argument would silently DISABLE the
  -- ceiling instead of failing.
  --
  -- The SIGNS are what the rest of this checks. A negative base cap is
  -- nonsense; a negative held amount would ADD headroom that no cap ever
  -- granted, which is the same class of bug as the parameter this function
  -- just stopped taking. Both are refused rather than clamped, because a
  -- caller sending either has a defect worth surfacing, not a value worth
  -- rounding.
  if p_weekly_base_cap_usd is null or p_weekly_base_cap_usd = 'NaN'::numeric
     or p_weekly_base_cap_usd < 0 then
    raise exception 'pass_allowance: weekly base cap must be a non-negative number, got %',
      p_weekly_base_cap_usd
      using errcode = 'invalid_parameter_value';
  end if;
  if p_held_usd is null or p_held_usd = 'NaN'::numeric or p_held_usd < 0 then
    raise exception 'pass_allowance: held amount must be a non-negative number, got %', p_held_usd
      using errcode = 'invalid_parameter_value';
  end if;

  if p_to_user_id is null or p_to_user_id = p_from_user_id then
    raise exception 'pass_allowance: % may not pass credits to themselves', p_from_user_id;
  end if;

  select p.role, p.status into v_sender_role, v_sender_status
  from public.profiles p where p.id = p_from_user_id;
  select p.role, p.status into v_recipient_role, v_recipient_status
  from public.profiles p where p.id = p_to_user_id;

  if v_sender_role is null then
    raise exception 'pass_allowance: sender % not found', p_from_user_id
      using errcode = 'no_data_found';
  end if;
  if v_recipient_role is null then
    raise exception 'pass_allowance: recipient % not found', p_to_user_id
      using errcode = 'no_data_found';
  end if;

  -- ADMINS ARE OUT OF SCOPE ON BOTH ENDS, and the rule lives here rather
  -- than only in the dialog, because a Server Action can be reached without a
  -- dialog. An admin has no weekly allowance worth passing (resolveAccountCaps
  -- gives them ADMIN_WEEKLY_CAP_USD, and they can raise anyone's cap outright
  -- on /users), and an admin RECEIVING a pass would move an editor's headroom
  -- somewhere no editor can get it back from. Neither direction is a feature;
  -- both are refused in one place.
  if v_sender_role not in ('editor', 'trusted_editor') then
    raise exception 'pass_allowance: % is not an editor and has no allowance to pass',
      p_from_user_id;
  end if;
  if v_recipient_role not in ('editor', 'trusted_editor') then
    raise exception 'pass_allowance: recipient % is not an editor', p_to_user_id;
  end if;

  -- Both parties must be APPROVED accounts (0052_account_approval.sql).
  --
  -- A COLUMN READ ON BOTH SIDES NOW, where the sender's half used to be
  -- is_active(). That helper resolves auth.uid(), which is NULL under the
  -- service role — it would have refused every real pass while appearing to
  -- check something. The predicate is the same one canUseApp/requireUser
  -- enforces; it is simply asked about a named account instead of about the
  -- session, which is the correct question now that the session belongs to the
  -- service role and not to the editor.
  if v_sender_status <> 'active' then
    raise exception 'pass_allowance: % is not an active account', p_from_user_id;
  end if;
  if v_recipient_status <> 'active' then
    raise exception 'pass_allowance: recipient % is not an active account', p_to_user_id;
  end if;

  -- WHY THIS RACE GETS A LOCK WHEN docs/spend-model.md ACCEPTS EVERY OTHER
  -- ONE.
  --
  -- Every cap check in web/lib/spend.ts is a point-in-time read with nothing
  -- reserving the amount between the read and the write, and that file says
  -- so plainly. The cost of losing one of those races is an OVERSHOOT: two
  -- renders both pass a ceiling that had room for one, and the account ends
  -- the week slightly over a limit it was already at.
  --
  -- Losing THIS race is a different kind of wrong. Two passes of the sender's
  -- full headroom, read concurrently, both see it available and both write
  -- their +X — so the recipients between them hold more allowance than the
  -- sender ever had, while the sender's two −X rows take back only what they
  -- did have. A pass would MINT headroom, and the zero-sum property this
  -- whole design rests on would be false. That is not a bigger overshoot;
  -- it is the one failure the feature cannot survive.
  --
  -- Per-sender, not global: only passes FROM THE SAME ACCOUNT can race each
  -- other's headroom, and a global lock would serialize unrelated editors for
  -- nothing. This is the only place this lock name is taken, so there is no
  -- second lock to order it against and no deadlock to design around —
  -- unlike reserve_image_attempt (0083), which takes two and says so.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('allowance-pass:' || p_from_user_id::text)
  );

  -- clock_timestamp(), NOT now(), and the reason is the lock above.
  --
  -- now() is transaction start — computed BEFORE this transaction blocked on
  -- the lock. A pass that queued ahead of us and committed while we waited has
  -- a −X row stamped after that instant, so a `created_at <= now()` window
  -- would read the sender's spend and grants as they were before the pass we
  -- just waited for. The lock would have serialized us correctly and the
  -- timestamp would have thrown it away. Same reasoning, in the same words, as
  -- reserve_image_attempt's v_to_ts (0083).
  v_now := pg_catalog.clock_timestamp();

  -- THE WEEK, decided here and nowhere else (see section 2a below).
  -- date_trunc('week') is Monday-based, matching lib/spend.ts's
  -- startOfManilaWeekIso, and Manila has no DST for the +7 days to shift.
  v_week_start := (
    pg_catalog.date_trunc('week', v_now at time zone 'Asia/Manila') at time zone 'Asia/Manila'
  );
  v_expires_at := v_week_start + interval '7 days';

  -- THE HEADROOM, computed rather than accepted. This is the whole fix.
  --
  -- Both reads happen AFTER the lock, so a concurrent pass from the same
  -- sender that queued ahead has already committed its −X row into the grants
  -- sum and its renders into the spend sum. Reading either before the lock
  -- would restore exactly the stale-headroom race that making this function
  -- server-only was supposed to close — server-only stops a browser lying
  -- about the number; only the lock stops two honest callers reading the same
  -- number twice.
  --
  -- Both are CALLED, never reimplemented: user_spend_usd (0031, re-attributed
  -- by 0085) and user_active_grants_usd (0075) carry the union with
  -- deleted_project_cost_history and the unexpired-and-unrevoked predicate
  -- that every other aggregate in this system uses. A hand-written sum here
  -- would be a seventh site to keep in agreement — see this file's header.
  v_used   := public.user_spend_usd(p_from_user_id, v_week_start, v_now);
  v_grants := public.user_active_grants_usd(p_from_user_id, v_now);

  -- The same arithmetic as lib/spend.ts's weeklyRemainingUsd, term for term:
  -- effective cap (base + grants) minus spend minus what is already in flight.
  v_available := p_weekly_base_cap_usd + v_grants - v_used - p_held_usd;

  if p_amount_usd > v_available then
    raise exception 'pass_allowance: % is more than %''s remaining allowance of %',
      p_amount_usd, p_from_user_id, v_available
      using errcode = 'check_violation';
  end if;

  -- The two halves. Same amount, same expiry, same note, same granted_by —
  -- the sender is the actor on both, because they are: nobody approved this.
  -- Each row names the OTHER party in transfer_peer_id, so either side can
  -- render "passed to / received from" off its own half alone, which is what
  -- keeps allowance_grants_select sufficient and needs no new policy.
  insert into public.allowance_grants
    (user_id, amount_usd, expires_at, granted_by, note, transfer_peer_id)
  values (p_to_user_id, p_amount_usd, v_expires_at, p_from_user_id, p_note, p_from_user_id);

  insert into public.allowance_grants
    (user_id, amount_usd, expires_at, granted_by, note, transfer_peer_id)
  values (p_from_user_id, -p_amount_usd, v_expires_at, p_from_user_id, p_note, p_to_user_id);

  return v_expires_at;
end;
$$;

comment on function public.pass_allowance(uuid, uuid, numeric, numeric, numeric, text) is
  'Moves part of one editor''s own weekly headroom to another, as two allowance_grants rows '
  '(+X to the recipient, −X to the sender, same derived expiry, each naming the other in '
  'transfer_peer_id) written in one transaction — zero-sum by construction, which is why this '
  'needs no approval step. SERVICE-ROLE ONLY: revoked from authenticated because it takes the '
  'sender as a parameter, which is only safe when no browser can call it. The Server Action '
  'authenticates the real sender with requireUser() and passes that id; auth.uid() is NULL under '
  'the service role and is deliberately not consulted. The sender''s spendable headroom is '
  'COMPUTED HERE under a per-sender advisory lock, from user_spend_usd and user_active_grants_usd '
  '— it is never supplied by the caller, which an earlier draft allowed and which let a direct RPC '
  'call name its own balance. Only the two figures SQL cannot derive are parameters: the weekly '
  'base cap (a render.yaml env var, as in reserve_image_attempt) and the in-flight render estimate '
  '(priced through lib/models.ts). Expiry is derived as the next Asia/Manila Monday and returned; '
  'there is no p_expires_at, so no caller can outlive the weekly reset. Refuses, in order: a '
  'non-positive/NaN amount, a missing sender, a null/NaN/negative base cap or held amount, a pass '
  'to oneself, an unknown account on either end, an admin on either end, a non-active account on '
  'either end, and an amount over the computed remaining allowance.';

-- =============================================================================
-- 2a. Expiry is derived, not accepted
-- =============================================================================
-- The old signature took p_expires_at and wrote whatever it was given. A grant
-- is a raise to the weekly allowance and 0032 requires it to expire with the
-- week it tops up; an arbitrary future date therefore turned a one-week pass
-- into a standing cap change, made by one editor for another, that no approver
-- ever decided and no weekly reset ever undid. The web app always sent the
-- right boundary — but the web app was never the only caller, which is the
-- entire point of the finding.
--
-- Derived rather than validated, because validation leaves a question ("how
-- close to the boundary is close enough?") that derivation does not have. There
-- is no longer a parameter to get wrong, and the value that was written is
-- returned so the caller can display it instead of recomputing it.
--
-- The boundary matches lib/spend.ts's endOfManilaWeekIso exactly: Monday 00:00
-- Asia/Manila, plus seven days.

-- =============================================================================
-- 2b. Lock the function down. The default is wide open.
-- =============================================================================
-- 0007_grants.sql grants execute on all functions in schema public to
-- `authenticated` AND sets the same as a DEFAULT PRIVILEGE for functions
-- created later — which is this one. Without the revoke below, any signed-in
-- browser client could call it directly through PostgREST, which is exactly how
-- the fake-headroom finding was reachable: no dialog, no Server Action, no app.
--
-- Service-role-only is how the app actually reaches it: web/actions/transfer.ts
-- calls it through createAdminClient(), which uses SUPABASE_SERVICE_ROLE_KEY
-- (web/lib/supabase/server.ts). The Server Action is the only caller, and it
-- establishes the sender with requireUser() before it gets here.
--
-- transfer_recipients() below is deliberately NOT revoked. It is a read of a
-- fixed projection of a fixed set, it resolves the caller from auth.uid(), and
-- the signed-in session client is what must call it — the service role would
-- have no identity to resolve. Two functions in one file with opposite grants,
-- because they are answering opposite questions.

revoke execute on function public.pass_allowance(uuid, uuid, numeric, numeric, numeric, text)
  from public, anon, authenticated;

grant execute on function public.pass_allowance(uuid, uuid, numeric, numeric, numeric, text)
  to service_role;

-- =============================================================================
-- 3. transfer_recipients — who this account may pass to
-- =============================================================================
-- THE FEATURE'S ONE PRIVACY WIDENING, and it is deliberately the smallest
-- one available — the same judgement 0074 made and recorded for
-- allowance_requests_select.
--
-- A pass needs a recipient picker, and an editor cannot read another
-- account's profiles row: profiles_select_own covers their own, and
-- profiles_select_admin (historical name; the predicate is
-- can_approve_allowance() since 0074) covers approvers. Rather than widen
-- either policy — which would hand every editor the whole profiles table for
-- every purpose, including the ones nobody decided to grant — this is a
-- security definer function returning ONE fixed projection (id, a display
-- name, email, role) of ONE fixed set (other active editors and trusted
-- editors). Not a view either: a view would need a policy behind it and
-- would be reachable by column selection an editor chose.
--
-- It refuses a caller who has no business seeing the list at all, so the
-- widening is bounded on both ends: only an active editor tier may call it,
-- and it returns only accounts they may actually pass to. The set is exactly
-- pass_allowance's own recipient rule, which is what lets web/actions/
-- transfer.ts use membership in this list as its "is the recipient
-- eligible" check instead of restating the predicate a third time.
create or replace function transfer_recipients()
returns table (
  id       uuid,
  username text,
  email    text,
  role     text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    p.id,
    -- username is nullable (0015_profile_username.sql added it to an existing
    -- table). A picker with a blank row in it is a bug in front of the person
    -- choosing where their money goes, so fall back to the address they
    -- signed up with rather than returning NULL for the caller to paper over.
    coalesce(p.username, p.email) as username,
    p.email,
    p.role
  from profiles p
  where p.role in ('editor', 'trusted_editor')
    and p.status = 'active'
    and p.id <> auth.uid()
    and exists (
      select 1 from profiles me
      where me.id = auth.uid()
        and me.role in ('editor', 'trusted_editor')
        and me.status = 'active'
    )
  order by coalesce(p.username, p.email);
$$;

comment on function transfer_recipients() is
  'Every account the CALLER may pass credits to: active editors and trusted editors other than '
  'themselves, as id / display name / email / role. Returns EMPTY for anyone who may not pass at '
  'all (an admin, a suspended or unapproved account) — the caller-eligibility test is the `exists` '
  'in the WHERE, so a non-passer learns nothing about who exists. security definer because an '
  'editor cannot read another account''s profiles row, and this is deliberately a fixed projection '
  'of a fixed set rather than a widening of profiles_select_admin or of user_directory — see '
  '0087_pass_allowance.sql''s header, and 0074_peer_allowance_approval.sql for the same judgement '
  'made once before. The set is exactly pass_allowance''s own recipient rule, so web/actions/'
  'transfer.ts can treat membership here as eligibility rather than restating it.';

-- =============================================================================
-- 4. No RLS policy changes. On purpose.
-- =============================================================================
-- allowance_grants_select (0032, widened once by 0074) is already
-- `user_id = auth.uid() or can_approve_allowance()`, and a pass writes each
-- party a row of their OWN — so both sides read their half of every pass
-- they are part of with the policy exactly as it stands. /allowances' "Passes
-- this week" needs nothing new, and a page that finds it does has hit a
-- design change, not a missing policy.
--
-- allowance_grants_insert_admin stays on is_admin(). pass_allowance is
-- security definer and owns this write path; widening the INSERT policy would
-- open a session-token route straight at PostgREST that skips every check
-- above — the same trade 0074 declined for allowance_requests_update, for the
-- same reason.
--
-- THE TWO FUNCTIONS HERE HAVE OPPOSITE GRANTS, and that asymmetry is the point.
-- 0007_grants.sql's default privileges hand `authenticated` execute on both;
-- section 2b takes it back from pass_allowance and leaves it on
-- transfer_recipients:
--
--   * pass_allowance MOVES MONEY and takes its sender as a parameter, so it is
--     service-role only. The Server Action proves who the sender is with
--     requireUser() before calling it.
--   * transfer_recipients READS a fixed projection of a fixed set and resolves
--     the caller from auth.uid(), so it must stay callable by the signed-in
--     session — the service role has no identity for it to resolve, and would
--     get an empty list.
--
-- If a future change needs pass_allowance reachable by `authenticated` again,
-- the sender parameter has to go back to auth.uid() in the same change. The two
-- decisions are one decision.
-- =============================================================================
