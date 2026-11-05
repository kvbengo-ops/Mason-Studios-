alter table public.elements
  add column deleted_at timestamptz,
  add column deleted_by uuid references public.profiles(id);

alter table public.elements
  drop constraint elements_user_id_name_key;

create unique index elements_active_user_id_name_key
  on public.elements (user_id, name)
  where deleted_at is null;

drop policy elements_select on public.elements;

create policy elements_select on public.elements
  for select
  using (
    deleted_at is null
    and (is_shared or user_id = auth.uid() or is_admin())
  );

alter policy assets_select on public.assets
  using (
    assets.user_id = auth.uid()
    or (assets.user_id is not null and is_admin())
    or exists (
      select 1 from public.projects p
      where p.id = assets.project_id
        and (p.user_id = auth.uid() or is_admin())
    )
    or exists (
      select 1 from public.elements e
      where e.asset_id = assets.id
        and e.deleted_at is null
        and (e.is_shared or e.user_id = auth.uid() or is_admin())
        and account_owns_asset(e.user_id, assets.id)
    )
  );

create or replace function public.element_creators()
returns table (id uuid, display_name text)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, coalesce(p.username, p.email) as display_name
  from profiles p
  where is_active()
    and exists (
      select 1 from elements e
      where e.user_id = p.id
        and e.deleted_at is null
    );
$$;

comment on column public.elements.deleted_at is
  'When the reference was removed from every active library and prompt lookup. NULL means active.';

comment on column public.elements.deleted_by is
  'The owner or administrator who removed this reference. The row and source asset remain recoverable.';
