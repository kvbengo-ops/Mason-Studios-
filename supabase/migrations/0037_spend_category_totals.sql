-- =============================================================================
-- spend_category_totals / spend_category_totals_by_user — the iterate-vs-
-- render split (Part 1 of the task that added this file).
--
-- NOT APPLIED as of this migration being written — same constraint as every
-- migration since 0031: reviewed and staged, not run. I apply migrations
-- myself.
--
-- ---------------------------------------------------------------------------
-- The question this answers
-- ---------------------------------------------------------------------------
-- /spend reports totals, never what the money bought. "$20 this week" reads
-- identically whether an editor spent it on seven frame regenerations with
-- nothing to show for it, or on one finished ad — and those are completely
-- different problems for an admin to react to. This migration derives that
-- split from data `runs` ALREADY carries (vendor, model — see
-- web/lib/runs.ts's RunRecord) rather than adding a column: nothing about
-- "was this a compile, a reference frame, or a video render" is new
-- information, it was already fully determined by what vendor/model a row
-- was written with.
--
-- ---------------------------------------------------------------------------
-- The two buckets, and how they're told apart
-- ---------------------------------------------------------------------------
--   'render' — a video render, the ONE expensive commit per ad
--     (docs/architecture.md's "Step 7 is irreversible"). Every video model
--     this codebase can route to (LTX, Kling, Veo — web/lib/models.ts's
--     VIDEO_MODELS, mirrored in worker/internal/fal/models.go) submits to a
--     fal endpoint whose path contains "image-to-video" — verified against
--     every Endpoint literal in worker/internal/fal/models.go, the ONLY
--     place a runs.model value naming a video render is ever written
--     (worker/internal/loop/dispatch.go's `model.Endpoint`,
--     assemble.go/reconcile.go/webhook.go's own Vendor: "fal" runs the same
--     way). This is deliberately a LIKE on a naming convention, not an
--     enumerated list of endpoint strings — see the comment below on what
--     happens if that convention is ever broken.
--   'iterate' — everything else: every Claude compile (vendor='anthropic':
--     full-script and per-scene compiles, Apply/Split), and every fal
--     reference-frame image generation (vendor='fal', nano-banana /
--     nano-banana/edit — web/lib/fal.ts's modelForImageArgs). These are
--     exactly docs/architecture.md's "cheap iteration": compile $0.04-0.12,
--     each ref frame $0.02, apply/split $0.01, done repeatedly.
--
-- The CASE below has an ELSE, not a bare WHEN with an implicit NULL branch —
-- deliberately, so every row lands in exactly one bucket. A CASE with no
-- ELSE would send an unmatched row to NULL, which a `filter (where ...)`
-- silently drops from BOTH buckets rather than erroring — exactly the kind
-- of quiet under-report 0026_cost_aggregates.sql's header (and this
-- migration's own test suite, see lib/spend-categories.test.ts's
-- categorizeRun pinning tests) exists to make impossible instead of merely
-- unlikely. Concretely: today's three video endpoints all contain
-- "image-to-video", but if a future model's endpoint does NOT, that model's
-- runs would fall through the "not video" branch into 'iterate' — visibly
-- wrong (a video render undercounted as cheap iteration) rather than
-- invisibly dropped. Whoever adds a fourth video model must update this
-- CASE in the same commit, the same "keep in sync" burden AGENTS.md already
-- documents for pricing (web/lib/models.ts vs worker/internal/fal/models.go).
--
-- ---------------------------------------------------------------------------
-- Why total_usd = iterate_usd + render_usd is guaranteed, not merely tested
-- ---------------------------------------------------------------------------
-- Both functions below compute total_usd as an UNCONDITIONAL sum(cost_usd)
-- over the exact same WHERE clause spend_total_usd (0026_cost_aggregates.sql)
-- uses — not as iterate_usd + render_usd added back together after the
-- fact. iterate_usd/render_usd are `sum(cost_usd) filter (where <predicate>)`
-- / `filter (where not <predicate>)` over that same row set: a FILTER never
-- excludes a row from the underlying scan the way a GROUP BY on a
-- CASE-that-can-be-NULL would, so there is no code path in which a row
-- counted in total_usd is missing from both buckets. This is what makes
-- "the category split sums to the same total /spend already reports" true
-- BY CONSTRUCTION for spend_category_totals specifically (same table, same
-- predicate, same unconditional sum spend_total_usd already computes) —
-- see lib/spend-categories.test.ts for what IS tested here (categorizeRun's
-- TypeScript mirror of the CASE below, pinned against the actual vendor/
-- model strings this codebase writes) and what is not (the live SQL itself
-- — no test in this suite runs against a database; see db-aggregates.
-- test.ts's own header for that standing limitation).
--
-- ---------------------------------------------------------------------------
-- Aggregated in SQL, one bounded query — same reasoning as every function
-- in 0026/0031/0035
-- ---------------------------------------------------------------------------
-- Both functions are plain aggregate queries with no GROUP BY (spend_
-- category_totals) or a GROUP BY over the whole table (spend_category_
-- totals_by_user), never a fetch-then-reduce in application code.
-- PostgREST's max_rows = 1000 (supabase/config.toml) is exactly the ceiling
-- 0026_cost_aggregates.sql's header warns never to risk on a team-wide
-- dollar sum, and lib/spend.ts's own file header cites that same episode as
-- the standing reason this schema never fetch-and-reduces. SUM()/FILTER in
-- Postgres has no equivalent row cap to silently cross.
--
-- spend_category_totals_by_user joins runs -> projects directly via
-- runs.project_id (0030_runs_project_id.sql), the SAME join user_spend_usd
-- (0031_account_allowances.sql) and RLS's runs_select policy use — NOT the
-- runs -> scenes -> projects join spend_totals_by_user (0026) still uses,
-- which drops every scene-less run (0030's header: every image generation
-- and Claude compile this codebase runs has no scene_id). Building this
-- feature's per-user breakdown on top of that join would under-count the
-- exact "iterate" category runs (compiles, reference frames) most likely to
-- be scene-less in the first place — the opposite of what a feature meant
-- to surface iteration spend should do. web/app/(app)/spend/page.tsx uses
-- this function for the Per-user totals table instead of spend_totals_by_
-- user going forward, which also fixes that pre-existing under-count for
-- every /spend reader, not just this feature's own columns.
-- =============================================================================

create or replace function spend_category_totals(from_ts timestamptz, to_ts timestamptz)
returns table(iterate_usd numeric, render_usd numeric, total_usd numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(sum(r.cost_usd) filter (
      where not (r.vendor = 'fal' and r.model like '%image-to-video%')
    ), 0) as iterate_usd,
    coalesce(sum(r.cost_usd) filter (
      where r.vendor = 'fal' and r.model like '%image-to-video%'
    ), 0) as render_usd,
    coalesce(sum(r.cost_usd), 0) as total_usd
  from runs r
  where r.created_at >= from_ts and r.created_at < to_ts;
$$;

comment on function spend_category_totals is
  'Team-wide iterate-vs-render split for runs created in [from_ts, to_ts) — see this migration''s '
  'header for the category rule and why total_usd is guaranteed to equal iterate_usd + render_usd '
  '(and to equal spend_total_usd''s own total for the same range). Backs /spend''s breakdown tile.';

create or replace function spend_category_totals_by_user(from_ts timestamptz, to_ts timestamptz)
returns table(user_id uuid, email text, iterate_usd numeric, render_usd numeric, total_usd numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select
    p.user_id,
    prof.email,
    coalesce(sum(r.cost_usd) filter (
      where not (r.vendor = 'fal' and r.model like '%image-to-video%')
    ), 0) as iterate_usd,
    coalesce(sum(r.cost_usd) filter (
      where r.vendor = 'fal' and r.model like '%image-to-video%'
    ), 0) as render_usd,
    coalesce(sum(r.cost_usd), 0) as total_usd
  from runs r
  join projects p on p.id = r.project_id
  left join profiles prof on prof.id = p.user_id
  where r.created_at >= from_ts and r.created_at < to_ts
  group by p.user_id, prof.email
  order by total_usd desc;
$$;

comment on function spend_category_totals_by_user is
  'Per-user iterate-vs-render split for runs created in [from_ts, to_ts) — see this migration''s '
  'header for why this joins runs -> projects directly (matching user_spend_usd and RLS''s own '
  'runs_select) rather than reusing spend_totals_by_user''s runs -> scenes -> projects join, which '
  'drops scene-less runs. Answers "is this editor burning money exploring, or producing ads" — the '
  'question a bare total cannot. Backs /spend''s Per-user totals table.';

-- No new grants needed — 0007_grants.sql's `alter default privileges ...
-- grant execute on functions to authenticated` already covers anything this
-- migration's role creates, the same fact every migration since 0026 has
-- relied on.
-- =============================================================================
