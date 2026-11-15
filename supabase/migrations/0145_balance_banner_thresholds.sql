-- Manual low-funds banner thresholds on Accounts Control, set in the Balance
-- alerts dialog next to the email thresholds (0140) but independent of them.
--
-- NULL keeps today's behaviour: Kie's banner fires on the automatic runway
-- rule (lib/runway.ts, under 3 days at the trailing 7-day burn) and BytePlus
-- has none. A value replaces that rule: the banner shows while the balance is
-- below it. Display only; nothing here blocks a render or sends an email.
-- Same writers and RLS as the rest of the row (setBalanceAlerts, requireAdmin).

alter table balance_alert_settings
  add column kie_banner_threshold_usd numeric
    check (kie_banner_threshold_usd is null or kie_banner_threshold_usd >= 0),
  add column byteplus_banner_threshold_usd numeric
    check (byteplus_banner_threshold_usd is null or byteplus_banner_threshold_usd >= 0);

comment on column balance_alert_settings.kie_banner_threshold_usd is
  'Accounts Control shows the Kie low-funds banner below this balance; null = automatic runway rule.';
comment on column balance_alert_settings.byteplus_banner_threshold_usd is
  'Accounts Control shows the BytePlus low-funds banner below this balance; null = no banner.';
