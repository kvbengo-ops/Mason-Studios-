-- =============================================================================
-- Drop profiles.daily_cap_enabled — a column with readers and no writer.
-- =============================================================================
-- 0077 added it as the per-account half of the daily-guard switch: NULL
-- follows app_settings.user_daily_cap_enabled, true/false override it. The
-- selector that wrote it was removed before either shipped — three states
-- above a field admins already had was a choice nobody had asked to make —
-- and the column was left in place on the theory that it was inert while
-- null and the capability might come back.
--
-- That theory is exactly the one this schema has already been burned by.
-- profiles.daily_cap_override_usd sat unwritten from 0031 until the dialog
-- that finally set it, while /users rendered "spent today / $X" against a
-- figure no admin on that page could change. A column that is read in two
-- modules and written in none is not a dormant feature, it is a number
-- whose provenance the next reader has to reconstruct.
--
-- So it goes back out, and the resolution collapses to what it always
-- actually was: one installation setting, read by
-- lib/spend.ts's getUserDailyCapEnabled. dailyCapEnabledFor is deleted with
-- it — a two-argument resolver whose second argument can only ever be NULL
-- is a branch that cannot be taken.
--
-- NO DATA IS LOST. Nothing ever wrote this column, so every row holds NULL,
-- and NULL meant "follow the installation default" — which is precisely the
-- behaviour that remains once the column is gone. The drop changes what an
-- account resolves to for exactly zero accounts.
--
-- If per-account on/off is genuinely wanted later, it comes back as a
-- migration WITH its writer in the same change. That is the rule this file
-- exists to restate.
-- =============================================================================

alter table profiles
  drop column daily_cap_enabled;

comment on column app_settings.user_daily_cap_enabled is
  'Whether the per-user daily burst guard is enforced. The ONLY input to that decision since '
  '0078_drop_daily_cap_enabled.sql: profiles.daily_cap_enabled was added by 0077 as a per-account '
  'override, never given a write path, and dropped rather than left readable-but-unwritable — see '
  'that migration for why this schema treats that state as a defect rather than a dormant feature. '
  'Defaults false: the weekly allowance and GLOBAL_DAILY_CAP_USD are the ceilings that bound '
  'spend, and the editors asked not to be stopped mid-job by a daily one.';
