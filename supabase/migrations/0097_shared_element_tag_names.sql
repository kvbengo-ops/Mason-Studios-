-- Preserve existing names; prevent new shared-name collisions, including renames.
create or replace function public.guard_shared_element_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not new.is_shared then return new; end if;
  if tg_op = 'UPDATE' then
    if old.is_shared and lower(old.name) = lower(new.name) then return new; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('shared-element-name:' || lower(new.name), 0));
  if exists (
    select 1 from public.elements e
    where e.is_shared and lower(e.name) = lower(new.name) and e.id <> new.id
  ) then
    raise exception 'That shared tag name is already used.' using errcode = '23505';
  end if;
  return new;
end;
$$;

create trigger guard_shared_element_name
before insert or update of name, is_shared on public.elements
for each row execute function public.guard_shared_element_name();
