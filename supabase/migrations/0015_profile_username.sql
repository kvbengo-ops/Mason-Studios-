-- =============================================================================
-- profiles.username — a self-chosen, public-facing handle
--
-- Self-serve signup (web/actions/auth.ts) currently identifies an account
-- only by email, which is fine internally but is not something we want to
-- print anywhere a second user might see it — it leaks a real address for
-- no product reason. A username is the field that lets us reference an
-- account (attribution, an eventual "who last touched this project" line,
-- support conversations) without doing that.
--
-- Case-insensitive uniqueness, via a unique index on lower(username) rather
-- than a unique constraint on the column itself:
--
--   "alice" and "Alice" resolving to two different accounts is not a
--   feature — nobody types a username expecting case to be significant,
--   so two accounts differing only in case is purely a support problem
--   (which one did I sign up with?) with zero upside. A plain `unique`
--   constraint on `username` would allow exactly that. Indexing
--   lower(username) instead makes the collision the *storage engine's*
--   problem at insert time, so there is no window where the trigger and a
--   client-side check can race and both believe a name is free.
--
--   The column itself stays case-preserving (no lower() cast on write) so
--   a user who typed "DarwinA" sees "DarwinA" reflected back, not
--   "darwina" — the index enforces unique *identity*, not a display
--   convention.
--
-- Length and character class: 3–20 characters, [A-Za-z0-9_] only.
--
--   3 is the same floor most handle systems use (shorter is mostly
--   confusable single/double-character squatting, not a real name). 20 is
--   generous for a handle and keeps it well clear of any UI truncation
--   concerns. The character class excludes spaces, punctuation, and
--   anything outside ASCII: this value is going to appear unescaped in
--   places a display name would need HTML/URL escaping and a handle
--   shouldn't, so keeping the legal alphabet boring removes a whole class
--   of "is this safe to interpolate" questions later for free. Emoji and
--   accented characters are a real product ask eventually, but that is a
--   deliberate future decision (probably: relax the CHECK, keep the
--   lower() index, add normalization), not a default to fall into now.
--
-- Backfill before NOT NULL, in that order, in this one transaction:
--
--   The three rows that predate this migration were provisioned by hand in
--   the Supabase dashboard (see 0004_profile_trigger.sql) and have no
--   username. Adding the column, backfilling every existing NULL, THEN
--   adding NOT NULL is the only safe order — flipping it means the NOT
--   NULL add fails outright (existing NULLs violate it immediately), and
--   skipping the backfill entirely means those three accounts break every
--   `profiles.username` read the moment this ships. The backfill derives a
--   candidate from the email local part (lowercased, stripped to the legal
--   charset, padded up to the 3-character floor, truncated to the
--   20-character ceiling) and de-duplicates within the backfill set itself
--   using row_number() — belt-and-suspenders given there are only three
--   rows today, but it means this migration doesn't silently depend on
--   today's data staying collision-free if it's ever re-run against a
--   larger seed set.
-- =============================================================================

alter table profiles
  add column if not exists username text;

with base as (
  select
    id,
    regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9_]', '', 'g') as candidate
  from profiles
  where username is null
),
padded as (
  select
    id,
    case
      when length(candidate) < 3 then left(rpad(candidate || 'user', 3, '0'), 20)
      else left(candidate, 20)
    end as candidate
  from base
),
numbered as (
  select
    id,
    candidate,
    row_number() over (partition by candidate order by id) as rn
  from padded
)
update profiles p
set username = case
  when n.rn = 1 then n.candidate
  else left(n.candidate, 20 - length(n.rn::text)) || n.rn::text
end
from numbered n
where p.id = n.id;

alter table profiles
  add constraint profiles_username_charset_check
  check (username is not null and username ~ '^[A-Za-z0-9_]{3,20}$');

create unique index if not exists profiles_username_lower_idx
  on profiles (lower(username));

alter table profiles
  alter column username set not null;

comment on column profiles.username is
  'Self-chosen public handle. Case-preserving on write; uniqueness enforced '
  'case-insensitively via profiles_username_lower_idx (lower(username)), not a plain '
  'unique constraint on the column — see 0015 for why. 3-20 chars, [A-Za-z0-9_] only.';

-- -----------------------------------------------------------------------------
-- handle_new_user() — extend to populate the new column
--
-- 0004_profile_trigger.sql already established that a dashboard-created
-- user must still get a working profiles row, since there is no signup
-- form standing between the insert into auth.users and the trigger firing.
-- That constraint now applies to username too: a user hand-created in the
-- dashboard has no `raw_user_meta_data.username` (nothing put it there),
-- so the same email-local-part derivation used in the backfill above is
-- repeated here as the fallback, rather than letting the insert fail the
-- NOT NULL/CHECK constraints and take the whole signup down with it.
--
-- The self-serve path (web/actions/auth.ts signUp) passes options.data.username
-- through supabase.auth.signUp, which is what populates raw_user_meta_data;
-- that action validates the value against the same charset/length rules
-- (web/lib/signup-username.ts) before ever calling signUp, so the normal
-- path reaches this function with an already-legal value and the fallback
-- below exists for the dashboard path, not as the primary line of defense.
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta_username text := nullif(trim(new.raw_user_meta_data ->> 'username'), '');
  fallback_username text;
begin
  if meta_username is null then
    fallback_username := regexp_replace(lower(split_part(new.email, '@', 1)), '[^a-z0-9_]', '', 'g');
    if length(fallback_username) < 3 then
      fallback_username := rpad(fallback_username || 'user', 3, '0');
    end if;
    fallback_username := left(fallback_username, 20);
  end if;

  insert into public.profiles (id, email, role, username)
  values (new.id, new.email, 'editor', coalesce(meta_username, fallback_username));
  return new;
end;
$$;
