-- Admins are trusted by role and do not need a separate account-approval
-- decision. Editor and trusted_editor accounts still require status='active'.
--
-- This replaces the helper used by every spend-chain write policy. Keeping
-- the exception here as well as in web/actions/guard.ts prevents the app and
-- direct PostgREST access from disagreeing about a pending admin.

create or replace function is_active()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from profiles
    where id = auth.uid()
      and (role = 'admin' or status = 'active')
  );
$$;

comment on function is_active() is
  'True when the calling account may use the app: admins are trusted by role; editor and '
  'trusted_editor accounts require profiles.status = ''active''. Mirrors web/lib/account-approval.ts '
  'and guards every spend-chain write policy established by migrations 0052 and 0053.';
