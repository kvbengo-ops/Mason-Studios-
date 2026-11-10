-- Per-account switch for the daily burst guard. NULL follows the installation setting
-- (app_settings.user_daily_cap_enabled); true/false overrides it for this account.
-- Set by an admin from the Users page's Allowance dialog (setDailyCapEnabled).
-- No client can write it: profiles has no UPDATE policy, writes go through the service role.
alter table profiles
  add column daily_cap_enabled boolean;

comment on column profiles.daily_cap_enabled is
  'NULL: follow app_settings.user_daily_cap_enabled. true/false: the daily burst guard applies to this account or not.';
