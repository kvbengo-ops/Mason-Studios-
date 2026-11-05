-- Uploads publish to the shared library; Save to mine creates a personal entry.
-- Existing rows remain shared: old copies have no reliable provenance marker.
alter table public.elements
  add column is_shared boolean not null default true;

comment on column public.elements.is_shared is
  'Direct uploads are shared; personal copies saved from the shared library are not republished.';

alter policy elements_select on public.elements
  using (is_shared or user_id = auth.uid() or is_admin());
