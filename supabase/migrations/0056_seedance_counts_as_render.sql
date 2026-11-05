-- =============================================================================
-- Seedance renders were being counted as cheap iteration.
--
-- 0037_spend_category_totals.sql splits /spend into 'iterate' and 'render'
-- with `vendor = 'fal' and model like '%image-to-video%'`, and its own header
-- says exactly what would break it:
--
--   "today's three video endpoints all contain "image-to-video", but if a
--    future model's endpoint does NOT, that model's runs would fall through
--    the "not video" branch into 'iterate' -- visibly wrong (a video render
--    undercounted as cheap iteration) rather than invisibly dropped.
--    Whoever adds a fourth video model must update this CASE in the same
--    commit."
--
-- Four Seedance models were added on 2026-08-28 and that CASE was not
-- updated. Their endpoints are `.../reference-to-video`, not
-- `.../image-to-video`:
--
--   bytedance/seedance-2.0/mini/reference-to-video
--   bytedance/seedance-2.0/fast/reference-to-video
--   bytedance/seedance-2.0/reference-to-video
--   bytedance/seedance-2.5/reference-to-video
--
-- So every Seedance render since has been reported as iteration — and these
-- are the most expensive renders in the table, up to $1.1497/s on 2.5 at
-- 1080p against LTX's $0.06/s. The breakdown tile understated the one number
-- it exists to show. Totals were never wrong: total_usd sums the same rows
-- either way, which is precisely why nobody noticed.
--
-- ---------------------------------------------------------------------------
-- Two changes to the predicate, not one
-- ---------------------------------------------------------------------------
-- 1. `%-to-video%` instead of `%image-to-video%`. Still a naming convention
--    rather than an enumerated endpoint list (0037's deliberate choice, kept),
--    but the convention is now the part every video endpoint actually shares:
--    image-to-video, reference-to-video, and a text-to-video that does not
--    exist here yet. Checked against the other direction too — nothing in the
--    'iterate' bucket contains "-to-video": the image endpoints are
--    nano-banana and nano-banana/edit, the compiles are vendor 'anthropic',
--    and transcription is fal-ai/whisper.
--
-- 2. The `vendor = 'fal'` clause is dropped. It was correct when fal was the
--    only vendor that could ever write a video row, and it stops being
--    correct the moment kie.ai renders one: worker/internal/loop/
--    seedance_kie_cutover.go can route Seedance to kie, and dispatch writes
--    the resolved vendor to runs.vendor, so those rows read 'kie'. Keeping
--    the clause would silently reintroduce this same bug for a second time,
--    on the same models. What identifies a video render is the endpoint, not
--    who billed for it.
--
-- web/lib/spend-categories.ts's categorizeRun needs no change: it matches
-- against the exact VIDEO_MODELS endpoint set rather than a LIKE, so it has
-- classified Seedance correctly since the day those descriptors were added.
-- Its doc comment is updated in the same commit to stop describing the SQL
-- side as an image-to-video match.
--
-- Both functions below are byte-for-byte 0040's definitions with only the
-- two predicate changes -- 0040, not 0037, is where the live bodies come
-- from (it unioned the archive into both).
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
      where t.model not like '%-to-video%'
    ), 0) as iterate_usd,
    coalesce(sum(t.cost_usd) filter (
      where t.model like '%-to-video%'
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
  'A run counts as ''render'' when runs.model matches ''%-to-video%'' -- widened from '
  '''%image-to-video%'' and de-coupled from vendor by 0056_seedance_counts_as_render.sql, because '
  'Seedance''s endpoints are reference-to-video and because kie.ai can bill a video row. See that '
  'migration''s header. Backs /spend''s breakdown tile.';

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
      where t.model not like '%-to-video%'
    ), 0) as iterate_usd,
    coalesce(sum(t.cost_usd) filter (
      where t.model like '%-to-video%'
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
  'scenes. Category predicate widened by 0056_seedance_counts_as_render.sql -- see there. Backs '
  '/spend''s Per-user totals table.';
