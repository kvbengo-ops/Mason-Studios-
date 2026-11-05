-- =============================================================================
-- fal_topups — a manual ledger of when the fal account was funded
-- (Part 2 of the task that added this file: "there is no record of top-ups,
-- so nobody can measure how fast money is going out").
--
-- NOT APPLIED as of this migration being written — same constraint as
-- 0031/0032/0033/0035: reviewed and staged, not run. I apply migrations
-- myself.
--
-- Why manual, not observed: this app has no integration with fal's own
-- billing/payments surface (lib/fal-balance.ts reads a BALANCE, a snapshot,
-- not a ledger of deposits — fal's API has no "list your top-ups" endpoint
-- to poll). An admin adds funds in fal's own dashboard, outside this
-- product entirely, so the only way this app ever learns a top-up happened
-- is if someone tells it. This table is that telling — a row an admin
-- writes AFTER funding the account for real, not a request/approval flow
-- and not something any other part of this schema can infer or backfill.
--
-- Why this needs to exist at all: lib/fal-balance.ts's getFalAccountBalanceUsd
-- gives a POINT-IN-TIME balance. Without a top-up history, an admin looking
-- at "$31.17 left" has no way to tell whether that is trending toward zero
-- fast or slow — the balance alone answers "how much is left", never "how
-- fast is it going". This table is what makes the second question
-- answerable at all: pair it with lib/runway.ts's trailing-spend burn rate
-- (web/app/(app)/spend/page.tsx) to see funding cadence against burn
-- cadence, not just a lone dollar figure.
-- =============================================================================

create table fal_topups (
  id            uuid primary key default gen_random_uuid(),
  amount_usd    numeric not null,
  topped_up_at  timestamptz not null default now(),
  recorded_by   uuid not null references profiles(id),
  note          text,
  created_at    timestamptz not null default now()
);

alter table fal_topups
  add constraint fal_topups_amount_usd_check check (amount_usd > 0);

comment on table fal_topups is
  'A manual ledger entry: an admin funded the fal account (in fal''s own dashboard, outside this '
  'product) and logged it here afterward. Never updated or deleted once written — a ledger, same '
  'posture as allowance_grants (0032_allowance_requests.sql): correcting a mistaken entry means a '
  'new row, not rewriting history. Paired with lib/runway.ts''s trailing-spend burn rate on /spend '
  'to answer "is funding keeping pace with spend", which the balance alone (lib/fal-balance.ts) '
  'cannot.';

comment on column fal_topups.amount_usd is
  'Dollars added to the fal account in this top-up. CHECK > 0 — a "top-up" of $0 or less is not a '
  'top-up; a correction to an over-logged amount is a new (smaller, separately dated) row, not a '
  'negative one, for the same "ledger, never rewritten" reason allowance_grants gives.';

comment on column fal_topups.topped_up_at is
  'WHEN funds actually landed in fal''s account, per fal''s own dashboard — not necessarily the '
  'same instant as created_at (the row-insert time): an admin may log a top-up after the fact, and '
  'this is the timestamp that matters for lining funding events up against the burn-rate chart, not '
  'whenever someone got around to typing it into this app. Defaults to now() for the common case '
  '(logged right after funding) but is a plain, admin-settable column, not a trigger-enforced one.';

comment on column fal_topups.recorded_by is
  'The admin who logged this row — not necessarily who authorized or made the fal payment itself, '
  'just who entered the record. NOT NULL: every row has a named admin behind it, same as '
  'allowance_grants.granted_by.';

comment on column fal_topups.note is
  'Optional free text (an invoice number, why this amount, who asked for it). Nullable — a top-up '
  'needs no explanation to be valid.';

-- "When did we last fund this thing" and "how much came in over some
-- window" are both time-ordered reads (see /spend's recent-top-ups list and
-- any future burn-vs-funding chart) — newest first is the natural order for
-- both, same reasoning as allowance_grants_user_id_expires_at_idx and
-- allowance_requests_status_created_at_idx (0032_allowance_requests.sql).
create index fal_topups_topped_up_at_idx
  on fal_topups (topped_up_at desc);

alter table fal_topups enable row level security;

-- Admin-only read AND write — an editor cannot fund the fal account and has
-- no decision this ledger informs for them (docs/architecture.md's own
-- framing: "an editor can do nothing about the fal balance, and telling
-- them just makes the app feel broken" applies exactly as much to "who
-- funded it and when" as it does to the balance itself). Two separate
-- policies, not one combined `for all`, matching every other admin-scoped
-- table in this schema (allowance_grants, 0032) — `for all` would also
-- cover update/delete, which this ledger deliberately has no policy for at
-- all (see below).
create policy fal_topups_select_admin on fal_topups
  for select
  using (is_admin());

-- with check pins BOTH admin-ness and that the row a caller inserts claims
-- to be recorded by themselves, not some other admin — the same
-- can't-forge-another-actor's-identity shape allowance_requests_insert_own
-- enforces for user_id (0032_allowance_requests.sql), applied here to
-- recorded_by instead since every writer of this table is an admin, not an
-- owning end user.
create policy fal_topups_insert_admin on fal_topups
  for insert
  with check (is_admin() and recorded_by = auth.uid());

-- No update, no delete policy: a table with RLS enabled and no policy for a
-- command is default-deny for that command (0002_rls.sql's own header;
-- 0008's grants bug is the reason this fact is stated explicitly rather
-- than assumed obvious — a table with RLS on and no policy is default-deny,
-- not default-allow). That default is exactly what "a ledger, never
-- rewritten" (this table's own comment) requires — there is nothing to opt
-- out of here, the absence of a policy IS the enforcement, same as
-- allowance_grants (0032_allowance_requests.sql).

-- No new grants needed — 0007_grants.sql's `alter default privileges ...
-- grant all on tables to service_role` / `... select, insert, update,
-- delete on tables to authenticated` already cover this table, the same
-- fact every migration since 0026 has relied on. RLS (above) is what
-- actually narrows `authenticated`'s blanket insert/update/delete grant
-- down to "admins, insert only" in practice.
-- =============================================================================
