-- Deactivation: cutting off an account that is already active and working.
--
-- 'rejected' is deliberately NOT reused for this. Rejected means "this
-- application was never accepted"; deactivated means "this colleague was
-- working here and no longer is". They read differently to the person held
-- at /pending, they are undone by different decisions, and collapsing them
-- would make the /users list unable to tell a never-approved stranger from a
-- former teammate.
--
-- Nothing else needs to change. is_active() is already
-- `role = 'admin' or status = 'active'`, so the 13 RLS policies that call it
-- refuse a deactivated account the moment this status is set, and the
-- application twin (canUseApp in lib/account-approval.ts) redirects them to
-- /pending on their next request. Widening the vocabulary is the whole
-- database change.

alter table profiles drop constraint profiles_status_check;
alter table profiles add constraint profiles_status_check
  check (status in ('pending', 'active', 'rejected', 'deactivated'));

comment on column profiles.status is
  'pending: awaiting an admin decision. active: may use the app. rejected: the application was refused. deactivated: was active, and an admin has since cut off access.';
