-- =============================================================================
-- The per-user daily burst guard becomes a setting an admin can change,
-- instead of a deploy-time environment variable.
-- =============================================================================
-- USER_DAILY_CAP_ENABLED (render.yaml, read by lib/spend.ts's
-- isUserDailyCapEnabled) answered "is the daily guard on" for the whole
-- installation, identically for every account, and could only be changed by
-- editing a YAML file and redeploying. Two things were wrong with that:
--
--   1. Nobody who needed the answer could change it. Deciding whether an
--      editor gets a daily ceiling is an operations question an admin
--      answers from /users, not a deploy.
--   2. It was all-or-nothing. The team needed a floor for editors still
--      learning what a render costs, and no floor for the ones who had
--      already asked, in writing, to stop being stopped mid-job. One
--      variable cannot say both.
--
-- So: a global default that lives in the database and is editable from the
-- app, plus a per-account override that wins over it.
--
--   app_settings.user_daily_cap_enabled  — the default for every account
--   profiles.daily_cap_enabled           — NULL follows that default,
--                                          true/false overrides it
--
-- The env var is retired. Two sources of truth for one switch is how the
-- deployed answer and the displayed answer end up disagreeing, and this
-- schema has been bitten by a version of that before (0031's role caps still
-- live in env vars, which is why setAllEditorsWeeklyCap has to write a value
-- onto every row rather than change a default — see that action's own note).
--
-- WHY A TABLE RATHER THAN A COLUMN ON EVERY PROFILE. A bulk write onto
-- profiles was the cheaper option and was rejected on one point: an account
-- created afterwards has no value, so "global" would silently stop applying
-- to exactly the people most likely to need it — new hires. A default has to
-- live somewhere a new row can inherit from at read time.
-- =============================================================================

-- =============================================================================
-- 1. app_settings — one row, forever
-- =============================================================================
-- `id boolean primary key default true check (id)` is the singleton idiom:
-- the primary key admits exactly one value, so a second row cannot be
-- inserted even by a direct SQL client. Cheaper and harder to defeat than a
-- trigger, and it means every reader can `limit 1` without ordering.
--
-- Deliberately NOT a key/value table. One typed column per setting keeps the
-- schema self-describing and lets Postgres enforce the type; a `text` value
-- column would push "is this the string 'true' or the string '1'" into every
-- reader, which is the same class of bug parseCapEnvUsd exists to stop for
-- the cap env vars.
create table app_settings (
  id boolean primary key default true check (id),
  user_daily_cap_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);

comment on table app_settings is
  'Installation-wide settings an admin changes from the app, one row enforced by the boolean '
  'primary key. Distinct from the cap AMOUNTS (DAILY_CAP_USD and friends), which are still env '
  'vars read by lib/spend.ts''s resolveAccountCaps — that function is synchronous and pure and is '
  'depended on as such by assertWithinSpendCaps and every UI surface, so moving amounts here would '
  'make it an async DB read. Only the on/off switch moved.';

comment on column app_settings.user_daily_cap_enabled is
  'Whether the per-user daily burst guard is enforced for accounts that have not overridden it '
  '(profiles.daily_cap_enabled is null). Replaces the USER_DAILY_CAP_ENABLED env var. Defaults '
  'false: the weekly allowance and GLOBAL_DAILY_CAP_USD are the ceilings that bound spend, and '
  'the editors asked not to be stopped mid-job by a daily one.';

comment on column app_settings.updated_by is
  'The admin who last changed a setting here — the same accountability granted_by gives a grant. '
  'Nullable because the seeded row below was written by no one.';

-- The one row. Defaults apply, so this needs no column list beyond the key.
insert into app_settings (id) values (true);

alter table app_settings enable row level security;

-- Readable by any signed-in account: getSidebarBudget and the render page
-- resolve the effective flag for the CALLER, and an editor has to be able to
-- learn whether their own daily guard is on. Nothing here is sensitive — it
-- is a boolean about product behaviour, not about money or people.
create policy app_settings_select on app_settings
  for select
  using (auth.uid() is not null);

-- No insert, update or delete policy: default-deny for those commands, the
-- same posture allowance_grants takes (0032). The single writer is
-- web/actions/account.ts's setUserDailyCapEnabled behind requireAdmin(),
-- through createAdminClient()'s service role — so "an editor turns their own
-- daily guard off" is unreachable rather than merely unauthorized.

-- =============================================================================
-- 2. profiles.daily_cap_enabled — the per-account override
-- =============================================================================
-- Three states, and the nullable column is what makes the third one
-- expressible: null means "whatever the installation says", which is a
-- different answer from "off" and has to survive an admin changing the
-- global default. An account set explicitly to false stays off when the
-- global flips on; an account left null follows it.
alter table profiles
  add column daily_cap_enabled boolean;

comment on column profiles.daily_cap_enabled is
  'Whether the per-user daily burst guard applies to THIS account. NULL (the default, and every '
  'account before this migration) follows app_settings.user_daily_cap_enabled; true or false '
  'overrides it in that direction and keeps overriding it when the global default changes. '
  'Resolved by web/lib/spend.ts''s dailyCapEnabledFor, which is pure and takes both values as '
  'arguments — see it for why the resolution is not done in SQL.';

-- No index. This column is only ever read as part of a profile row already
-- being fetched by primary key (requireUser's select *, /users' page query),
-- never filtered on — the same reason daily_cap_override_usd (0031) has none.
