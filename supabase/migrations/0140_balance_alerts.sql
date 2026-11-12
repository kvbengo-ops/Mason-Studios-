-- Low-balance email alerts for the two vendor accounts (kie, BytePlus).
--
-- One row, like app_settings (0077), but its own table: app_settings is
-- readable by every signed-in account, and who gets paged about vendor money,
-- at what level, is admin business. Admins read it through RLS; the only
-- writers are web/actions/account.ts's setBalanceAlerts (requireAdmin) and
-- web/lib/balance-alert.ts, both on the service role.
--
-- A threshold of NULL means no alert for that vendor. *_alerted_at is the
-- latch that keeps one dip below the line to one email: set when the email
-- goes out, cleared once the balance is back at or above the threshold.

create table balance_alert_settings (
  id boolean primary key default true check (id),
  kie_threshold_usd numeric check (kie_threshold_usd is null or kie_threshold_usd >= 0),
  byteplus_threshold_usd numeric
    check (byteplus_threshold_usd is null or byteplus_threshold_usd >= 0),
  recipient_ids uuid[] not null default '{}',
  kie_alerted_at timestamptz,
  byteplus_alerted_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id) on delete set null
);

comment on table balance_alert_settings is
  'Low-balance email alerts for kie and BytePlus: per-vendor USD thresholds (null = off), the '
  'admins to email, and a per-vendor latch so one dip sends one email. See 0140_balance_alerts.sql.';

insert into balance_alert_settings (id) values (true);

alter table balance_alert_settings enable row level security;

create policy balance_alert_settings_select on balance_alert_settings
  for select
  using ((select is_admin()));

-- No insert, update or delete policy: default-deny. Writes go through the
-- service role only, behind requireAdmin().
