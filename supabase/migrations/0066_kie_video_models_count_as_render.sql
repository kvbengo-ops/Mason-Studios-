-- =============================================================================
-- The bug 0056_seedance_counts_as_render.sql fixed, reappeared for a third
-- naming convention.
--
-- 0056 widened the render-bucket predicate from `%image-to-video%` to
-- `%-to-video%` specifically because fal's endpoint names shared that
-- substring across every model this app could route to. That was true right
-- up until fal was decommissioned: worker/internal/kie/models.go's
-- Descriptor.KieModelID is the string kie itself expects on the wire, and
-- what runs.model now holds for every video render, and TWO of the three
-- current models do not contain "-to-video" at all:
--
--   bytedance/seedance-2-5     <- Seedance 2.5, the DEFAULT model
--   kling-3.0/video            <- Kling 3.0 Pro, contains "/video" but not
--                                  "-to-video"
--   hailuo/2-3-image-to-video-pro   <- the one model that still matches
--
-- So since the kie cutover, every Seedance and every Kling render -- the two
-- models this product actually offers scenes to by default and by explicit
-- selection -- has been reported on /spend as cheap iteration, the same
-- shape of undercount 0056 already fixed once for a different set of
-- strings.
--
-- ---------------------------------------------------------------------------
-- The fix this time: an exact-match list, not another LIKE convention
-- ---------------------------------------------------------------------------
-- There is no longer a shared naming convention to key a LIKE off -- kie's
-- three wire ids come from three unrelated vendor-naming schemes (see
-- web/lib/kie/models.ts's KieModel.kieModelName doc comment: "owner/name",
-- "version/media-type", "owner/model-shape"). Guessing at a fourth
-- convention is how this bug happened twice; enumerating the three ids kie
-- actually serves is both correct today and self-evidently exhaustive --
-- there is nothing implicit left for a fourth model to accidentally not
-- share. web/lib/spend-categories.ts's categorizeRun mirrors this exactly
-- (VIDEO_MODEL_WIRE_IDS, built from web/lib/kie/models.ts's KIE_MODELS) and
-- was never wrong, same as 0056 already noted about the old endpoint Set --
-- this SQL copy is what drifts, because it has no TypeScript import to stay
-- honest against.
--
-- The `vendor = 'kie'` clause is NOT restored: lib/kie.ts's own image
-- generation (reference frames, character/composite regeneration) ALSO
-- writes vendor='kie' now, at model strings ("google/nano-banana",
-- "google/nano-banana-edit") that are not in this list -- so vendor alone
-- still cannot tell a render apart from an image, exactly as 0056's header
-- already established for the fal/kie split it was written for.
--
-- Both functions below are byte-for-byte 0056's definitions with only the
-- predicate changed from a LIKE to an exact-match ANY(ARRAY[...]).
--
-- iterate_usd's predicate is `t.model is null or t.model <> all (array[...])`,
-- not `t.model is distinct from all (array[...])` — Postgres's ALL/ANY
-- array-quantifier form only composes with a genuine binary operator
-- (`=`, `<>`, ...), and `IS DISTINCT FROM` isn't one; `expr IS DISTINCT
-- FROM ALL (array)` is a syntax error, not the null-safe "not equal to any
-- of these" it reads as. Spelled out instead: null-safe in the same way
-- (a run with no model, which nothing currently writes but the schema
-- permits, still counts as iterate rather than silently vanishing from
-- both buckets — see runs.model / deleted_project_cost_history.model), and
-- exhaustive with render_usd's `= any (array[...])` — every row lands in
-- exactly one of the two filters, so iterate_usd + render_usd always equals
-- total_usd.
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
        'bytedance/seedance-2-5', 'kling-3.0/video', 'hailuo/2-3-image-to-video-pro'
      ])
    ), 0) as iterate_usd,
    coalesce(sum(t.cost_usd) filter (
      where t.model = any (array[
        'bytedance/seedance-2-5', 'kling-3.0/video', 'hailuo/2-3-image-to-video-pro'
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

comment on function spend_category_totals is
  'Team-wide iterate-vs-render split for runs created in [from_ts, to_ts), including archived runs '
  'from deleted projects/scenes (0038; unioned in by 0040_include_archived_cost_in_spend_reads.sql). '
  'A run counts as ''render'' when runs.model is one of kie''s three video wire ids -- '
  '''bytedance/seedance-2-5'', ''kling-3.0/video'', ''hailuo/2-3-image-to-video-pro'' -- an '
  'exact-match list replacing the ''%-to-video%'' LIKE by '
  '0066_kie_video_models_count_as_render.sql, because two of the three no longer share that '
  'substring after the fal-to-kie cutover. See that migration''s header. Backs /spend''s breakdown '
  'tile.';

-- spend_category_totals_by_user (0037, archive-aware since 0040) -- per user,
-- SECURITY INVOKER (unchanged). Same predicate change as above.
create or replace function spend_category_totals_by_user(from_ts timestamptz, to_ts timestamptz)
returns table(user_id uuid, email text, iterate_usd numeric, render_usd numeric, total_usd numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select
    t.user_id,
    max(t.email) as email,
    coalesce(sum(t.cost_usd) filter (
      where t.model is null or t.model <> all (array[
        'bytedance/seedance-2-5', 'kling-3.0/video', 'hailuo/2-3-image-to-video-pro'
      ])
    ), 0) as iterate_usd,
    coalesce(sum(t.cost_usd) filter (
      where t.model = any (array[
        'bytedance/seedance-2-5', 'kling-3.0/video', 'hailuo/2-3-image-to-video-pro'
      ])
    ), 0) as render_usd,
    coalesce(sum(t.cost_usd), 0) as total_usd
  from (
    select p.user_id, prof.email, r.cost_usd, r.vendor, r.model
    from runs r
    join projects p on p.id = r.project_id
    left join profiles prof on prof.id = p.user_id
    where r.created_at >= from_ts and r.created_at < to_ts

    union all

    select h.user_id, prof.email, h.cost_usd, h.vendor, h.model
    from deleted_project_cost_history h
    left join profiles prof on prof.id = h.user_id
    where h.user_id is not null
      and h.run_created_at >= from_ts
      and h.run_created_at < to_ts
  ) t
  group by t.user_id
  order by total_usd desc;
$$;

comment on function spend_category_totals_by_user is
  'Per-user iterate-vs-render split for runs created in [from_ts, to_ts), including each user''s '
  'archived runs from deleted projects/scenes (0038; unioned in by '
  '0040_include_archived_cost_in_spend_reads.sql). Archived rows with no resolved user_id are '
  'excluded from this per-user breakdown, same reasoning as spend_totals_by_user. Joins runs -> '
  'projects directly (matching user_spend_usd and RLS''s own runs_select) rather than through '
  'scenes. Category predicate is an exact-match list of kie''s video wire ids as of '
  '0066_kie_video_models_count_as_render.sql -- see there. Backs /spend''s Per-user totals table.';
