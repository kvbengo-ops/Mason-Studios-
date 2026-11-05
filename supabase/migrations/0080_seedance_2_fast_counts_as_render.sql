-- =============================================================================
-- The two Seedance 2.0 models join the render bucket, in the same change that
-- adds them.
-- =============================================================================
--
-- 0066 replaced a substring match with an explicit list, precisely so that a
-- new model would fail loudly instead of being silently misfiled. It did:
-- web/lib/spend-category-sql.test.ts reads this predicate out of the migration
-- and refuses any model in KIE_MODELS that is missing from it, with a message
-- that says to add it here in the same commit.
--
-- WHAT MISFILING COSTS. Everything not in this list lands in `iterate_usd`,
-- the cheap-iteration bucket meant for describe calls and reference frames.
-- These are the models the editors are being moved to for price, so they
-- would have become the single largest line of spend on the product while
-- /spend reported it as pocket change — the same bug 0056 fixed for fal's
-- naming and 0066 fixed again for kie's.
--
-- The strings are Descriptor.KieModelID, which is what runs.model actually
-- holds: 'bytedance/seedance-2' and 'bytedance/seedance-2-fast'. Not the app's
-- own ids ('seedance-2', 'seedance-2-fast'), which never reach this column.
--
-- Everything else about the function is 0066's, unchanged: the two filters
-- stay exact complements of each other, so iterate_usd + render_usd is still
-- always total_usd.
-- =============================================================================

create or replace function spend_category_totals(from_ts timestamptz, to_ts timestamptz)
returns table(iterate_usd numeric, render_usd numeric, total_usd numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(sum(t.cost_usd) filter (
      where t.model is null or t.model <> all (array[
        'bytedance/seedance-2-5', 'bytedance/seedance-2', 'bytedance/seedance-2-fast',
        'kling-3.0/video', 'hailuo/2-3-image-to-video-pro'
      ])
    ), 0) as iterate_usd,
    coalesce(sum(t.cost_usd) filter (
      where t.model = any (array[
        'bytedance/seedance-2-5', 'bytedance/seedance-2', 'bytedance/seedance-2-fast',
        'kling-3.0/video', 'hailuo/2-3-image-to-video-pro'
      ])
    ), 0) as render_usd,
    coalesce(sum(t.cost_usd), 0) as total_usd
  from (
    select r.cost_usd, r.vendor, r.model
    from runs r
    where r.created_at >= from_ts and r.created_at < to_ts

    union all

    select h.cost_usd, h.vendor, h.model
    from deleted_project_cost_history h
    where h.run_created_at >= from_ts and h.run_created_at < to_ts
  ) t;
$$;

comment on function spend_category_totals(timestamptz, timestamptz) is
  'Splits spend into cheap iteration and paid renders. The render list is every '
  'Descriptor.KieModelID in worker/internal/kie/models.go — kept explicit since 0066 so a new '
  'model fails web/lib/spend-category-sql.test.ts instead of being silently counted as '
  'iteration. seedance-2 and seedance-2-fast added in 0080.';
