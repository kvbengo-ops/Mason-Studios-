package loop

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"ugc-pipeline/worker/internal/ingest"
	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/store"
)

// staleAfter is how long a scene may sit in 'rendering' before the
// reconcile loop starts checking on it directly. The webhook is the fast
// path; this is the safety net for the deploy-mid-render / dropped-webhook
// case — see docs/architecture.md § "Reconcile — webhooks get lost".
//
// Was 3 minutes, on the theory that generation itself takes that long, so
// polling any sooner would just hammer the vendor for a job that cannot
// possibly be done yet. That theory is false: checked against the live
// database, a real completed render's own reported inference time came
// back around 80s, while runs.latency_ms — which this loop's own detection
// timing determines — clustered at 210070/210069, 270127/270125,
// 299999/299999 ms across scenes submitted in the same batch. Values that
// close together across independently-rendered clips cannot be generation
// time; it is the moment reconcile happened to notice, i.e. mostly our own
// polling cadence stacked on top of the actual ~80s render. 45s is set
// just above that observed inference time plus a margin for the vendor's
// own queue wait, not at some arbitrary fraction of the old value — short
// enough that a lost webhook stops costing minutes, long enough that
// reconcile still isn't asking about a render that statistically cannot
// have finished yet.
const staleAfter = 45 * time.Second

// timeoutAfter is how long a scene may stay stuck (submitted but never
// resolving to COMPLETED/ERROR) before reconcile gives up and marks it
// failed outright, so a wedged kie request doesn't block a project forever.
//
// Left at 20 minutes despite staleAfter and the tick both shrinking: this
// threshold is about detecting a genuinely wedged render (~80s observed
// inference time, so 20 minutes is already ~15x that), not about polling
// cadence, so a faster tick doesn't change what "stuck" means — it only
// means a wedged scene now gets ~40 status checks instead of ~10 before
// this fires, all of them cheap.
const timeoutAfter = 20 * time.Minute

// finalVersionLeaseStaleAfter is how long a final_versions lease
// (claimed_at) may stand before reconcile assumes the worker holding it
// died and releases it. Set to 30 minutes.
//
// The two sides of the choice are not symmetric, which is what sets the
// value. Too long only delays recovery of a project that is already stuck.
// Too short re-releases a lease whose build is still running, and a second
// worker then claims and rebuilds the same cut — two ffmpeg runs and two
// uploads for one version. So this is deliberately set well above the
// slowest build that could still be healthy, not close to the typical one.
//
// What the slowest healthy build actually costs: assemble downloads each
// clip back out of storage under assemble.go's downloadTimeout (120s
// each), concats them with ffmpeg, then uploads a 10-30MB final. A
// pathological ten-clip project on a bad network is therefore already ~20
// minutes in downloads alone before ffmpeg starts. A typical assemble is a
// couple of minutes; 30 leaves roughly an order of magnitude of headroom
// over that and still clears the worst case above with room to spare.
//
// It matches Config.ReconcileGiveUpAfter's default numerically but is a
// separate constant on purpose: that one is a give-up (it marks a scene
// failed), this one is a lease release that decides nothing about the
// row's outcome, and tuning one should not silently move the other.
const finalVersionLeaseStaleAfter = 30 * time.Minute

// Reconcile runs every 30s: finds scenes stuck in 'rendering' whose webhook
// never arrived, checks kie directly, and ingests or fails them. See
// docs/architecture.md § "Reconcile — webhooks get lost".
func Reconcile(ctx context.Context, deps Deps) error {
	// Before the scene sweep and independent of it: a stuck final version
	// has nothing to do with a stuck render, and must not be skipped just
	// because no scene is stale this pass (the early return below).
	releaseStaleFinalVersionLeases(ctx, deps)

	scenes, err := deps.Store.StaleRendering(ctx, staleAfter)
	if err != nil {
		return fmt.Errorf("reconcile: stale rendering: %w", err)
	}
	if len(scenes) == 0 {
		return nil
	}

	var wg sync.WaitGroup
	for _, scene := range scenes {
		wg.Add(1)
		go func(scene store.Scene) {
			defer wg.Done()
			reconcileScene(ctx, deps, scene)
		}(scene)
	}
	wg.Wait()

	return nil
}

// reconcileScene resolves a single stale-rendering scene: a scene that was
// claimed but never got a kie task id (the process died between claim and
// submit) is failed outright; otherwise kie is asked directly for the
// request's status.
func reconcileScene(ctx context.Context, deps Deps, scene store.Scene) {
	logger := deps.Logger.With(slog.String("scene_id", scene.ID))

	// A stale-rendering scene with no task id was claimed by
	// ClaimQueuedScenes but the process died before ever calling
	// Deps.Kie.Submit (see dispatch.go's dispatchScene: every path either
	// persists a request_id or marks the scene failed, but a crash between
	// those two points is exactly what this loop exists to catch —
	// StaleRendering's submitted_at is stamped at claim time for precisely
	// this reason). There is nothing to poll kie about; it must not be
	// left stuck.
	if scene.KieTaskID == nil || *scene.KieTaskID == "" {
		markFailed(ctx, deps, logger, scene, "claimed but never submitted to kie")
		return
	}

	// Re-read render settings from the scene's project rather than
	// defaulted, so this resolves to the same model dispatch submitted to.
	settings, err := kie.ParseRenderSettings(scene.RenderSettings)
	if err != nil {
		markFailed(ctx, deps, logger, scene, err.Error())
		return
	}
	model, err := kie.PickModel(scene.IsTalkingHead, deps.Config.AudioEnabled, settings)
	if err != nil {
		markFailed(ctx, deps, logger, scene, err.Error())
		return
	}
	requestID := *scene.KieTaskID

	status, err := deps.Kie.Status(ctx, requestID)
	if err != nil {
		logger.Error("reconcile: kie status check failed", slog.String("error", err.Error()))
		// Same shape as the ingest failure below: without an age-based
		// backstop here, a kie task id that kie now rejects (expired, or —
		// in local dev — the mock's in-memory state lost to a worker
		// restart) makes every single reconcile tick log this same error
		// and leave the scene in 'rendering' forever. See giveUp.
		giveUp(ctx, deps, logger, scene, "kie status check kept failing", err)
		return
	}

	switch status {
	case kie.StatusCompleted:
		reconcileCompleted(ctx, deps, logger, scene, model, requestID)
	case kie.StatusFailed:
		reason := "kie reported the render failed"
		// A vendor that can say WHY (BytePlus: a real-face refusal, a content
		// block, an expiry) gets its own words on the run instead.
		if explainer, ok := deps.Kie.(interface {
			FailureReason(ctx context.Context, requestID string) (string, error)
		}); ok {
			if why, err := explainer.FailureReason(ctx, requestID); err == nil && why != "" {
				reason = why
			}
		}
		markFailedRun(ctx, deps, logger, scene, reason, true)
	case kie.StatusInQueue, kie.StatusInProgress:
		// Still working. Leave it — the next dispatch/webhook or the next
		// reconcile pass will pick it up.
		pastTimeout(ctx, deps, logger, scene)
	default:
		logger.Warn("reconcile: unrecognized kie status", slog.String("status", string(status)))
		pastTimeout(ctx, deps, logger, scene)
	}
}

// reconcileCompleted is the "webhook was lost" case: kie says the render
// finished, so this fetches the result and runs it through the exact same
// ingest path the webhook handler uses (internal/ingest), so the two
// cannot drift.
func reconcileCompleted(ctx context.Context, deps Deps, logger *slog.Logger, scene store.Scene, model kie.Model, requestID string) {
	// Re-check idempotency right before doing real work: a webhook may have
	// landed between StaleRendering's query and this goroutine running.
	fresh, err := deps.Store.SceneByKieTaskID(ctx, requestID)
	if err != nil {
		logger.Error("reconcile: re-fetch scene failed", slog.String("error", err.Error()))
		// Same shape as every other branch below: a scene whose row this
		// query keeps failing to read never becomes reachable any other
		// way, so it must age out too rather than retry silently forever.
		// Keyed off the outer (stale) scene, since the re-fetch that would
		// give us a fresher one is exactly what just failed.
		giveUp(ctx, deps, logger, scene, "scene re-fetch kept failing", err)
		return
	}
	if fresh.Status == "done" {
		return
	}

	result, err := deps.Kie.Result(ctx, requestID)
	if err != nil {
		logger.Error("reconcile: fetch kie result failed", slog.String("error", err.Error()))
		giveUp(ctx, deps, logger, *fresh, "kie result fetch kept failing", err)
		return
	}

	if err := ingest.FromResult(ctx, ingest.Deps{Store: deps.Store, Config: deps.Config, Media: deps.Media, Logger: logger}, *fresh, result); err != nil {
		logger.Error("reconcile: ingest failed", slog.String("error", err.Error()))
		giveUp(ctx, deps, logger, *fresh, "ingest kept failing", err)
		return
	}
	// "the webhook did not deliver it", NOT "the webhook never arrived".
	// Reconcile cannot tell the difference and has no business guessing: on
	// 2026-09-03 this line was written thirty seconds after the SAME worker
	// logged `kie webhook: rejected unverified request` for the same task.
	// kie had signed and delivered; our own secret was wrong. Anyone reading
	// the old wording would go looking at kie for a silence that was ours.
	logger.Info("reconcile: ingested a render the webhook path had not")
}

// giveUp is the shared backstop for every reconcile step that can fail
// repeatedly against the same scene without ever reaching a terminal
// status: the kie status check, the scene re-fetch, the kie result fetch,
// and ingest (download/normalize/upload). Without this, a scene stuck on a
// repeatable error in any of those (an expired/rejected kie task id, a
// corrupt download, a codec ffmpeg can't normalize, a storage-upload
// outage) sits in 'rendering' forever — StaleRendering keeps finding it
// every reconcile pass since its submitted_at never changes, and the same
// step keeps failing the same way. It is invisible to the operator (no
// 'failed' status) and unreachable by retryScene (which only handles
// status='failed'). reasonPrefix names which step gave up, and cause's
// text is included in the stored failure message so the operator (and
// retryScene) can see the real error, not just "gave up".
//
// Age is measured from scene.SubmittedAt, the same claim-time timestamp
// StaleRendering and pastTimeout already key off — no new column needed.
// One shared threshold (Config.ReconcileGiveUpAfter) covers all of these
// failure modes rather than each growing its own separately-tunable
// timeout, since they're all the same shape: reconcile can't move this
// scene forward. See giveUpDeadlinePassed for the nil-SubmittedAt handling.
func giveUp(ctx context.Context, deps Deps, logger *slog.Logger, scene store.Scene, reasonPrefix string, cause error) {
	if !giveUpDeadlinePassed(scene.SubmittedAt, deps.Config.ReconcileGiveUpAfter) {
		return // still within the grace period; the next reconcile pass will retry.
	}
	markFailed(ctx, deps, logger, scene, giveUpReason(reasonPrefix, cause))
}

// giveUpReason builds the MarkFailed message for a give-up: reasonPrefix
// names the step that kept failing, and cause's own text is appended
// verbatim so the operator (and retryScene, which surfaces this message)
// sees the actual underlying error — e.g. the kie "unknown task id" text
// from the bug this backstop was added for — not just "gave up". Split out
// from giveUp so the message format is testable without a live
// *store.Store.
func giveUpReason(reasonPrefix string, cause error) string {
	return fmt.Sprintf("%s: %s", reasonPrefix, cause.Error())
}

// giveUpDeadlinePassed is the boundary check split out of giveUp purely so
// it's testable without a live *store.Store: true once submittedAt is more
// than giveUpAfter in the past, or if submittedAt is nil.
//
// nil is deliberately "already past the deadline", not "never give up" —
// see AGENTS.md's `NULL < x` is `NULL` gotcha. The Go equivalent of that
// trap would be a nil-check that just skips the give-up entirely, which
// re-creates the exact immortal-row bug this function exists to close. A
// scene can't actually reach here with a nil SubmittedAt in practice (both
// ClaimQueuedScenes and MarkRendering stamp it), so this is a defensive
// default, not the expected path.
func giveUpDeadlinePassed(submittedAt *time.Time, giveUpAfter time.Duration) bool {
	return submittedAt == nil || time.Since(*submittedAt) >= giveUpAfter
}

// pastTimeout marks a still-not-terminal scene failed once it has been
// stuck long enough that it is more likely wedged than merely slow.
func pastTimeout(ctx context.Context, deps Deps, logger *slog.Logger, scene store.Scene) {
	if scene.SubmittedAt == nil || time.Since(*scene.SubmittedAt) < timeoutAfter {
		return
	}
	markFailed(ctx, deps, logger, scene, "timeout")
}

// markFailed builds the Run this failure is recorded with and delegates to
// store.MarkFailed. Every call site above is reached by reconcileScene
// either directly refusing a scene with no kie task id (never billed — see
// below) or after already checking scene.KieTaskID != nil (billed — see
// store.MarkFailed's doc comment for why a persisted request id is this
// codebase's bar for "the vendor accepted and started the job"). That
// split is re-checked here rather than threaded through every caller as a
// bool, because it's a fact about the scene, not about which failure step
// detected it — computing it once, off the same scene every caller already
// has, is what keeps it from drifting between call sites.
func markFailed(ctx context.Context, deps Deps, logger *slog.Logger, scene store.Scene, reason string) {
	markFailedRun(ctx, deps, logger, scene, reason, false)
}

// markFailedRun is markFailed; kieFailed means kie itself reported the task
// failed, so its own charge replaces the held estimate (kie.FailedRunCost).
func markFailedRun(ctx context.Context, deps Deps, logger *slog.Logger, scene store.Scene, reason string, kieFailed bool) {
	run := store.Run{
		ProjectID: scene.ProjectID,
		// Default: a scene with no persisted request id below was never
		// actually submitted, so this is a placeholder rather than a claim
		// about what was billed.
		Vendor: kie.Vendor,
		Error:  &reason,
	}
	if scene.KieTaskID != nil && *scene.KieTaskID != "" {
		run.Vendor = kie.VendorOf(*scene.KieTaskID)
		settings, settingsErr := kie.ParseRenderSettings(scene.RenderSettings)
		model, modelErr := kie.PickModel(scene.IsTalkingHead, deps.Config.AudioEnabled, settings)
		// This number is FINAL for a failed render (nothing overwrites it
		// the way a vendor-reported ActualCostUSD does on success), so
		// costPtr stays nil rather than a fabricated number when
		// kie.EstimateCost can't price it — see that function's own doc
		// comment.
		cost, costKnown := kie.EstimateCost(model, scene.DurationS)
		run.Model = model.KieModelID
		if settingsErr == nil && modelErr == nil && costKnown {
			run.CostUSD = &cost
		} else {
			logger.Error("reconcile: cost estimate unavailable; no rate for this model at this audio tier",
				slog.String("model", model.ID),
				slog.String("resolution", model.Resolution),
				slog.Bool("has_audio", model.HasAudio),
				slog.String("reason", kie.MissingRateReason(model)))
		}
		if kieFailed {
			run.CostUSD = kie.FailedRunCost(ctx, deps.Kie, *scene.KieTaskID, run.CostUSD)
		}
		// The same persisted id proves both that kie accepted the attempt
		// and which immutable runs row this estimated charge belongs to.
		run.KieTaskID = scene.KieTaskID
	}
	if err := deps.Store.MarkFailed(ctx, scene.ID, run); err != nil {
		logger.Error("reconcile: mark failed failed", slog.String("reason", reason), slog.String("error", err.Error()))
	}
}

// releaseStaleFinalVersionLeases clears leases left behind by workers that
// died mid-assemble, so the project can be built again — see
// store.ReleaseStaleFinalVersionLeases for why this clears claimed_at alone
// and never sets failed_at.
//
// WARN, not Info, when it releases anything: the only way a lease gets this
// old is that a worker holding it stopped existing. The sweep heals the
// row, but the crash behind it is real and worth a line an operator will
// actually see, rather than being papered over silently. Zero releases —
// the normal case, every tick — logs nothing.
//
// A failure here is logged and swallowed rather than returned: this sweep
// is a backstop bolted onto the reconcile pass, and letting it abort the
// scene reconciliation that follows would trade a stuck final version for
// stuck renders.
func releaseStaleFinalVersionLeases(ctx context.Context, deps Deps) {
	released, err := deps.Store.ReleaseStaleFinalVersionLeases(ctx, finalVersionLeaseStaleAfter)
	if err != nil {
		deps.Logger.Error("reconcile: release stale final version leases failed", slog.String("error", err.Error()))
		return
	}
	if released > 0 {
		deps.Logger.Warn("reconcile: released stale final version leases (a worker died mid-assemble)",
			slog.Int64("released", released),
			slog.Duration("older_than", finalVersionLeaseStaleAfter))
	}
}
