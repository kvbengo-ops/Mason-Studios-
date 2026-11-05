-- =============================================================================
-- Every report filed from inside the app, so the button cannot become a
-- megaphone.
-- =============================================================================
--
-- WHY A TABLE AND NOT A COUNTER IN MEMORY. The rate limit is the only thing
-- standing between one bad afternoon and forty identical issues, and an
-- in-process counter resets on every deploy and does not exist at all on the
-- second instance. A row per report is also the answer to "did anyone
-- actually report this?", which is the question asked after the fact.
--
-- WHAT IT DOES NOT HOLD. The issue's body lives on GitHub, not here — this
-- is a ledger of what was sent and by whom, not a second copy of it. `title`
-- is kept because it is what a duplicate check compares and what makes the
-- rows readable; `body_hash` covers the rest without storing it.

create table if not exists issue_reports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  title        text not null,
  -- A digest of title + description, for the "pressed submit twice" case.
  -- Not a unique constraint: the SAME report a week later is a legitimate
  -- second report ("this is still happening"), and only the window makes it
  -- a duplicate.
  body_hash    text not null,
  -- Null until GitHub answers. A row with no number is a report that was
  -- attempted and failed, which is worth being able to count.
  issue_number integer,
  issue_url    text,
  created_at   timestamptz not null default now()
);

-- The rate-limit read is "this user, since this timestamp", and the
-- duplicate read is the same window narrowed by hash.
create index if not exists issue_reports_user_id_created_at_idx
  on issue_reports (user_id, created_at desc);

alter table issue_reports enable row level security;

-- A reporter can see their own; admins see everything. Nobody writes through
-- the session client — submitIssue uses the admin client, the same way every
-- other write that has to be trusted does — so there is no insert policy
-- here on purpose.
create policy issue_reports_select on issue_reports
  for select to authenticated
  using (user_id = auth.uid() or is_admin());

comment on table issue_reports is
  'One row per report submitted from the in-app Report a problem dialog. Rate limit and '
  'duplicate window read from here; the issue itself lives on GitHub.';
