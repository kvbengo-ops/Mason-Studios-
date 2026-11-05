-- =============================================================================
-- Profile bootstrap
--
-- Accounts are created by an admin in the Supabase dashboard (Auth > Users);
-- there is no public signup. Without this trigger, a newly created auth.users
-- row has no matching profiles row and every guard.ts check
-- (requireUser/requireProject/requireScene) fails for that user.
--
-- security definer: the trigger runs as the function owner, not the
-- inserting role, so it can write to `public.profiles` even though the
-- insert into `auth.users` happens outside of any authenticated session.
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'editor');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
