-- outstanding_allowance_usd: same total, without a per-account runs scan.
--
-- 0138's body joined a lateral per profile whose filter was
-- `coalesce(r.user_id, pr.user_id) = p.id`. No index can serve a coalesce, so
-- every non-admin account re-read the whole week's runs (joined to projects):
-- ~0.3 s alone, 1.9 s mean in prod (2026-11-21).
--
-- Now each source is read once and grouped by owner, split the way
-- account_spend_windows already splits it:
--   runs with a user_id          -> that user
--   runs without one, in a project -> the project's owner
-- which is exactly what the coalesce meant (a run with neither matched no
-- one, and still matches no one). Grants are grouped once the same way.
-- Signature, security invoker and the revoked/expiry filters are unchanged.
create or replace function outstanding_allowance_usd(
  editor_weekly_default numeric,
  trusted_weekly_default numeric,
  hybrid_editor_weekly_default numeric,
  ai_animator_weekly_default numeric
)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  with week as (
    select public.manila_spend_week_start(now()) as start
  ),
  spent as (
    select s.owner_id, sum(s.cost_usd) as spend_usd
    from (
      select r.user_id as owner_id, r.cost_usd
      from runs r, week w
      where r.user_id is not null
        and r.created_at >= w.start
      union all
      select pr.user_id, r.cost_usd
      from runs r
      join projects pr on pr.id = r.project_id, week w
      where r.user_id is null
        and r.created_at >= w.start
    ) s
    group by s.owner_id
  ),
  grants as (
    select g.user_id, sum(g.amount_usd) as total_usd
    from allowance_grants g
    where g.expires_at > now()
      and g.revoked_at is null
    group by g.user_id
  )
  select coalesce(
    sum(
      greatest(
        0,
        (
          coalesce(
            p.weekly_cap_override_usd,
            case p.role
              when 'trusted_editor' then trusted_weekly_default
              when 'hybrid_editor' then hybrid_editor_weekly_default
              when 'ai_animator' then ai_animator_weekly_default
              else editor_weekly_default
            end
          )
          + coalesce(grants.total_usd, 0)
        )
        - coalesce(spent.spend_usd, 0)
      )
    ),
    0
  )
  from profiles p
  left join grants on grants.user_id = p.id
  left join spent on spent.owner_id = p.id
  where p.role <> 'admin';
$$;
