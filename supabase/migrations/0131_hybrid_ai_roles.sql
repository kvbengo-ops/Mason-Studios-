-- =============================================================================
-- 0131_hybrid_ai_roles.sql
-- Two new roles (owner, 2026-11-09): 'hybrid_editor' and 'ai_animator'.
--
-- They are ROLES, not the 0129 team tag, which this migration removes. Each has
-- its own spend tier (lib/spend.ts HYBRID_EDITOR_* / AI_ANIMATOR_*, defaulting
-- to the global cap's own default) and its own video-model access
-- (lib/model-access.ts: a Hybrid Editor every model except wan-3.0; an AI
-- Animator every model). They do NOT approve allowances or hold API tokens:
-- can_approve_allowance (0074), is_admin and the token guard
-- (lib/api-auth.ts canUseApiTokens) still admit only admin and trusted_editor,
-- so none of those change here.
--
-- What does change: every SQL function that lists the non-admin roles
-- explicitly, so the new roles are treated like the other editor tiers:
--   pass_allowance / transfer_recipients (0087)    - may pass and receive credits
--   notify_weekly_credit_renewal (0126)            - weekly reset notice
--   notify_limits_changed (0126)                   - limits-changed notice
--   outstanding_allowance_usd (0085)               - their own weekly default
-- Each body is copied verbatim from its latest definition with only the role
-- lists widened. outstanding_allowance_usd gains a four-argument overload beside
-- the old two-argument one (no defaults, so a named-argument call is never
-- ambiguous); lib/db-aggregates.ts calls the four-argument one.
--
-- BACKWARD-COMPATIBLE ON PURPOSE: applied before the code that uses it deploys,
-- so the old code must keep working. 0129's team column and the two-argument
-- outstanding_allowance_usd are therefore KEPT; drop both in a later migration
-- once this release is live.
-- =============================================================================

alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin', 'editor', 'trusted_editor', 'hybrid_editor', 'ai_animator'));

-- 0129's team tag is superseded by the roles above. The column stays until the
-- previous release (which still selects it) is gone; nothing reads it after this one.

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
  if v_sender_role not in ('editor', 'trusted_editor', 'hybrid_editor', 'ai_animator') then
    raise exception 'pass_allowance: % is not an editor and has no allowance to pass',
      p_from_user_id;
  end if;
  if v_recipient_role not in ('editor', 'trusted_editor', 'hybrid_editor', 'ai_animator') then
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
  where p.role in ('editor', 'trusted_editor', 'hybrid_editor', 'ai_animator')
    and p.status = 'active'
    and p.id <> auth.uid()
    and exists (
      select 1 from profiles me
      where me.id = auth.uid()
        and me.role in ('editor', 'trusted_editor', 'hybrid_editor', 'ai_animator')
        and me.status = 'active'
    )
  order by coalesce(p.username, p.email);
$$;

create or replace function public.notify_weekly_credit_renewal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  week_start date;
begin
  week_start := date_trunc('week', now() at time zone 'Asia/Manila')::date;

  insert into public.notifications (user_id, kind, title, body, metadata)
  select
    p.id,
    'credit_renewed',
    'Weekly allowance reset',
    'Your weekly spending period has reset. Check your profile menu for the available allowance.',
    jsonb_build_object('week_start', week_start::text)
  from public.profiles p
  where p.status = 'active'
    and p.role in ('editor', 'trusted_editor', 'hybrid_editor', 'ai_animator', 'admin')
  on conflict do nothing;
end;
$$;

create or replace function public.notify_limits_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  limits_body text;
  limits_meta jsonb;
  recent_id uuid;
begin
  if new.weekly_cap_override_usd is not distinct from old.weekly_cap_override_usd
     and new.daily_cap_override_usd is not distinct from old.daily_cap_override_usd
     and new.hourly_cap_override_usd is not distinct from old.hourly_cap_override_usd then
    return new;
  end if;
  -- Non-admin accounts only: an admin's own limits are not an inbox event.
  if new.role not in ('editor', 'trusted_editor', 'hybrid_editor', 'ai_animator') then
    return new;
  end if;

  -- NULL weekly/daily means the role default applies; NULL hourly means no hourly cap.
  limits_body := format(
    'Weekly: %s · Daily: %s · Hourly: %s',
    coalesce('$' || to_char(new.weekly_cap_override_usd, 'FM999,999,990.00'), 'role default'),
    coalesce('$' || to_char(new.daily_cap_override_usd, 'FM999,999,990.00'), 'role default'),
    coalesce('$' || to_char(new.hourly_cap_override_usd, 'FM999,999,990.00'), 'none')
  );
  limits_meta := jsonb_build_object(
    'weekly_usd', new.weekly_cap_override_usd,
    'daily_usd', new.daily_cap_override_usd,
    'hourly_usd', new.hourly_cap_override_usd
  );

  select id into recent_id
    from public.notifications
   where user_id = new.id
     and kind = 'credit_limits_changed'
     and read_at is null
     and created_at > now() - interval '2 minutes'
   order by created_at desc
   limit 1;

  if recent_id is not null then
    update public.notifications
       set body = limits_body, metadata = limits_meta
     where id = recent_id;
  else
    insert into public.notifications (user_id, kind, title, body, metadata)
    values (new.id, 'credit_limits_changed', 'Your spending limits changed', limits_body, limits_meta);
  end if;
  return new;
end;
$$;

-- The two-argument overload stays for the previous release; see the header.

create or replace function outstanding_allowance_usd(
  editor_weekly_default numeric,
  trusted_weekly_default numeric,
  hybrid_editor_weekly_default numeric,
  ai_animator_weekly_default numeric
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
              when 'hybrid_editor' then hybrid_editor_weekly_default
              when 'ai_animator' then ai_animator_weekly_default
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
    left join projects pr on pr.id = r.project_id
    where coalesce(r.user_id, pr.user_id) = p.id
      and r.created_at >= (date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')
  ) spent on true
  where p.role <> 'admin';
$$;

comment on function outstanding_allowance_usd(numeric, numeric, numeric, numeric) is
  'Sum over non-admin accounts, for the current Manila calendar week, of max(0, effective weekly '
  'allowance - spent this week). Role defaults arrive as parameters (0035); 0131 added the '
  'hybrid_editor and ai_animator defaults. Revoked and expired grants excluded (0075).';
