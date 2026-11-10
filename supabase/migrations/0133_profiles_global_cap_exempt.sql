-- Per-account exemption from the team-wide spending cap (app_settings.global_spend_cap_*).
-- Set by an admin from the Users page's Allowance dialog (setGlobalCapExempt). An exempt
-- account's spend still counts toward the team total; only the block is skipped.
-- No client can write it: profiles has no UPDATE policy, writes go through the service role.
alter table profiles
  add column global_cap_exempt boolean not null default false;

comment on column profiles.global_cap_exempt is
  'True: the team-wide spending cap never blocks this account. Its spend still counts toward the team total.';
