-- RLS: evaluate auth.uid() once per query, not once per row.
--
-- A policy written `user_id = auth.uid()` calls auth.uid() for every row it
-- checks. Wrapped as `(select auth.uid())`, Postgres plans it as an InitPlan:
-- one call per statement, the rest is a plain comparison. Same result, same
-- rows; Supabase's linter flags the unwrapped form (auth_rls_initplan). 49
-- policies (42 public, 7 storage) had it on 2026-11-12.
--
-- Done from pg_policies rather than by re-creating 49 policies by hand, so it
-- cannot drift from what is actually installed: each policy's own deparsed
-- USING / WITH CHECK text is rewritten and applied with ALTER POLICY, which
-- keeps its name, command, roles and permissive/restrictive mode. An
-- occurrence already wrapped ("select auth.uid()") is left alone, so running
-- this twice changes nothing. Applied to prod 2026-11-12: 42 public + 7 storage
-- policies rewritten, none skipped, no bare auth.uid() left.
--
-- A storage policy this role may not alter is skipped with a NOTICE instead of
-- failing the whole migration; the public ones are the hot path.

do $$
declare
  pol record;
  new_qual text;
  new_check text;
  stmt text;
begin
  for pol in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname in ('public', 'storage')
      and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ 'auth\.uid\(\)'
  loop
    new_qual := case
      when pol.qual is null then null
      else regexp_replace(pol.qual, '(?<!select )auth\.uid\(\)', '(select auth.uid())', 'gi')
    end;
    new_check := case
      when pol.with_check is null then null
      else regexp_replace(pol.with_check, '(?<!select )auth\.uid\(\)', '(select auth.uid())', 'gi')
    end;

    if new_qual is not distinct from pol.qual and new_check is not distinct from pol.with_check then
      continue;
    end if;

    stmt := format('alter policy %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);
    if new_qual is not null then
      stmt := stmt || format(' using (%s)', new_qual);
    end if;
    if new_check is not null then
      stmt := stmt || format(' with check (%s)', new_check);
    end if;

    begin
      execute stmt;
    exception when insufficient_privilege then
      raise notice 'skipped %.%.%: not owner', pol.schemaname, pol.tablename, pol.policyname;
    end;
  end loop;
end
$$;
