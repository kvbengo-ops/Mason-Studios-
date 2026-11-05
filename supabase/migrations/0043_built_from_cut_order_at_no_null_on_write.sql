-- =============================================================================
-- assets.built_from_cut_order_at — stop overloading null with two
-- incompatible meanings. No column/type change: this is a comment-only
-- migration documenting a WORKER-SIDE semantics change, plus a note on the
-- one pre-existing row null already covers.
-- =============================================================================
-- The bug, caught live in production on project
-- 647739b6-f3ec-4910-96ce-bd9f1114a4ce (see this repo's history around
-- 0042_final_built_from_cut_order.sql and commit 85e35a6): 0042 stamped
-- assets.built_from_cut_order_at with whatever SceneClipsForProject read out
-- of projects.cut_order_updated_at, which is null for any project that had
-- never been explicitly reordered at the moment the clips were read. 0042's
-- getCutStatus (web/actions/deliver.ts) then treated that null exactly like
-- the OTHER null case it needs to handle — "this final predates the
-- column entirely" — as "current". Those two are not the same fact:
--
--   09:56:36  reconcile ingests the last render — every scene terminal
--   ~09:56:40 assemble loop reads clips + cut_order_updated_at -> NULL
--   09:58:28  operator reorders the clips   cut_order_updated_at = 09:58:28
--   09:58:59  final written                 built_from_cut_order_at = NULL
--
-- The worker was correct: at read time there truly was no reorder to stamp.
-- But "no reorder yet" and "predates this column" both collapsed to the
-- same null, and getCutStatus can't tell them apart — so a reorder landing
-- after the read (the general form of the race 0042 was already trying to
-- close, just the sub-case that starts from null instead of a real
-- timestamp) is silently reported as "current".
--
-- The fix ships in the worker, not the schema: SceneClipsForProject
-- (worker/internal/store/store.go) now reads
-- `COALESCE(p.cut_order_updated_at, now())` instead of
-- `p.cut_order_updated_at` — same query as the clips, so it's still one
-- consistent snapshot, but now() (Postgres's statement timestamp, not the
-- worker's clock — see that function's updated doc comment for why that
-- matters) fills in the honest "as of this read, no reorder existed"
-- instant instead of leaving it null. A project that has genuinely never
-- been reordered now gets stamped with the clip-read time; a project that
-- has been reordered still gets that reorder's own timestamp, unchanged.
--
-- With that change, every `final` asset written from this point forward
-- gets a real, non-null built_from_cut_order_at, and getCutStatus
-- (web/actions/deliver.ts) can drop the "cut_order_updated_at is null"
-- special case entirely and compare unconditionally:
--
--   stale  <=>  projects.cut_order_updated_at > assets.built_from_cut_order_at
--
-- That is the general form of the fix: it catches ANY reorder landing
-- between the clip read and the final write, not just the specific
-- never-reordered-yet case this bug happened to hit.
--
-- No column/type change needed. assets.built_from_cut_order_at was already
-- a nullable timestamptz (0042); it stays exactly that, because null still
-- has one legitimate meaning left: "this final predates
-- 0042_final_built_from_cut_order.sql and was never stamped at all" —
-- getCutStatus keeps that one null branch, and ONLY that one.
--
-- The one existing row: as of this writing there is exactly one `final`
-- asset in production and its built_from_cut_order_at is null (it was
-- written before 0042 shipped its stamping). This migration does NOT
-- backfill it — there is no honest value to backfill. The clip-read time
-- that row was actually built from was never recorded anywhere (0042 had
-- not shipped yet), so writing anything into it now would be inventing
-- data, not recovering it. It stays null and keeps reading as "current"
-- under getCutStatus's surviving legacy-null branch, exactly like every
-- other pre-0042 final would have.
-- =============================================================================
comment on column assets.built_from_cut_order_at is
  'For kind=''final'' only: the projects.cut_order_updated_at value the worker read in the same '
  'query as the clips (worker/internal/store/store.go''s SceneClipsForProject), COALESCEd with '
  'the same query''s now() when no reorder had happened yet — see 0043''s header. NOT when this '
  'row was inserted (see assets.created_at) and not a live/updated value, a one-time snapshot of '
  'the input the concat was built from. getCutStatus (web/actions/deliver.ts) compares it '
  'unconditionally against projects.cut_order_updated_at: stale iff the project''s value is '
  'strictly newer. Null ONLY for finals written before 0042_final_built_from_cut_order.sql '
  'shipped (there is exactly one such row, and it is not and cannot be backfilled — see 0043''s '
  'header); getCutStatus treats that legacy null as "current", not any newly-written row, which '
  'is never null after 0043.';
-- =============================================================================
