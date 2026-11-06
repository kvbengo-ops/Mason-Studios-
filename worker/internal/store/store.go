// Package store is the worker's data layer over Postgres (pgxpool).
//
// OWNERSHIP CONTRACT (scenes.status) — see docs/architecture.md § "The
// contract" and supabase/migrations/0001_init.sql.
//
//	web  writes scenes.status: draft -> frame_ready -> queued
//	go   writes scenes.status: queued -> rendering -> done | failed
//
// The worker (this package) is the ONLY thing that may write the values
// 'rendering', 'done', or 'failed' to scenes.status. It must NEVER write
// 'draft' or 'frame_ready' — that half of the contract belongs to the web
// app. Every method here that transitions status must respect this split.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned by lookup methods when no matching row exists.
var ErrNotFound = errors.New("store: not found")

// Scene mirrors the scenes table. Nullable columns use pointer types.
type Scene struct {
	ID            string
	ProjectID     string
	Idx           int
	ScriptLine    *string
	VideoPrompt   *string
	IsTalkingHead bool
	DurationS     float64
	Status        string
	// KieTaskID is the submitted-render's vendor request id — kie.ai's
	// taskId today (kie is the only video vendor; fal.ai is decommissioned).
	// The column and this field are named for the vendor that existed when
	// 0001_init.sql was written and are REUSED rather than renamed now that
	// a second vendor once existed and was later removed again — see
	// supabase/migrations/0050_runs_fal_request_id.sql's own "non-fal
	// vendors" carve-out on the runs-table twin of this column, which
	// anticipated exactly this. No migration adds a kie-specific column: it
	// is one opaque per-attempt vendor id, and runs.vendor (not this column,
	// always kie.Vendor today) is what says which vendor it belongs to.
	KieTaskID       *string
	SubmittedAt     *time.Time
	RefFrameAssetID *string
	// AIGeneratedPrompt is scenes.ai_generated_prompt (0072): what Claude
	// wrote from VideoPrompt with "@name" tags replaced by prose, and THE
	// ONE THE VENDOR MUST BE SENT when it is set. Null means the operator
	// never pressed Refine, and dispatch.promptForScene falls back to
	// VideoPrompt exactly as before 0072. Kept alongside VideoPrompt rather
	// than overwriting it so a wrong clip can be traced to either the
	// operator's writing or Claude's refinement of it, and so the
	// operator's tags survive for retargeting — see 0072's own comment.
	AIGeneratedPrompt *string
	// RefFrameCategory and RefFrameDescription are 0071's snapshot of what
	// the reference frame DEPICTS, taken from the element it was copied from
	// at scene-creation time. Both null for a direct upload, for an element
	// saved without a description, and for every scene predating 0071.
	//
	// They exist because loop.referenceDeclaration has to tell Seedance what
	// "@image1" is, and the worker otherwise sees only a storage key —
	// generateClip COPIES an element's image rather than pointing at it, so
	// there is no join back to elements to make. Snapshot, not join, and
	// deliberately: see 0071's own header.
	// ProjectKind is projects.kind (0064): 'scripted' or 'clip'. Read here so
	// the dispatcher can tell WHICH ROUTE a scene came from, which is not
	// derivable from the scene row — both routes produce scenes with a
	// reference and a video prompt.
	//
	// The two want different prompt treatment: /ugc ('clip') is one
	// operator-written prompt with "@tag" references, while the scripted
	// route compiles its prompts against a template that already handles
	// composition. Injecting a reference declaration into a scripted render
	// would change every scene that pipeline produces, for no benefit it
	// asked for.
	ProjectKind string
	// RenderSettings is the EFFECTIVE render settings for this scene:
	// projects.render_settings merged with this scene's own
	// scenes.render_settings_override (0045_scene_render_settings_override.sql),
	// carried on the scene rather than fetched separately because every
	// consumer (dispatch, reconcile, webhook ingest) needs it at exactly the
	// moment it has a Scene and nothing else. It is the raw jsonb — the
	// columns deliberately have no CHECK constraint, so interpreting it is
	// kie.ParseRenderSettings's job, not this layer's.
	//
	// The merge is `p.render_settings || coalesce(s.render_settings_override,
	// '{}'::jsonb)` and is done in SQL, in every query that populates this
	// field, precisely so that nothing above this line has to know the
	// override exists: one []byte arrives, one ParseRenderSettings call reads
	// it, exactly as before 0045. jsonb's `||` is a shallow right-wins merge,
	// so the override wins per key and any key it omits still inherits the
	// project's live value. A scene with no override (the normal case, and
	// every row predating 0045) merges with '{}' and is bit-for-bit what it
	// was.
	RenderSettings []byte
}

// Asset mirrors the assets table.
type Asset struct {
	ID         string
	ProjectID  string
	SceneID    *string
	Kind       string
	StorageKey string
	DurationS  *float64
	Bytes      *int64
	// BuiltFromCutOrderAt is only meaningful for Kind == "final": the cut
	// order timestamp read alongside the clips this asset was built from
	// (SceneClipsForProject — COALESCE(cut_order_updated_at, now()), so
	// this is never nil for a final the worker writes going forward),
	// carried through to InsertFinalAsset. See
	// 0042_final_built_from_cut_order.sql for why this has to be a value
	// read in the SAME query as the clips rather than a second, separate
	// read, and 0043_built_from_cut_order_at_no_null_on_write.sql for why
	// it's no longer the bare column value. Nil for every other kind, and
	// for the handful of finals written before 0042 shipped, which were
	// never stamped at all.
	BuiltFromCutOrderAt *time.Time
}

// Run mirrors the runs table — one row per render attempt, not per
// success.
type Run struct {
	ID string
	// ProjectID attributes this run's cost to a project (and, transitively,
	// to whoever owns it) independent of SceneID. Added by
	// 0030_runs_project_id.sql alongside SceneID rather than instead of it:
	// every video render still has a scene, but the web app's image and
	// compile calls (character reference, composite, per-scene reference
	// frames regenerated in bulk, Claude compile) include project-level
	// ones with no scene to hang off — a full-script compile prices the
	// whole project, not one scene. Cost aggregation (getDailySpend,
	// getGlobalDailySpend, project_cost_totals, spend_totals_by_user — see
	// that migration's header) reads ProjectID directly instead of joining
	// through scenes, so a run with SceneID == nil is still counted instead
	// of silently falling out of every scene-keyed query. Required on every
	// insert this package makes (MarkDone auto-fills it from asset.ProjectID
	// when left zero, MarkFailed's callers set it from the scene they
	// already have in hand) — never left blank on purpose the way SceneID
	// can be.
	ProjectID string
	SceneID   *string
	// KieTaskID names the vendor's queue/task id for this specific
	// attempt — fal's request_id or, since Vendor may now be "kie", kie.ai's
	// taskId (see store.Scene.KieTaskID's doc comment for why this
	// fal-named column is reused rather than duplicated per vendor). It must
	// be captured by the caller while observing the outcome, never
	// looked up later from Scene.KieTaskID: that scene column represents
	// only the current attempt and can be cleared or overwritten on retry.
	// Nil is legitimate when no trustworthy id exists (pre-submission and
	// billing-unknown failures, and rows predating 0050).
	KieTaskID *string
	Vendor    string
	Model     string
	CostUSD   *float64
	LatencyMS *int
	// InferenceMS is left nil on every kie render — see kie.Result's own
	// doc comment (worker/internal/kie/types.go) for why kie has no
	// equivalent of fal.ai's old metrics.inference_time. Distinct from
	// LatencyMS, which is this worker's own submit-to-detection time and is
	// dominated by reconcile's polling cadence, not vendor work.
	InferenceMS *int
	Error       *string
}

// BillingUnknownPrefix marks a run whose vendor charge cannot be decided
// either way: the vendor may or may not have accepted and billed the submission
// before a usable task id was received (kie.ErrSubmissionOutcomeUnknown). Such a run
// keeps CostUSD nil — writing an estimate would fabricate a charge it may
// never have made — so the prefix on Error is the only thing that separates
// it from an ordinary unbilled failure. It exists as a constant because the
// operational alert is a real query: select ... from runs where error like
// 'billing-unknown:%' and cost_usd is null.
const BillingUnknownPrefix = "billing-unknown: "

// Store is the worker's handle on Postgres. All methods are safe for
// concurrent use (pgxpool manages its own connection pool).
type Store struct {
	pool *pgxpool.Pool
	// dev is this worker's own MODE (config.Config.IsDev()), fixed at
	// construction. ClaimQueuedScenes and StaleRendering both
	// filter on `scenes.dev = dev` — see New's doc comment for why this is a
	// constructor argument rather than a per-call one.
	dev bool
}

// New connects to databaseURL and returns a ready Store scoped to dev — this
// worker's own MODE (config.Config.IsDev()). It does not ping; call Ping
// separately (e.g. at startup and in the health check) to verify
// connectivity.
//
// dev is fixed here, not threaded as a parameter on
// ClaimQueuedScenes/StaleRendering, because a worker process's mode never
// changes mid-run (config.Config.Mode is read once at startup) — every
// caller of those three methods already has this exact Store in hand and
// would otherwise have to keep re-deriving the same value from cfg.IsDev()
// at every call site. This is also the smaller change: the loop.Store
// interface (internal/loop/deps.go) needs no signature update.
//
// dev is the scenes.dev filter these three methods add
// (0063_scenes_dev_flag.sql): a worker constructed with dev=true claims and
// reconciles ONLY rows written by a MODE=development web app; dev=false
// claims and reconciles ONLY rows a MODE=production web app wrote. This is
// the fix for the incident web/lib/mode.ts's header describes — a mock flag
// set on one process cannot stop a DIFFERENT process from claiming the same
// row; a column both processes read off the SAME row can.
func New(ctx context.Context, databaseURL string, dev bool) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("store: connect: %w", err)
	}
	return &Store{pool: pool, dev: dev}, nil
}

// Close releases all pooled connections.
func (s *Store) Close() {
	s.pool.Close()
}

// Ping verifies connectivity to Postgres.
func (s *Store) Ping(ctx context.Context) error {
	if err := s.pool.Ping(ctx); err != nil {
		return fmt.Errorf("store: ping: %w", err)
	}
	return nil
}

// NotifyWeeklyCreditRenewal emits this week's notice for active accounts.
// The database function is idempotent per user and Manila week, so the
// production worker can retry it after restarts without duplicate notices.
func (s *Store) NotifyWeeklyCreditRenewal(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `select public.notify_weekly_credit_renewal()`); err != nil {
		return fmt.Errorf("store: notify weekly credit renewal: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

// ClaimQueuedScenes atomically claims queued scenes up to the free slots
// left under ceiling — the global render limit, config.RenderConcurrency —
// round-robin across users (see docs/architecture.md § "Dispatch — the
// queue"), and marks them 'rendering' in the same statement so that two
// worker instances — or a restart racing itself — cannot double-submit the
// same scene to kie.
//
// The round-robin shape: scenes are ranked within each owner by age, then
// taken in rank order, so the batch interleaves users while still filling
// every free slot. One editor queueing hundreds of clips cannot starve the
// others, and a lone active editor still gets the whole batch.
//
// NOTE: this claims scenes into 'rendering' before a kie_task_id is
// known. Callers MUST follow up with MarkRendering (or MarkFailed, on
// immediate submission error) to attach the kie_task_id / roll back the
// claim. Returned scenes have Status == "rendering" and KieTaskID ==
// nil.
//
// Filtered to `scenes.dev = s.dev` in both the candidate CTE and the
// UPDATE's re-check (see New's doc comment for what s.dev is and why it
// lives on the Store rather than as a parameter here): this is the half of
// the MODE contract that actually closes the race web/lib/mode.ts's header
// describes. Without it, a local development worker and the deployed
// production worker polling the SAME queued scene is a coin flip decided by
// nothing more than which process's 30s timer fires first; with it, a
// development worker's candidate CTE never even selects a row a production
// web app wrote, so there is no race left to lose.
func (s *Store) ClaimQueuedScenes(ctx context.Context, ceiling int) ([]Scene, error) {
	if ceiling <= 0 {
		return nil, nil
	}

	// Fairness comes from the row_number partition, not DISTINCT ON. DISTINCT ON
	// yields at most one scene per user per call, so a single editor with thirty
	// queued clips would drip out one every thirty seconds — fifteen minutes just
	// to submit. Ranking within each user and then ordering by that rank
	// interleaves users while still filling every free slot: with one active user
	// the batch is all theirs, with three it round-robins across them.
	//
	// submitted_at is stamped at claim time, not at submission. The reconcile loop
	// finds stuck work with `submitted_at < now() - interval`, and NULL never
	// satisfies that comparison — so a scene claimed by a process that died before
	// calling fal would sit in 'rendering' forever, invisible to the very loop that
	// exists to catch it. The dispatch caller overwrites this on real submission.
	//
	// The status re-check in the UPDATE is what makes concurrent dispatchers safe:
	// two instances may select the same candidate, but only the first to reach the
	// row under lock still sees 'queued', so the second claims nothing and cannot
	// double-submit a paid render.
	const q = `
WITH ranked AS (
    SELECT s.id,
           s.created_at,
           row_number() OVER (PARTITION BY p.user_id ORDER BY s.created_at) AS rn
    FROM scenes s
    JOIN projects p ON p.id = s.project_id
    WHERE s.status = 'queued'
      AND s.dev = $2
),
candidates AS (
    SELECT id FROM ranked
    -- id is a tiebreaker, not an ordering preference: (rn, created_at) alone
    -- is not a total order, and two dispatchers that resolve a tie differently
    -- select DIFFERENT candidate sets. That is the one way the ceiling below
    -- can still be overshot — each claims rows the other did not, so neither
    -- loses anything to the status re-check. The tie needs two users' k-th
    -- scenes to share a created_at to the microsecond, which is why this has
    -- never been observed; it costs one column to make it impossible instead
    -- of unlikely.
    ORDER BY rn, created_at, id
    -- The ceiling is subtracted here, inside the claiming statement, rather
    -- than read by the caller first. As two statements (count, then claim)
    -- there was nothing held between them: two worker instances could each
    -- read rendering = 0 and each claim a full batch, overshooting the global
    -- limit by a factor of however many replicas are running. As one
    -- statement, the count and the candidate set share a snapshot, so a
    -- concurrent claimer either sees this one's rows as rendering (and gets
    -- fewer slots) or picks the same candidates and loses them all to the
    -- status re-check below.
    --
    -- The count carries the same dev = $2 filter as the candidate CTE, for
    -- the reason the CountRendering it replaced was scoped that way: without
    -- it a development worker's ceiling is eaten by production renders it can
    -- never see or finish, and vice versa — two workers sharing one
    -- concurrency count for work neither can dispatch for the other.
    LIMIT greatest(0, $1 - (SELECT count(*) FROM scenes WHERE status = 'rendering' AND dev = $2))
)
UPDATE scenes
SET status = 'rendering', submitted_at = now()
-- projects is joined into the UPDATE's FROM purely to return
-- render_settings alongside the claimed row: the resolution and fps the
-- submission needs live on the project, and a second round-trip per scene
-- to fetch them would race a settings write against the claim.
--
-- The jsonb merge in the RETURNING clause is 0045's per-scene model override
-- (scenes.render_settings_override): a PARTIAL settings object, so the
-- project's blob goes first and the scene's wins per key, with absent keys
-- falling through to the project. Merged here rather than in Go so the
-- worker still receives one settings blob per scene and parses it in one
-- place (see Scene.RenderSettings). This is the submission path — whatever
-- comes out of here decides which fal endpoint gets billed for this scene,
-- so it is also what the web app's spend guard must price against
-- (mergeRenderSettings, web/lib/models.ts).
FROM candidates, projects settings
WHERE scenes.id = candidates.id
  AND settings.id = scenes.project_id
  AND scenes.status = 'queued'
  AND scenes.dev = $2
RETURNING scenes.id, scenes.project_id, scenes.idx, scenes.script_line,
          scenes.video_prompt, scenes.is_talking_head, scenes.duration_s,
          scenes.status, scenes.kie_task_id, scenes.submitted_at,
          scenes.ref_frame_asset_id, scenes.ai_generated_prompt,
          settings.kind,
          settings.render_settings || coalesce(scenes.render_settings_override, '{}'::jsonb)`

	rows, err := s.pool.Query(ctx, q, ceiling, s.dev)
	if err != nil {
		return nil, fmt.Errorf("store: claim queued scenes: %w", err)
	}
	defer rows.Close()

	scenes, err := scanScenes(rows)
	if err != nil {
		return nil, fmt.Errorf("store: claim queued scenes: %w", err)
	}
	return scenes, nil
}

// MarkRendering attaches kieTaskID and submitted_at to a scene already
// claimed (status='rendering') by ClaimQueuedScenes.
func (s *Store) MarkRendering(ctx context.Context, sceneID, kieTaskID string) error {
	tag, err := s.pool.Exec(ctx, `
UPDATE scenes
SET kie_task_id = $2, submitted_at = now()
WHERE id = $1 AND status = 'rendering'`, sceneID, kieTaskID)
	if err != nil {
		return fmt.Errorf("store: mark rendering %s: %w", sceneID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("store: mark rendering %s: %w", sceneID, ErrNotFound)
	}
	return nil
}

// ---------------------------------------------------------------------------
// webhook
// ---------------------------------------------------------------------------

// SceneByKieTaskID looks up the scene a fal webhook callback refers to.
// Returns ErrNotFound if no scene has this kie_task_id.
func (s *Store) SceneByKieTaskID(ctx context.Context, requestID string) (*Scene, error) {
	row := s.pool.QueryRow(ctx, `
SELECT s.id, s.project_id, s.idx, s.script_line, s.video_prompt, s.is_talking_head,
       s.duration_s, s.status, s.kie_task_id, s.submitted_at, s.ref_frame_asset_id,
       s.ai_generated_prompt,
       p.kind,
       -- Same 0045 merge as ClaimQueuedScenes, and required here for the
       -- same reason: the webhook handler resolves the fal endpoint from
       -- these settings (a mismatch 404s the result fetch for a render that
       -- ran perfectly well) and prices runs.cost_usd from them on failure.
       -- If this read fell back to the raw project settings, a scene
       -- submitted under an override would be polled at, and billed at, a
       -- model it never ran on.
       p.render_settings || coalesce(s.render_settings_override, '{}'::jsonb)
FROM scenes s
JOIN projects p ON p.id = s.project_id
WHERE s.kie_task_id = $1`, requestID)

	scene, err := scanScene(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("store: scene by fal request id %s: %w", requestID, ErrNotFound)
		}
		return nil, fmt.Errorf("store: scene by fal request id %s: %w", requestID, err)
	}
	return scene, nil
}

// MarkDone records a successful render in a single transaction: insert the
// asset, insert the run, and flip the scene to 'done'. A partial write here
// means a paid-for clip the UI never shows, so all three happen atomically
// or not at all.
//
// asset.SceneID and run.SceneID are set to sceneID by this method if left
// nil; callers may leave them zero-valued. asset.ProjectID must be set by
// the caller (it is not inferrable from sceneID without an extra query the
// caller likely already has cheaply available).
//
// Idempotent by design at the call site, not here: callers (the webhook
// handler and the reconcile loop) MUST check the scene's current status
// before calling MarkDone and skip if it is already 'done' — fal retries
// webhook delivery on non-200, and this guard is what prevents duplicate
// assets / double-counted cost. This method itself performs a single
// update guarded by `WHERE status = 'rendering'` as a defensive backstop,
// returning ErrNotFound (no rows affected) if the scene is not currently
// 'rendering' (already 'done', already 'failed', or does not exist).
//
// This is 6ae720b's MarkFailed fix, mirrored: that commit tightened
// MarkFailed's guard from `!= 'done'` to `= 'rendering'` and explicitly
// left this method out of scope. The hole here was worse than MarkFailed's
// was — a scene the webhook handler or the reconcile loop had already
// marked 'failed' (see MarkFailed's own doc comment on how routinely both
// race the same scene) could still be flipped to 'done' by a late-arriving
// webhook or a delayed reconcile pass under the old `!= 'done'` guard,
// because 'failed' satisfies `!= 'done'` just as well as 'rendering' does.
// That double-writes: a second `runs` row billing the same render again,
// AND a phantom `assets` row for a clip the operator was already told had
// failed — worse than MarkFailed's plain double-charge, since the asset
// side has no other guard anywhere to catch it.
//
// Callers only ever reach this method with a scene genuinely still
// 'rendering': ClaimQueuedScenes puts a scene into 'rendering' before
// kie_task_id exists, MarkRendering is the only thing that ever sets
// kie_task_id (and itself requires status='rendering' to do it), and
// both callers of this method — internal/http's webhook handler and
// internal/loop/reconcile — look the scene up by kie_task_id and only
// proceed past their own 'done' check. Neither has a legitimate path to a
// 'failed' or 'queued' scene; a 'failed' scene reaching here is exactly the
// lost-race case above, not a completion this method should ever honor.
func (s *Store) MarkDone(ctx context.Context, sceneID string, asset Asset, run Run) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("store: mark done %s: begin tx: %w", sceneID, err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op if committed

	if asset.SceneID == nil {
		asset.SceneID = &sceneID
	}
	if run.SceneID == nil {
		run.SceneID = &sceneID
	}
	// asset.ProjectID is already a required caller input (see this
	// method's doc comment) and is, for every real video render, the exact
	// same project the run belongs to — so it's the sane default rather
	// than making every MarkDone call site repeat a value it already
	// passed in once. See Run.ProjectID's doc comment.
	if run.ProjectID == "" {
		run.ProjectID = asset.ProjectID
	}

	var assetID string
	err = tx.QueryRow(ctx, `
INSERT INTO assets (project_id, scene_id, kind, storage_key, duration_s, bytes)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id`,
		asset.ProjectID, asset.SceneID, asset.Kind, asset.StorageKey, asset.DurationS, asset.Bytes,
	).Scan(&assetID)
	if err != nil {
		return fmt.Errorf("store: mark done %s: insert asset: %w", sceneID, err)
	}

	_, err = tx.Exec(ctx, `
INSERT INTO runs (project_id, scene_id, kie_task_id, vendor, model, cost_usd, latency_ms, inference_ms, error)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		run.ProjectID, run.SceneID, run.KieTaskID, run.Vendor, run.Model, run.CostUSD, run.LatencyMS, run.InferenceMS, run.Error,
	)
	if err != nil {
		return fmt.Errorf("store: mark done %s: insert run: %w", sceneID, err)
	}

	tag, err := tx.Exec(ctx, `
UPDATE scenes SET status = 'done' WHERE id = $1 AND status = 'rendering'`, sceneID)
	if err != nil {
		return fmt.Errorf("store: mark done %s: update scene: %w", sceneID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("store: mark done %s: %w", sceneID, ErrNotFound)
	}
	// The Video tab reads takes through scene_versions.clip_asset_id.
	if _, err := tx.Exec(ctx, `
UPDATE scene_versions v SET clip_asset_id = $2
FROM scenes s
WHERE s.id = $1 AND v.id = s.active_version_id AND v.scene_id = s.id`, sceneID, assetID); err != nil {
		return fmt.Errorf("store: mark done %s: link clip to version: %w", sceneID, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("store: mark done %s: commit: %w", sceneID, err)
	}
	return nil
}

// MarkFailed records a failed render attempt in a single transaction:
// insert a `runs` row and flip the scene to 'failed' — mirroring MarkDone's
// shape on purpose. A failed render is frequently not free: fal has
// accepted-and-billed plenty of jobs that go on to fail mid-generation, get
// lost between "submitted" and "webhook delivered", or wedge until
// reconcile gives up on them — see this method's callers (dispatch.go,
// reconcile.go, webhook.go) for the exact cases. Before this method wrote
// nothing but scenes.status, every one of those was a $0 line item to both
// the daily spend caps and /spend, in precisely the retry-heavy case
// AGENTS.md names as where the budget actually goes.
//
// No new column for "this failure cost money" vs. "this failure was free":
// runs.cost_usd and runs.error already say everything a reader needs. A
// successful run has error == nil and a real cost_usd; a failed run always
// has error set, and cost_usd set to whatever this attempt is known to have
// cost fal — nil when the attempt never got far enough for fal to have
// billed anything. `WHERE error IS NOT NULL` is how a reader (or a future
// approval-workflow query) tells a wasted dollar apart from an earned one;
// a dedicated outcome/status column would only restate what error already
// encodes, one more place for the two to drift apart.
//
// run.CostUSD is entirely the caller's call, not this method's: whether fal
// actually charged for a given failure depends on how far the attempt got
// before it died, and only the caller — holding the scene and the specific
// step that just failed — can judge that. Every caller in this codebase
// uses the same bar: scene.KieTaskID set at the moment the failure was
// detected means fal accepted and started the job, which means it was
// billed; nil means fal never got the request (or we have no way to know),
// so CostUSD stays nil rather than guess. An overstated figure here is
// exactly as wrong as a missing one — recording a charge that did not
// happen is not a safer default than recording none.
//
// run.SceneID defaults to sceneID if left nil, same as MarkDone.
// run.ProjectID has no such default (unlike MarkDone, there is no `asset`
// argument to fall back to here) — every caller must set it from the scene
// it already has in hand; see Run.ProjectID's doc comment for why it must
// never be left blank.
//
// Guarded by `WHERE status = 'rendering'`: a scene must still be in flight
// for a failure to be recordable against it, and the first caller to commit
// takes it out of 'rendering'. Two callers independently observe the same
// doomed render as a matter of course — the webhook handler and the
// reconcile loop race whenever a late webhook lands on a scene reconcile
// has already given up on — so every caller after the first gets ErrNotFound
// and rolls back. The guard covers the whole transaction, run insert
// included, which is the entire point: under the older `!= 'done'` guard the
// second caller still passed (a 'failed' scene is not 'done'), inserting a
// duplicate runs row and billing the same wasted dollar twice against the
// daily spend caps and /spend. Scenes that already finished successfully
// remain excluded as before — a late failure signal must never regress a
// 'done' scene, and the real cost was already written by the MarkDone that
// got there first.
func (s *Store) MarkFailed(ctx context.Context, sceneID string, run Run) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("store: mark failed %s: begin tx: %w", sceneID, err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op if committed

	if run.SceneID == nil {
		run.SceneID = &sceneID
	}

	_, err = tx.Exec(ctx, `
INSERT INTO runs (project_id, scene_id, kie_task_id, vendor, model, cost_usd, latency_ms, inference_ms, error)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		run.ProjectID, run.SceneID, run.KieTaskID, run.Vendor, run.Model, run.CostUSD, run.LatencyMS, run.InferenceMS, run.Error,
	)
	if err != nil {
		return fmt.Errorf("store: mark failed %s: insert run: %w", sceneID, err)
	}

	tag, err := tx.Exec(ctx, `
UPDATE scenes SET status = 'failed' WHERE id = $1 AND status = 'rendering'`, sceneID)
	if err != nil {
		return fmt.Errorf("store: mark failed %s: update scene: %w", sceneID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("store: mark failed %s: %w", sceneID, ErrNotFound)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("store: mark failed %s: commit: %w", sceneID, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

// StaleRendering returns scenes stuck in 'rendering' whose submitted_at is
// older than olderThan — candidates for the reconcile loop to check
// directly against fal (see docs/architecture.md § "Reconcile").
//
// Filtered to s.dev = s.dev (this Store's own mode) same as
// ClaimQueuedScenes, and for the highest-stakes reason of the
// three: without it, a development worker's reconcile loop would poll fal
// about a production scene's real kie_task_id, get "unknown task id"
// from its own mock client (it never claimed that scene, so it has nothing
// to check the real id against), retry every tick, and after
// ReconcileGiveUpAfter call MarkFailed on a scene that may still be
// genuinely, correctly rendering for a paying customer. Real fal/kie
// inference (~80s) is well under the default staleAfter threshold (45s), so
// this is not a rare race — a development worker running at all alongside a
// production render in flight trips it every time this filter is missing.
func (s *Store) StaleRendering(ctx context.Context, olderThan time.Duration) ([]Scene, error) {
	const q = `
SELECT s.id, s.project_id, s.idx, s.script_line, s.video_prompt, s.is_talking_head,
       s.duration_s, s.status, s.kie_task_id, s.submitted_at, s.ref_frame_asset_id,
       s.ai_generated_prompt,
       p.kind,
       -- Same 0045 merge as ClaimQueuedScenes/SceneByKieTaskID. The
       -- reconcile loop polls fal at model.Endpoint and writes runs.cost_usd
       -- when it gives up on a scene, both resolved from these settings, so
       -- it has to see the same effective model the scene was submitted
       -- with rather than the project's.
       p.render_settings || coalesce(s.render_settings_override, '{}'::jsonb)
FROM scenes s
JOIN projects p ON p.id = s.project_id
WHERE s.status = 'rendering'
  AND s.dev = $2
  AND s.submitted_at < now() - $1::interval`

	rows, err := s.pool.Query(ctx, q, olderThan.String(), s.dev)
	if err != nil {
		return nil, fmt.Errorf("store: stale rendering: %w", err)
	}
	defer rows.Close()

	scenes, err := scanScenes(rows)
	if err != nil {
		return nil, fmt.Errorf("store: stale rendering: %w", err)
	}
	return scenes, nil
}

// RenderingWithTaskPrefix counts this mode's scenes in 'rendering' whose
// persisted task id starts with prefix — byteplus.Router's in-flight count
// (kie.BytePlusTaskPrefix), which caps BytePlus at BYTEPLUS_MAX_INFLIGHT.
func (s *Store) RenderingWithTaskPrefix(ctx context.Context, prefix string) (int, error) {
	const q = `
SELECT count(*)
FROM scenes
WHERE status = 'rendering'
  AND dev = $2
  AND kie_task_id LIKE $1 || '%'`

	var n int64
	if err := s.pool.QueryRow(ctx, q, prefix, s.dev).Scan(&n); err != nil {
		return 0, fmt.Errorf("store: rendering with task prefix: %w", err)
	}
	return int(n), nil
}

// ---------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------

// FinalVersionRecipeEntry is one element of final_versions.recipe: a scene
// and the scene_version that scene contributed to this cut. SceneVersionID
// is nil for a scene whose active version predated 0058's backfill — see
// 0060_final_versions.sql's comment on the recipe column: "a recipe that
// says 'this scene, version unknown' is still truer than one that guesses."
type FinalVersionRecipeEntry struct {
	SceneID        string  `json:"scene_id"`
	SceneVersionID *string `json:"scene_version_id"`
}

// PendingFinalVersion is one claimed, not-yet-built final_versions row —
// the assemble loop's unit of work. Recipe is decoded from the row's jsonb
// and may legitimately be empty (0060's backfill can produce an empty
// recipe for a project with no scenes); see ClipsForRecipe for what the
// assemble loop does with that.
type PendingFinalVersion struct {
	ID        string
	ProjectID string
	N         int
	Recipe    []FinalVersionRecipeEntry
}

// ClaimPendingFinalVersions returns up to limit final_versions rows that
// are asking to be built — built_at, failed_at and claimed_at all NULL,
// oldest first, matching final_versions_pending_idx exactly — whose project
// also
// still satisfies the readiness rule the old ProjectsReadyToAssemble
// enforced: every scene terminal (done or failed), at least one done.
//
// The row IS the request. This replaces ProjectsReadyToAssemble's "NOT
// EXISTS a kind='final' asset" inference, which made deleting the previous
// final the only way to ask for a rebuild — the deletion 0060 exists to
// stop. An operator now INSERTs a row instead.
//
// The project-readiness half is unchanged and still load-bearing, for the
// same reason it was added: a scene sitting at 'frame_ready' mid-correction
// (unfreezeScene, web/actions/brief.ts) is neither queued nor rendering, so
// building now would produce a cut silently missing that scene, with no
// incomplete signal. A row whose project is not ready is simply not claimed
// this pass — it stays pending, and the next tick tries again. It is NOT
// failed: "the operator is still editing" is not a give-up.
//
// CLAIM SAFETY. Two mechanisms, doing two different jobs.
//
// claimed_at is the lease, and it is what makes the claim hold for the
// whole build. It is stamped by the same UPDATE ... RETURNING that reads
// the row, so the lease and the read cannot come apart — there is no window
// in which a row has been handed to a worker but not yet marked taken. This
// is the analogue of ClaimQueuedScenes flipping status to 'rendering' in
// its claim statement; final_versions needed a column of its own because
// built_at would claim the build had finished and failed_at that it broke.
//
// FOR UPDATE ... SKIP LOCKED on the candidate CTE does the narrower job the
// row lock is actually good for: two workers ticking in the SAME instant
// cannot both select the same candidate, so the second takes the next row
// instead of blocking behind the first and finding nothing. It cannot cover
// the build itself, because a row lock dies with the claiming transaction
// and an assemble runs for minutes after it commits — which is precisely
// the gap claimed_at exists to close.
//
// claimed_at IS NULL is in the predicate as well as the stamp, both because
// it is the correctness check and because it is what makes this query use
// final_versions_pending_idx (the partial index is defined over exactly
// these three nulls).
//
// A worker that dies mid-build leaves a stale lease behind, and this pass
// will not pick that row up again. Sweeping those belongs in the reconcile
// loop, on the same reasoning RECONCILE_GIVE_UP_AFTER_MINUTES already
// applies to a render stuck in 'rendering' — it is named here, and in the
// column's own comment in 0060, so it is not discovered by an operator
// wondering why a version never built. It is not implemented yet.
func (s *Store) ClaimPendingFinalVersions(ctx context.Context, limit int) ([]PendingFinalVersion, error) {
	if limit <= 0 {
		return nil, nil
	}

	const q = `
WITH candidates AS (
    SELECT fv.id
    FROM final_versions fv
    WHERE fv.built_at IS NULL
      AND fv.failed_at IS NULL
      AND fv.claimed_at IS NULL
      -- This worker's own MODE. Without it a dev worker claims a production
      -- project's final build and writes a real delivered artifact against
      -- real clips — the same shared-table race ClaimQueuedScenes closes for
      -- renders, one step later. See 0069_final_versions_dev_flag.sql.
      AND fv.dev = $2
      -- Every scene must be terminal (done or failed) — NOT just "not
      -- queued/rendering". A scene at 'draft' or 'frame_ready' is neither,
      -- so a narrower check would let a half-edited project build. See
      -- sceneStatusesReadyToAssemble for the same rule in Go.
      AND NOT EXISTS (
          SELECT 1 FROM scenes s2
          WHERE s2.project_id = fv.project_id AND s2.status NOT IN ('done', 'failed')
      )
      AND EXISTS (
          SELECT 1 FROM scenes s3
          WHERE s3.project_id = fv.project_id AND s3.status = 'done'
      )
    ORDER BY fv.created_at
    LIMIT $1
    FOR UPDATE OF fv SKIP LOCKED
)
UPDATE final_versions
SET claimed_at = now()
FROM candidates
WHERE final_versions.id = candidates.id
  -- Re-checked under the lock, same as the status re-check below: the CTE's
  -- predicate and the UPDATE's must agree or a concurrent mode change could
  -- let a row through.
  AND final_versions.dev = $2
  -- Re-checked under the lock the CTE took, the same way ClaimQueuedScenes
  -- re-checks status = 'queued' in its own UPDATE: two instances may pick
  -- the same candidate, but only the first to reach the row still sees an
  -- unclaimed one, so the second claims nothing rather than double-building.
  AND final_versions.claimed_at IS NULL
RETURNING final_versions.id, final_versions.project_id,
          final_versions.n, final_versions.recipe`

	rows, err := s.pool.Query(ctx, q, limit, s.dev)
	if err != nil {
		return nil, fmt.Errorf("store: claim pending final versions: %w", err)
	}
	defer rows.Close()

	var versions []PendingFinalVersion
	for rows.Next() {
		var v PendingFinalVersion
		var recipeJSON []byte
		if err := rows.Scan(&v.ID, &v.ProjectID, &v.N, &recipeJSON); err != nil {
			return nil, fmt.Errorf("store: claim pending final versions: scan: %w", err)
		}
		// A recipe this worker cannot parse is a defect in whoever wrote the
		// row, not a reason to abandon the whole batch: skip the batch here
		// with a real error rather than silently building the wrong cut from
		// a half-decoded recipe.
		if len(recipeJSON) > 0 {
			if err := json.Unmarshal(recipeJSON, &v.Recipe); err != nil {
				return nil, fmt.Errorf("store: claim pending final versions: decode recipe for %s: %w", v.ID, err)
			}
		}
		versions = append(versions, v)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: claim pending final versions: %w", err)
	}
	return versions, nil
}

// sceneStatusesReadyToAssemble mirrors the scene-status half of
// ClaimPendingFinalVersions' WHERE clause (not the pending-row half, which
// is an orthogonal, per-version concern): ready
// once every status is terminal (done or failed — the only two values a
// scene can end on, see 0001_init.sql's check constraint) and at least one
// is 'done', so there is actually a clip for SceneClipsForProject to
// return (an all-failed project has none, and assembleProject already
// treats that as a no-op — see its len(clips)==0 branch — but there is no
// reason to make the assemble loop wake it up every tick to find that out).
//
// This package has no local Postgres to run the real query against (see
// ../../../docker-compose.yml's header comment: Supabase is hosted, so
// there is nothing to run locally for the database), so this function
// exists purely to pin the WHERE clause's intended semantics somewhere a
// unit test can check them — same motivation as
// internal/loop/reconcile.go's giveUpDeadlinePassed, split out of giveUp
// "purely so it's testable without a live *store.Store". It is NOT called
// by ClaimPendingFinalVersions — that logic runs in Postgres, not Go — so if
// the SQL's NOT IN ('done', 'failed') / status = 'done' conditions ever
// change, this must be kept in sync by hand or the two will drift.
func sceneStatusesReadyToAssemble(statuses []string) bool {
	hasDone := false
	for _, status := range statuses {
		switch status {
		case "done":
			hasDone = true
		case "failed":
			// Terminal — doesn't block, doesn't count toward hasDone.
		default:
			// 'draft', 'frame_ready', 'queued', or 'rendering' — still
			// editable or still in flight. This is the bug this fix closes:
			// a scene sitting at 'frame_ready' (e.g. mid-correction via
			// unfreezeScene, web/actions/brief.ts) is neither 'queued' nor
			// 'rendering', so the old WHERE clause let it through.
			return false
		}
	}
	return hasDone
}

// SceneClipsForProject returns the 'clip' assets for a project's scenes, in
// scene idx order, for the assemble loop to concat, alongside the cut order
// timestamp to stamp the resulting final asset with, AS OF THIS SAME QUERY.
//
// That value is read here — joined onto every clip row — rather than by a
// separate SELECT on projects, deliberately: reading it separately would
// reopen a smaller version of the exact race this is meant to close (see
// 0042_final_built_from_cut_order.sql's header). A reorder that commits
// between "read the clips" and "read cut_order_updated_at" would let the
// stamp claim a cut order newer than what was actually concatenated —
// which is precisely the kind of gap between what was read and what was
// recorded that motivated this fix in the first place. One query means
// the order and the value it is stamped with always come from the same
// consistent snapshot.
//
// The value is COALESCE(p.cut_order_updated_at, now()) — NOT the bare
// column — so a project that has never been explicitly reordered gets
// stamped with the instant this query ran instead of null. Writing null
// there used to mean two different things depending on which of two bugs
// you were looking at: "this final predates the column" (the legitimate
// reading getCutStatus, web/actions/deliver.ts, still needs) and "this
// project had no reorder AT READ TIME" (which a reorder landing seconds
// later, before the final finished writing, could silently falsify — the
// exact bug caught live on project 647739b6-f3ec-4910-96ce-bd9f1114a4ce;
// see 0043_built_from_cut_order_at_no_null_on_write.sql's header for the
// full timeline). now() is Postgres's statement timestamp, not the
// worker's own clock: using time.Now() here instead would reintroduce a
// smaller version of the same bug through clock skew between the worker
// host and the database, so the fallback has to come from the same query
// as the clips, same as cut_order_updated_at itself.
//
// cutOrderUpdatedAt is nil only when there are no clips at all (nothing to
// join against, so COALESCE never runs); callers must not read a nil
// return as "never reordered" any more, but assembleProject already treats
// zero clips as a no-op before ever looking at this return value.
func (s *Store) SceneClipsForProject(ctx context.Context, projectID string) ([]Asset, *time.Time, error) {
	// ONE clip per scene: the one belonging to that scene's ACTIVE version.
	//
	// This used to be a plain "every clip asset in the project", which was
	// correct only because re-rendering deleted the previous clip first.
	// 0058_scene_versions.sql stopped that deletion — a paid-for clip now
	// survives the render that supersedes it — so without this filter a
	// scene re-rendered three times would contribute three clips to the cut.
	//
	// The rule matches web/lib/scene-versions.ts exactly: a clip belongs to
	// the newest version that existed when the clip landed, so the active
	// version's clip is the newest clip at or after that version was opened
	// and before the next version was. A scene with no active version (one
	// that has not rendered since 0058) falls back to its newest clip, which
	// is the pre-0058 behaviour.
	const q = `
SELECT DISTINCT ON (s.idx)
       a.id, a.project_id, a.scene_id, a.kind, a.storage_key, a.duration_s, a.bytes,
       COALESCE(p.cut_order_updated_at, now())
FROM scenes s
JOIN projects p ON p.id = s.project_id
LEFT JOIN scene_versions v ON v.id = s.active_version_id
LEFT JOIN LATERAL (
  SELECT min(v2.created_at) AS next_at
  FROM scene_versions v2
  WHERE v2.scene_id = s.id
    AND v.created_at IS NOT NULL
    AND v2.created_at > v.created_at
) nxt ON true
JOIN assets a ON a.scene_id = s.id AND a.kind = 'clip'
WHERE s.project_id = $1
  AND (
    -- A version that already NAMES its clip wins outright. 0058's backfill
    -- set clip_asset_id on every pre-existing scene, and those v1 rows were
    -- created after the clips they describe — so the time window below would
    -- exclude every clip this project has ever rendered, and the cut would
    -- assemble from nothing. The window is for versions opened by a render,
    -- where the clip genuinely arrives afterwards.
    v.clip_asset_id = a.id
    OR (
      v.clip_asset_id IS NULL
      AND (v.created_at IS NULL OR a.created_at >= v.created_at)
      AND (nxt.next_at IS NULL OR a.created_at < nxt.next_at)
    )
  )
ORDER BY s.idx, a.created_at DESC`

	rows, err := s.pool.Query(ctx, q, projectID)
	if err != nil {
		return nil, nil, fmt.Errorf("store: scene clips for project %s: %w", projectID, err)
	}
	defer rows.Close()

	var assets []Asset
	var cutOrderUpdatedAt *time.Time
	for rows.Next() {
		var a Asset
		var cutAt *time.Time
		if err := rows.Scan(&a.ID, &a.ProjectID, &a.SceneID, &a.Kind, &a.StorageKey, &a.DurationS, &a.Bytes, &cutAt); err != nil {
			return nil, nil, fmt.Errorf("store: scene clips for project %s: scan: %w", projectID, err)
		}
		assets = append(assets, a)
		// Every row joins the same project, so every row's cutAt is
		// identical — just take whichever the loop last saw.
		cutOrderUpdatedAt = cutAt
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("store: scene clips for project %s: %w", projectID, err)
	}
	return assets, cutOrderUpdatedAt, nil
}

// ClipsForRecipe returns the clips a final version's recipe names, in
// RECIPE ORDER, alongside the same cut-order stamp SceneClipsForProject
// reads and for the same reason (one query, one snapshot — see that
// function's doc comment and 0042/0043).
//
// This is the point of versioning. SceneClipsForProject answers "what would
// this project cut to right now"; rebuilding v1 with it would produce
// whatever the project looks like today, which is not v1. This answers
// "what did this recipe name", so v1 rebuilds as v1 even after every scene
// has been re-rendered since.
//
// Per entry:
//   - scene_version_id set     -> that version's clip. The clip_asset_id /
//     time-window pair is lifted verbatim from SceneClipsForProject, and
//     must stay identical to it: a version that NAMES its clip wins
//     outright (0058's backfill created v1 rows AFTER the clips they
//     describe, so the window alone would exclude them), otherwise the clip
//     is the newest one that landed at or after this version opened and
//     before the next one did.
//   - scene_version_id nil     -> the scene's newest clip, which is the
//     pre-0058 behaviour and the only honest reading of "version unknown".
//
// An entry naming a scene with no matching clip contributes NOTHING and is
// silently absent from the result — the caller compares len(clips) against
// len(recipe) to decide what that means (see assembleVersion). Matching the
// scene against projectID is deliberate: a recipe naming a scene in another
// project resolves to no clip rather than splicing a stranger's footage
// into this cut.
func (s *Store) ClipsForRecipe(ctx context.Context, projectID string, recipe []FinalVersionRecipeEntry) ([]Asset, *time.Time, error) {
	if len(recipe) == 0 {
		return nil, nil, nil
	}

	recipeJSON, err := json.Marshal(recipe)
	if err != nil {
		return nil, nil, fmt.Errorf("store: clips for recipe %s: encode recipe: %w", projectID, err)
	}

	const q = `
WITH recipe AS (
    SELECT ord,
           (entry->>'scene_id')::uuid         AS scene_id,
           (entry->>'scene_version_id')::uuid AS scene_version_id
    FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(entry, ord)
)
SELECT DISTINCT ON (r.ord)
       a.id, a.project_id, a.scene_id, a.kind, a.storage_key, a.duration_s, a.bytes,
       COALESCE(p.cut_order_updated_at, now())
FROM recipe r
JOIN scenes s ON s.id = r.scene_id AND s.project_id = $1
JOIN projects p ON p.id = s.project_id
LEFT JOIN scene_versions v ON v.id = r.scene_version_id
LEFT JOIN LATERAL (
  SELECT min(v2.created_at) AS next_at
  FROM scene_versions v2
  WHERE v2.scene_id = s.id
    AND v.created_at IS NOT NULL
    AND v2.created_at > v.created_at
) nxt ON true
JOIN assets a ON a.scene_id = s.id AND a.kind = 'clip'
WHERE v.clip_asset_id = a.id
   OR (
     v.clip_asset_id IS NULL
     AND (v.created_at IS NULL OR a.created_at >= v.created_at)
     AND (nxt.next_at IS NULL OR a.created_at < nxt.next_at)
   )
ORDER BY r.ord, a.created_at DESC`

	rows, err := s.pool.Query(ctx, q, projectID, recipeJSON)
	if err != nil {
		return nil, nil, fmt.Errorf("store: clips for recipe %s: %w", projectID, err)
	}
	defer rows.Close()

	var assets []Asset
	var cutOrderUpdatedAt *time.Time
	for rows.Next() {
		var a Asset
		var cutAt *time.Time
		if err := rows.Scan(&a.ID, &a.ProjectID, &a.SceneID, &a.Kind, &a.StorageKey, &a.DurationS, &a.Bytes, &cutAt); err != nil {
			return nil, nil, fmt.Errorf("store: clips for recipe %s: scan: %w", projectID, err)
		}
		assets = append(assets, a)
		cutOrderUpdatedAt = cutAt
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("store: clips for recipe %s: %w", projectID, err)
	}
	return assets, cutOrderUpdatedAt, nil
}

// InsertFinalAsset records a project's assembled final video as an asset
// row (kind='final', scene_id NULL — a final asset belongs to the project,
// not any one scene). Unlike MarkDone this touches no scene status: the
// assemble loop's claim (ClaimPendingFinalVersions) is what decides
// whether a build happens at all, not a status column and — since 0060 —
// not the presence of this row either, so no transaction/guard beyond a
// plain insert is needed here. A project legitimately has one such row per
// built final version now; MarkFinalVersionBuilt is what ties this asset
// back to the version it was built for.
func (s *Store) InsertFinalAsset(ctx context.Context, asset Asset) (string, error) {
	var assetID string
	err := s.pool.QueryRow(ctx, `
INSERT INTO assets (project_id, scene_id, kind, storage_key, duration_s, bytes, built_from_cut_order_at)
VALUES ($1, NULL, $2, $3, $4, $5, $6)
RETURNING id`,
		asset.ProjectID, asset.Kind, asset.StorageKey, asset.DurationS, asset.Bytes, asset.BuiltFromCutOrderAt,
	).Scan(&assetID)
	if err != nil {
		return "", fmt.Errorf("store: insert final asset for project %s: %w", asset.ProjectID, err)
	}
	return assetID, nil
}

// MarkFinalVersionBuilt records the outcome of a successful assemble on the
// version row that requested it: built_at (which is what takes the row off
// ClaimPendingFinalVersions' queue), and the assets it produced.
// posterAssetID is nil when poster extraction failed — a swallowed,
// best-effort step, see extractAndStoreFinalPoster — which is exactly the
// "built, no poster" state 0060 leaves room for.
//
// It also points projects.active_final_version_id at this version, in the
// same transaction. An operator who asked for a rebuild expects to see the
// rebuild; leaving them on the old cut and making them go find the new one
// is the surprise. This is safe to do automatically precisely BECAUSE the
// column exists: nothing is destroyed, and an operator who decides v2 was
// the better cut moves it back. (That is also why this is one transaction —
// a version marked built that the project does not point at, or the
// reverse, is a state neither the Deliver page nor the archive route has a
// sensible reading of.)
//
// The built_at IS NULL AND failed_at IS NULL re-check makes a duplicate
// build a no-op rather than a second, later overwrite. claimed_at should
// already have made that impossible, so this is the backstop, not the
// defence — the case it is actually here for is a future stale-lease sweep
// releasing a row whose worker was slow rather than dead. The second to
// finish finds ErrNotFound and leaves the first one's asset ids in place,
// instead of repointing the row at its own and orphaning them.
func (s *Store) MarkFinalVersionBuilt(ctx context.Context, versionID, projectID, finalAssetID string, posterAssetID *string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("store: mark final version built %s: begin tx: %w", versionID, err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op if committed

	tag, err := tx.Exec(ctx, `
UPDATE final_versions
SET built_at = now(), final_asset_id = $2, poster_asset_id = $3
WHERE id = $1 AND built_at IS NULL AND failed_at IS NULL`,
		versionID, finalAssetID, posterAssetID)
	if err != nil {
		return fmt.Errorf("store: mark final version built %s: %w", versionID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("store: mark final version built %s: %w", versionID, ErrNotFound)
	}

	if _, err := tx.Exec(ctx, `
UPDATE projects SET active_final_version_id = $2 WHERE id = $1`,
		projectID, versionID); err != nil {
		return fmt.Errorf("store: mark final version built %s: set active version: %w", versionID, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("store: mark final version built %s: commit: %w", versionID, err)
	}
	return nil
}

// MarkFinalVersionFailed is the assemble loop's give-up, and it exists for
// the same reason reconcile's does (see internal/loop/reconcile.go's giveUp):
// without it a row that cannot be built sits pending forever, re-claimed
// and re-attempted every 30s, indistinguishable from a version still
// waiting its turn. reason is stored verbatim so the operator sees the
// actual error, not just "failed".
//
// It clears claimed_at as it sets failed_at. A row that is both failed and
// leased describes a build still in progress that also already gave up;
// failed_at is what takes it off the queue now, so the lease has nothing
// left to protect and keeping it would only confuse the stale-lease sweep
// this loop still owes (see ClaimPendingFinalVersions). Success is the
// opposite case and deliberately leaves claimed_at alone — built_at is what
// makes that row finished, and clearing the lease there would say the build
// was never claimed at all.
//
// It deletes nothing — not the row, not the recipe. A failed version is
// still the record of a cut somebody asked for, and 0060's whole point is
// that the pipeline stopped destroying those.
func (s *Store) MarkFinalVersionFailed(ctx context.Context, versionID, reason string) error {
	tag, err := s.pool.Exec(ctx, `
UPDATE final_versions
SET failed_at = now(), failure_reason = $2, claimed_at = NULL
WHERE id = $1 AND built_at IS NULL AND failed_at IS NULL`,
		versionID, reason)
	if err != nil {
		return fmt.Errorf("store: mark final version failed %s: %w", versionID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("store: mark final version failed %s: %w", versionID, ErrNotFound)
	}
	return nil
}

// ReleaseStaleFinalVersionLeases clears the lease on final_versions rows
// that were claimed longer than olderThan ago and are still neither built
// nor failed, and returns how many it released so the caller can log a
// number rather than a shrug.
//
// This is the sweep 0060_final_versions.sql's claimed_at comment and
// ClaimPendingFinalVersions both name and neither implements. Without it a
// worker that dies mid-build leaves claimed_at set forever: the row is not
// built, not failed, and — because ClaimPendingFinalVersions requires
// claimed_at IS NULL — never claimable again, while
// final_versions_one_pending_idx forbids inserting a second request for
// that project. The project can never assemble again, and nothing in the
// app can clear it.
//
// IT CLEARS claimed_at ALONE, AND MUST NEVER ALSO SET failed_at. This is
// the constraint 0060 writes into the column comment, and it is not
// stylistic. The sweep cannot distinguish a dead worker from a slow-but-
// alive one; all it sees is an old timestamp. A slow worker's eventual
// MarkFinalVersionBuilt is guarded on `failed_at IS NULL`, so a sweep that
// declared the row failed would make that build's own completion bounce
// off its row — leaving a final that was genuinely assembled and uploaded
// sitting in storage with nothing pointing at it. Releasing the lease
// alone risks at worst a second build of the same cut, whose
// MarkFinalVersionBuilt still succeeds; that is the strictly better
// failure. Giving up on a final version is MarkFinalVersionFailed's job,
// reached from a build that actually ran, not this one's.
//
// built_at IS NULL AND failed_at IS NULL is doing real work in the
// predicate, not decoration: a built row deliberately KEEPS its claimed_at
// (see MarkFinalVersionBuilt's doc comment — built_at is what makes it
// finished, and clearing the lease would say it was never claimed), so
// without that guard this would quietly rewrite finished history every
// pass and report a nonzero release count forever.
func (s *Store) ReleaseStaleFinalVersionLeases(ctx context.Context, olderThan time.Duration) (int64, error) {
	const q = `
UPDATE final_versions
SET claimed_at = NULL
WHERE claimed_at IS NOT NULL
  AND claimed_at < now() - $1::interval
  AND built_at IS NULL
  AND failed_at IS NULL`

	tag, err := s.pool.Exec(ctx, q, olderThan.String())
	if err != nil {
		return 0, fmt.Errorf("store: release stale final version leases: %w", err)
	}
	return tag.RowsAffected(), nil
}

// InsertAsset records a standalone asset row that is NOT part of an atomic
// scene-completion write — currently only poster frames (internal/ingest,
// after a clip's MarkDone commits, and internal/loop/assemble, after a
// final's InsertFinalAsset commits). Deliberately separate from MarkDone's
// transaction rather than folded into it: a poster is a nicety, the clip
// or final video is the product, so an insert failing here must never roll
// back — or even be able to affect — the write that actually delivers the
// video. Both callers treat this as best-effort and log-and-continue on
// any error, never returning it up their own call chain.
//
// asset.SceneID may be nil (a poster for a project-level 'final' asset) or
// set (a poster for one scene's 'clip'), unlike InsertFinalAsset which
// always forces it nil.
func (s *Store) InsertAsset(ctx context.Context, asset Asset) (string, error) {
	var assetID string
	err := s.pool.QueryRow(ctx, `
INSERT INTO assets (project_id, scene_id, kind, storage_key, duration_s, bytes)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id`,
		asset.ProjectID, asset.SceneID, asset.Kind, asset.StorageKey, asset.DurationS, asset.Bytes,
	).Scan(&assetID)
	if err != nil {
		return "", fmt.Errorf("store: insert asset (kind=%s) for project %s: %w", asset.Kind, asset.ProjectID, err)
	}
	return assetID, nil
}

// ---------------------------------------------------------------------------
// captions
// ---------------------------------------------------------------------------

// CaptionScene carries the per-scene script text and talking-head flag
// internal/captions needs, plus the project-level pronunciation guide
// denormalized onto every row — a project has at most a few dozen scenes,
// so the duplication costs nothing and avoids a second round trip for a
// single string every caller of this method needs alongside every scene.
type CaptionScene struct {
	ID                 string
	ScriptLine         *string
	IsTalkingHead      bool
	PronunciationGuide *string
}

// CaptionStyle is one project's caption settings, exactly as stored.
//
// The colours stay hex here, unconverted. This package deliberately does
// not import internal/captions to do the ASS byte-order swap on the way
// out: a data layer that knows how libass spells a colour is a data layer
// that has to be changed when the renderer is. The swap belongs to the
// caller, and internal/captions makes forgetting it a compile error rather
// than a wrong-coloured video — GenerateASS takes a captions.Colors, and
// the only things that produce one are ColorsFromHex and DefaultColors.
type CaptionStyle struct {
	// Enabled is the project's own opt-out. It is ANDed with the
	// CAPTIONS_ENABLED env var by the caller, never here: this method
	// reports what the row says, and the global kill-switch is a config
	// question that has no business reaching the database layer.
	Enabled bool
	// BoxHex and TextHex are "#RRGGBB" strings. The column's own CHECK
	// constraint (0049) is what guarantees the shape; this struct carries
	// whatever the row holds.
	BoxHex  string
	TextHex string
}

// CaptionStyleForProject reads projectID's caption settings.
//
// A single-row read of its own rather than three more columns denormalized
// onto every CaptionScene: these values live once per project, and
// internal/loop/assemble needs the Enabled flag BEFORE it decides to
// transcribe anything — folding them into CaptionScenesForProject would
// mean fetching every scene, and paying for the decision, just to find out
// the project wanted no captions at all.
//
// Returns ErrNotFound for an unknown project id, matching this package's
// other lookups, so the caller can tell "no such project" apart from a
// database that is down — the first is a bug worth a loud log, the second
// is worth a retry.
func (s *Store) CaptionStyleForProject(ctx context.Context, projectID string) (CaptionStyle, error) {
	const q = `
SELECT captions_enabled, caption_box_color, caption_text_color
FROM projects
WHERE id = $1`

	var cs CaptionStyle
	err := s.pool.QueryRow(ctx, q, projectID).Scan(&cs.Enabled, &cs.BoxHex, &cs.TextHex)
	if errors.Is(err, pgx.ErrNoRows) {
		return CaptionStyle{}, ErrNotFound
	}
	if err != nil {
		return CaptionStyle{}, fmt.Errorf("store: caption style for project %s: %w", projectID, err)
	}
	return cs, nil
}

// CaptionScenesForProject returns projectID's scenes, in idx order, for
// internal/loop/assemble's caption pipeline. Includes every scene
// regardless of status — callers already only reach this once
// ClaimPendingFinalVersions has confirmed every scene is terminal, and a
// 'failed' scene simply has no clip asset for SceneClipsForProject to
// return, which the caller's clip-keyed lookup already handles by finding
// nothing to caption for it.
func (s *Store) CaptionScenesForProject(ctx context.Context, projectID string) ([]CaptionScene, error) {
	const q = `
SELECT s.id, s.script_line, s.is_talking_head, p.pronunciation_guide
FROM scenes s
JOIN projects p ON p.id = s.project_id
WHERE s.project_id = $1
ORDER BY s.idx`

	rows, err := s.pool.Query(ctx, q, projectID)
	if err != nil {
		return nil, fmt.Errorf("store: caption scenes for project %s: %w", projectID, err)
	}
	defer rows.Close()

	var scenes []CaptionScene
	for rows.Next() {
		var cs CaptionScene
		if err := rows.Scan(&cs.ID, &cs.ScriptLine, &cs.IsTalkingHead, &cs.PronunciationGuide); err != nil {
			return nil, fmt.Errorf("store: caption scenes for project %s: scan: %w", projectID, err)
		}
		scenes = append(scenes, cs)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: caption scenes for project %s: %w", projectID, err)
	}
	return scenes, nil
}

// InsertRun records a single runs row directly, with no scene-status side
// effect — unlike MarkDone/MarkFailed, which each transition scenes.status
// as part of the same transaction. Whisper transcription runs during
// assembly, after every scene is already terminal (done or failed); there
// is no status left to transition, only a paid call to account for. Per
// AGENTS.md's standing rule that every paid call site is counted (eight
// uncounted web-side sites were treated as a real defect when found), this
// is that accounting for internal/captions — see Run.ProjectID's doc
// comment for why ProjectID must always be set by the caller.
func (s *Store) InsertRun(ctx context.Context, run Run) error {
	if run.ProjectID == "" {
		return fmt.Errorf("store: insert run: project id is required")
	}
	_, err := s.pool.Exec(ctx, `
INSERT INTO runs (project_id, scene_id, kie_task_id, vendor, model, cost_usd, latency_ms, inference_ms, error)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		run.ProjectID, run.SceneID, run.KieTaskID, run.Vendor, run.Model, run.CostUSD, run.LatencyMS, run.InferenceMS, run.Error,
	)
	if err != nil {
		return fmt.Errorf("store: insert run: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

// RefFrameURL returns the storage_key of the scene's reference frame asset
// (scenes.ref_frame_asset_id -> assets.storage_key), used when submitting a
// render to fal (image_url) and when checking whether a scene has a frame
// at all. Returns ErrNotFound if the scene has no ref_frame_asset_id set or
// does not exist.
// SceneReference is one row of scene_references (0071): an asset this scene
// submits, and everything the prompt needs to say about it.
type SceneReference struct {
	// StorageKey is the object to sign and hand the vendor.
	StorageKey string
	// Kind is "image", "audio" or "video" — which vendor array this lands in.
	Kind string
	// Ordinal is 1-based WITHIN its kind, and is therefore the N the prompt
	// names: ordinal 3 of kind "image" is "@image3". Not a display order.
	Ordinal int
	// Category is what the picture depicts ('character', 'product', 'voice',
	// 'location'), snapshotted from the element. Nil for a direct upload.
	Category *string
	// Description is the operator's own words about it, snapshotted. Nil when
	// they wrote none.
	Description *string
	// Tag is the element NAME whose "@tag" selected this reference, or nil
	// when the picker or an upload did. loop.bindUITags rewrites exactly this
	// tag to "@image{Ordinal}" for kind "image"; for "audio" and "video" it
	// has no positional slot to bind to and is deleted from the prompt
	// outright instead (bindUITags's own comment says why).
	Tag *string
	// DurationS is the reference's own length in seconds, or nil when it was
	// never measured.
	//
	// ONLY A VIDEO'S IS BILLED. kie charges a video-conditioned render for
	// the reference's seconds ON TOP of the clip's, and at a different
	// per-second rate (17 against 28 for seedance-2.5 480p, measured
	// 2026-09-10 — see web/lib/kie/rates.ts's `video` table). Without this
	// column the worker's estimate was the output alone, which under-quoted
	// a 4s clip by 21%.
	//
	// Nil is NOT zero. An unmeasured duration means the cost is unknown, and
	// EstimateCost returns ok=false for it rather than quoting the render as
	// though it carried no video at all.
	DurationS *float64
}

// ReferencesForScene returns everything a scene submits, ordered the way the
// vendor indexes it.
//
// FALLS BACK to scenes.ref_frame_asset_id when the scene has no rows, which
// is every scripted-pipeline scene and every /ugc scene created before 0071.
// The fallback is a single image at ordinal 1 with no snapshot metadata —
// exactly what those scenes have always submitted — so this replaces
// RefFrameURL's single-key read without changing what the older route sends.
func (s *Store) ReferencesForScene(ctx context.Context, sceneID string) ([]SceneReference, error) {
	rows, err := s.pool.Query(ctx, `
SELECT a.storage_key, r.kind, r.ordinal, r.category, r.description, r.tag, a.duration_s
FROM scene_references r
JOIN assets a ON a.id = r.asset_id
WHERE r.scene_id = $1
ORDER BY r.kind, r.ordinal`, sceneID)
	if err != nil {
		return nil, fmt.Errorf("store: references for scene %s: %w", sceneID, err)
	}
	defer rows.Close()

	var out []SceneReference
	for rows.Next() {
		var r SceneReference
		if err := rows.Scan(&r.StorageKey, &r.Kind, &r.Ordinal, &r.Category, &r.Description, &r.Tag, &r.DurationS); err != nil {
			return nil, fmt.Errorf("store: scan reference for scene %s: %w", sceneID, err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: references for scene %s: %w", sceneID, err)
	}
	if len(out) > 0 {
		return out, nil
	}

	// No rows: the pre-0071 shape. One reference, no metadata, and the same
	// ErrNotFound a missing one has always produced — dispatchScene fails the
	// scene on it, which is the behaviour that keeps a render from being
	// submitted with nothing to condition on.
	//
	// THE KIND IS READ, NOT ASSUMED. This returned a hardcoded "image" until
	// 2026-09-04, which was true of every asset that could reach
	// scenes.ref_frame_asset_id before audio existed and stopped being true
	// the moment it did: /ugc writes the chosen reference's id into that
	// column whatever it is, so picking a voice as the primary reference puts
	// an audio asset there. Claiming it is an image sends an MP3 in
	// reference_image_urls, which the vendor refuses AFTER the submission —
	// a failure that costs a round trip and reads as a kie problem.
	//
	// Reachable only when a scene has no scene_references rows at all, since
	// attachSceneReferences runs on every /ugc insert. That makes it a latent
	// trap rather than a live bug, and a latent trap in a fallback is worse
	// than one in a hot path: it fires on the day something else has already
	// gone wrong.
	key, kind, durationS, err := s.refFrameKeyAndKind(ctx, sceneID)
	if err != nil {
		return nil, err
	}
	return []SceneReference{{StorageKey: key, Kind: kind, Ordinal: 1, DurationS: durationS}}, nil
}

// refFrameKeyAndKind is RefFrameURL plus the one fact the caller above cannot
// safely guess: whether that asset is something to look at or something to
// listen to.
//
// Kept separate from RefFrameURL rather than folded into it: that function has
// other callers who want only the key, and widening its signature to serve one
// of them is how a helper acquires a return value everybody ignores.
//
// assets.kind carries more members than scene_references.kind does — 'clip',
// 'poster' and the rest — and only 'audio' maps to the audio side and only
// 'video_ref' maps to the video side (0093_video_reference_elements.sql's
// upload kind; scene_references.kind spells the video member 'video' to
// match elements.category, not this one — see kie.SubmitRequest.VideoURLs's
// own comment). Anything else is a picture as far as the vendor is
// concerned, so the default is "image" rather than an error: a scene that
// somehow points at a 'poster' has a different problem than this function
// can fix, and refusing to render it here would turn a strange reference
// into a dead scene.
//
// This branch is added for correctness, not because it is reachable: the
// caller's own comment records that this whole fallback only fires when a
// scene has NO scene_references rows at all, and attachSceneReferences runs
// on every /ugc insert — a video-tagged scene has a scene_references row of
// kind 'video' by the time it gets here, same as image and audio do. Kept
// anyway so a hardcoded "image" is never the answer for a video asset that
// somehow does take this path.
func (s *Store) refFrameKeyAndKind(ctx context.Context, sceneID string) (string, string, *float64, error) {
	var storageKey, assetKind string
	var durationS *float64
	err := s.pool.QueryRow(ctx, `
SELECT a.storage_key, a.kind, a.duration_s
FROM scenes s
JOIN assets a ON a.id = s.ref_frame_asset_id
WHERE s.id = $1`, sceneID).Scan(&storageKey, &assetKind, &durationS)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", nil, fmt.Errorf("store: ref frame url for scene %s: %w", sceneID, ErrNotFound)
		}
		return "", "", nil, fmt.Errorf("store: ref frame url for scene %s: %w", sceneID, err)
	}
	if assetKind == "audio" {
		return storageKey, "audio", durationS, nil
	}
	if assetKind == "video_ref" {
		return storageKey, "video", durationS, nil
	}
	return storageKey, "image", durationS, nil
}

func (s *Store) RefFrameURL(ctx context.Context, sceneID string) (string, error) {
	var storageKey string
	err := s.pool.QueryRow(ctx, `
SELECT a.storage_key
FROM scenes s
JOIN assets a ON a.id = s.ref_frame_asset_id
WHERE s.id = $1`, sceneID).Scan(&storageKey)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", fmt.Errorf("store: ref frame url for scene %s: %w", sceneID, ErrNotFound)
		}
		return "", fmt.Errorf("store: ref frame url for scene %s: %w", sceneID, err)
	}
	return storageKey, nil
}

// ---------------------------------------------------------------------------
// scanning helpers
// ---------------------------------------------------------------------------

type rowScanner interface {
	Scan(dest ...any) error
}

func scanScene(row rowScanner) (*Scene, error) {
	var sc Scene
	err := row.Scan(
		&sc.ID, &sc.ProjectID, &sc.Idx, &sc.ScriptLine, &sc.VideoPrompt,
		&sc.IsTalkingHead, &sc.DurationS, &sc.Status, &sc.KieTaskID,
		&sc.SubmittedAt, &sc.RefFrameAssetID, &sc.AIGeneratedPrompt,
		&sc.ProjectKind,
		&sc.RenderSettings,
	)
	if err != nil {
		return nil, err
	}
	return &sc, nil
}

func scanScenes(rows pgx.Rows) ([]Scene, error) {
	var scenes []Scene
	for rows.Next() {
		sc, err := scanScene(rows)
		if err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		scenes = append(scenes, *sc)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return scenes, nil
}
