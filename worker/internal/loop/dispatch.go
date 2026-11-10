package loop

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"ugc-pipeline/worker/internal/byteplus"
	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/store"
)

// signedURLExpiry is how long the reference-frame URL handed to kie stays
// valid. Sized generously relative to how quickly kie actually starts a
// job — a submission racing an expiring signed URL would fail the render
// for no good reason.
const signedURLExpiry = 1 * time.Hour

// recoveryWriteTimeout bounds a compensating write. Deliberately short: these
// writes happen on the way out of a dispatch that is usually being cancelled,
// and main gives the process a 10s shutdown budget (cmd/worker/main.go).
const recoveryWriteTimeout = 5 * time.Second

// recoveryCtx returns the context for a compensating write — a write whose only
// job is to record what already happened, after the thing it describes has
// already failed.
//
// It deliberately does not inherit the parent's cancellation, because both call
// sites below are reached most often *because* ctx was cancelled.
// markRenderingWithRetry returns early exactly when ctx.Err() != nil, and a
// redeploy mid-dispatch is the routine cause of that — deploy.yml fires on every
// green push to main. Handing that same dead context to MarkFailed guarantees the
// compensating write fails for the same reason the original one did, which leaves
// a render kie has already accepted and billed sitting in 'rendering' with no
// kie_task_id. StaleRendering finds it later, reconcileScene's nil-request-id
// branch marks it "claimed but never submitted to kie", and it lands in runs with
// cost_usd nil. The dollar was spent and the ledger says it was free — the exact
// reclassification the markRenderingWithRetry branch below exists to prevent.
//
// Values still come from the parent (a request id or trace carried on the context
// stays attached); only cancellation and any inherited deadline are dropped, and
// this imposes its own so a wedged write cannot outlive the shutdown budget.

// costOrZeroIfMocked turns a cost estimate into the *float64
// store.Run.CostUSD expects: zero in MODE=development
// (config.Config.IsDev()) — nothing is ever billed there, see
// ingest.FromResult for the full argument — the estimate when known, or nil
// when unknown and not mocked. nil, never a fabricated number: known=false
// should be unreachable in practice (see kie.EstimateCost's own doc
// comment), but the one thing worse than an unpriced render is inventing a
// price for it.
func costOrZeroIfMocked(deps Deps, usd float64, known bool) *float64 {
	if deps.Config.IsDev() {
		zero := 0.0
		return &zero
	}
	if !known {
		return nil
	}
	return &usd
}

func recoveryCtx(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(parent), recoveryWriteTimeout)
}

// Dispatch runs every 30s: claims whatever queued scenes still fit under
// RenderConcurrency and submits them to kie. The free-slot arithmetic lives
// inside ClaimQueuedScenes' own statement, so the ceiling holds across
// worker instances rather than only within one. See docs/architecture.md
// § "Dispatch — the queue".
//
// Claimed scenes are submitted concurrently — bounded parallelism is
// already guaranteed by the claim itself, since ClaimQueuedScenes never
// returns more scenes than there is room for in flight. A per-scene failure (missing
// reference frame, signing error, kie rejecting the submission) marks that
// scene 'failed' and does not abort the rest of the batch.
func Dispatch(ctx context.Context, deps Deps) error {
	// Ahead of ClaimQueuedScenes, not inside the submit
	// loop. Claiming is what flips a scene to 'rendering', and the worker
	// cannot flip it back — so a scene claimed during an outage is a scene
	// that can only end 'failed'. The cheapest scene is the one never
	// claimed. See BalanceGate.
	if blocked, until := deps.Balance.Blocked(time.Now()); blocked {
		deps.Logger.Info("dispatch: paused, kie account was out of credit",
			slog.Time("retry_after", until))
		return nil
	}

	scenes, err := deps.Store.ClaimQueuedScenes(ctx, deps.Config.RenderConcurrency, deps.BytePlusClaimCap, deps.Config.KieMaxSubmitsPerTick)
	if err != nil {
		return fmt.Errorf("dispatch: claim queued scenes: %w", err)
	}
	if len(scenes) == 0 {
		return nil
	}

	webhookBaseURL := strings.TrimRight(deps.Config.AppBaseURL, "/")

	var wg sync.WaitGroup
	for _, scene := range scenes {
		wg.Add(1)
		go func(scene store.Scene) {
			defer wg.Done()
			dispatchScene(ctx, deps, scene, webhookBaseURL)
		}(scene)
	}
	wg.Wait()

	return nil
}

// returnToQueue puts a claimed scene kie never saw back in the queue. If it
// cannot be put back, the scene fails with the reason rather than staying
// 'rendering' with no task id.
func returnToQueue(ctx context.Context, deps Deps, logger *slog.Logger, scene store.Scene, cause error, msg string) {
	recCtx, cancel := recoveryCtx(ctx)
	defer cancel()
	if rerr := deps.Store.ReleaseUnsubmittedClaim(recCtx, scene.ID); rerr != nil {
		failScene(ctx, deps, logger, scene, fmt.Errorf("submit render: %w (and could not return it to the queue: %v)", cause, rerr))
		return
	}
	logger.Warn(msg, slog.String("error", cause.Error()))
}

// dispatchScene submits a single already-claimed (status='rendering') scene
// to kie, or marks it failed if it cannot be submitted. It never leaves a
// scene claimed-but-unsubmitted: every path ends in either MarkRendering or
// MarkFailed.
func dispatchScene(ctx context.Context, deps Deps, scene store.Scene, webhookBaseURL string) {
	logger := deps.Logger.With(slog.String("scene_id", scene.ID))

	// Resolution/fps come from the project's render_settings, carried on the
	// scene by ClaimQueuedScenes. ClampFPSForDuration is a no-op for every
	// model kie serves today (see its own doc comment) but is still called
	// unconditionally, so a future model that DOES constrain fps by
	// duration doesn't need a new call site here.
	settings, err := kie.ParseRenderSettings(scene.RenderSettings)
	if err != nil {
		failScene(ctx, deps, logger, scene, err)
		return
	}
	descriptor, ok := kie.DescriptorByID(settings.Model)
	if !ok {
		failScene(ctx, deps, logger, scene, fmt.Errorf("unknown render model %q", settings.Model))
		return
	}
	settings.FPS = kie.ClampFPSForDuration(descriptor, settings.FPS, scene.DurationS)

	model, err := kie.PickModel(scene.IsTalkingHead, deps.Config.AudioEnabled, settings)
	if err != nil {
		failScene(ctx, deps, logger, scene, err)
		return
	}
	logger.Info("dispatch: model resolved", slog.String("selected_model", settings.Model),
		slog.String("kie_model", model.KieModelID), slog.String("resolution", model.Resolution))
	if !kie.GeminiOmniVideoPaid(model) {
		failScene(ctx, deps, logger, scene, fmt.Errorf("Gemini Omni Video is not available until a paid receipt exists"))
		return
	}
	// PROVISIONAL, and refined once the references are read below.
	//
	// A video reference is billed on top of the output and at a different
	// per-second rate, so a scene carrying one cannot be priced from the
	// model and duration alone. The references are not loaded yet at this
	// point in the function and moving this call after them would move the
	// "cost estimate unavailable" warning past several failure paths that
	// currently log it first — so the no-video number is computed here, as
	// it always was, and replaced below when there is a video to count.
	estimatedCost, costKnown := kie.EstimateCost(model, scene.DurationS)
	if !costKnown {
		// REACHABLE TODAY, on Seedance with audio on.
		//
		// This used to say "should be unreachable", citing
		// TestRatesCoverAllowedResolutions as the guarantee. That test does
		// not make it: it checks a silent rate for every AllowedResolution,
		// and a SOUND rate only when d.NativeAudio — which is true for Kling
		// alone (models.go:303) and false for Seedance (:347). Seedance
		// nevertheless sets SupportsGenerateAudio (:344), so standardModel
		// gives it HasAudio = AUDIO_ENABLED (:709), render.yaml sets that to
		// "1" in production (render.yaml:316), and Rates["seedance-2.5"]
		// declares no Sound map at all — so rateFor bails (models.go:176) and
		// this branch fires on every production Seedance render.
		//
		// The consequence is not this log line. It is that /ugc quotes the
		// SILENT rate (its page.tsx calls offerable(false)) for a render the
		// worker submits with generate_audio:true, which kie charges more
		// for. The ledger stays honest afterwards — runs.cost_usd prefers
		// kie's own creditsConsumed — but the quote and the spend cap are
		// both computed against a price that is not the one being paid.
		//
		// Left logging-and-continuing rather than refusing: turning this into
		// a refusal stops production renders, and that is a decision about
		// the product, not a bug fix. Recorded here so it is a known state
		// rather than a puzzling log line.
		//
		// Logged loudly rather than silently substituting a fabricated number
		// — see kie.EstimateCost's own doc comment for why unknown must never
		// become zero or a guess.
		logger.Error("dispatch: cost estimate unavailable; no rate for this model at this audio tier",
			slog.String("model", model.ID),
			slog.String("resolution", model.Resolution),
			slog.Bool("has_audio", model.HasAudio),
			slog.String("reason", kie.MissingRateReason(model)))
	}

	// Missing assets and read failures must not silently turn into text-to-video.
	// Only an intentionally frameless clip on a supported endpoint may proceed.
	//
	// ReferencesForScene returns 0071's scene_references rows in vendor order,
	// falling back to the single scenes.ref_frame_asset_id for every scripted
	// scene and every /ugc scene predating that table.
	refs, err := deps.Store.ReferencesForScene(ctx, scene.ID)
	promptOnlyAllowed := scene.ProjectKind == "clip" && kie.SupportsPromptOnlyVideo(model.ID)
	if err != nil && !(promptOnlyAllowed && scene.RefFrameAssetID == nil && errors.Is(err, store.ErrNotFound)) {
		failScene(ctx, deps, logger, scene, fmt.Errorf("no reference frame: %w", err))
		return
	}

	// THE VIDEO'S OWN SECONDS ARE BILLED TOO. Until 2026-09-10 this line did
	// not exist and estimated_cost_usd was the output alone: a 4s clip
	// carrying a 4.064s video logged 0.56 against a real bill of 0.68. The
	// error is not a constant either — the per-second rate falls from 28 to
	// 17 once a video is attached, so past roughly 6.2s of output the
	// output-only number is too HIGH instead (the 8s render logged 1.12 and
	// billed 1.02).
	//
	// Only "video" kinds are counted. An image or a voice reference changes
	// nothing about the bill; four receipts hold image count flat at 112
	// credits across one, two, three and four pictures.
	var videoInputSeconds []*float64
	for _, r := range refs {
		if r.Kind == "video" {
			videoInputSeconds = append(videoInputSeconds, r.DurationS)
		}
	}
	if len(videoInputSeconds) > 0 {
		// Deliberately overwrites both, including costKnown: a scene whose
		// video has no measured duration is a scene nobody can price, and
		// saying "unknown" is the honest answer where the output-only figure
		// would be a confident wrong one.
		estimatedCost, costKnown = kie.EstimateCostWithVideo(model, scene.DurationS, videoInputSeconds)
	}
	// Gemini's documented quota is seven units (image=1, video=2), exactly
	// one source video, and it has no URL-based audio field. Refuse malformed
	// or legacy scenes here as a defence in depth; the web action applies the
	// same policy before any queued write.
	if model.ID == "gemini-omni-video" {
		imageCount, audioCount, videoCount := 0, 0, 0
		for _, r := range refs {
			switch r.Kind {
			case "image":
				imageCount++
			case "audio":
				audioCount++
			case "video":
				videoCount++
			}
		}
		if imageCount == 0 || audioCount > 0 || videoCount > 1 || imageCount+videoCount*2 > 7 {
			failScene(ctx, deps, logger, scene, fmt.Errorf("Gemini Omni Video needs an image reference, supports up to seven reference units (image=1, video=2), one video, and no audio URL references"))
			return
		}
		if videoCount > 0 && !kie.GeminiOmniVideoInputPaid(model) {
			failScene(ctx, deps, logger, scene, fmt.Errorf("Gemini source-video input is not available until a paid video-input receipt exists"))
			return
		}
		if videoCount == 1 && (!costKnown || len(videoInputSeconds) != 1 || videoInputSeconds[0] == nil || *videoInputSeconds[0] <= 0 || math.IsInf(*videoInputSeconds[0], 0) || math.IsNaN(*videoInputSeconds[0])) {
			failScene(ctx, deps, logger, scene, fmt.Errorf("Gemini Omni Video needs a measured source-video duration"))
			return
		}
	}
	if model.ID == "gemini-omni-1.2" {
		imageCount := 0
		for _, r := range refs {
			if r.Kind != "image" {
				failScene(ctx, deps, logger, scene, fmt.Errorf("Gemini Omni 1.2 accepts image references only"))
				return
			}
			imageCount++
		}
		if imageCount > 6 {
			failScene(ctx, deps, logger, scene, fmt.Errorf("Gemini Omni 1.2 accepts at most six image references"))
			return
		}
	}
	// kling4RefInput sends images only. A voice or video it dropped would be
	// a render the operator believed carried one; refuse it unbilled instead.
	if model.ID == "kling-4.0-reference" {
		for _, r := range refs {
			if r.Kind == "audio" || r.Kind == "video" {
				failScene(ctx, deps, logger, scene, fmt.Errorf("Kling 4.0 Reference takes image references only; remove the %s reference or switch to Seedance", r.Kind))
				return
			}
		}
	}

	// Signed in ORDINAL ORDER, and the slice's order is what the vendor
	// indexes: element 0 becomes reference_image_urls[0], which the prompt
	// names "@image1". A sort here that disagreed with the ordinals would
	// silently repoint every tag.
	// THE /ugc ROUTE SENDS NO PICTURES.
	//
	// Its references are still attached, still stored, still owned — they are
	// simply read by CLAUDE rather than by the video model. refineClipPrompt
	// hands each one to Sonnet, which describes what it can see and writes
	// that description into the prompt, so the text that arrives here is
	// already self-contained prose.
	//
	// AND THE PICTURE GOES TOO. /ugc used to null this out — the descriptions
	// were meant to be the whole reference, so the route sent no images at
	// all. The paragraph above warned exactly what that would cost: "a
	// description fixes the CATEGORY, not the identity... seven clips of one
	// ad become seven different women who all match the words."
	//
	// The first real render proved it. The reference was a woman of about
	// thirty with shoulder-length blonde hair; the description said so; the
	// clip returned a woman of about sixty with long silver hair. Everything
	// else landed — the kitchen, the mug, the linen shirt, the gold hoops —
	// because wardrobe and staging survive being written down. A face does
	// not. The scene's own language ("quiet resignation of someone who has
	// done this a thousand times") simply outvoted the four words naming her
	// age, and no amount of repetition fixed it: the description appeared six
	// times in that prompt.
	//
	// So both go now. The substituted prose still carries wardrobe, staging
	// and everything a picture cannot say, and reference_image_urls carries
	// the identity it turns out only a picture can.

	// THREE ARRAYS NOW, from one ordered read. The old loop skipped every
	// non-image row and said why: "the day it can exist this must not
	// silently post an audio key into the image array". 0079 made that day
	// today for audio, and 0094_video_scene_reference.sql made it today for
	// video too — a tagged .mp4 gets its own destination rather than being
	// dropped on the floor the way it deliberately was until now.
	//
	// ReferencesForScene already orders by (kind, ordinal), so each slice
	// comes out in the order the prompt names its members — @image1 and
	// @voice1 are both element 0 of their own kind.
	imageURLs := make([]string, 0, len(refs))
	audioURLs := make([]string, 0, len(refs))
	videoURLs := make([]string, 0, len(refs))
	videoDurations := make([]*float64, 0, len(refs))
	for _, r := range refs {
		if r.Kind != "image" && r.Kind != "audio" && r.Kind != "video" {
			// A kind this build does not know about. Skipped rather than
			// guessed at: posting an unknown key into any vendor array is
			// how a render silently carries the wrong material.
			continue
		}
		signed, err := store.SignedURL(ctx, nil, deps.Config.SupabaseURL, deps.Config.SupabaseServiceRoleKey, r.StorageKey, signedURLExpiry)
		if err != nil {
			failScene(ctx, deps, logger, scene, fmt.Errorf("sign reference url (%s): %w", r.Kind, err))
			return
		}
		if r.Kind == "audio" {
			audioURLs = append(audioURLs, signed)
			continue
		}
		if r.Kind == "video" {
			videoURLs = append(videoURLs, signed)
			videoDurations = append(videoDurations, r.DurationS)
			continue
		}
		imageURLs = append(imageURLs, signed)
	}
	// A missing reference is fatal for the SCRIPTED route, whose whole
	// character-consistency mechanism it is, and normal for /ugc, which sends
	// none on purpose.
	//
	// DELIBERATELY STILL IMAGES ONLY, now that videoURLs exists alongside it.
	// A video reference is not a substitute for the reference FRAME this
	// check protects: Kling and Hailuo, the two models a SCRIPTED scene can
	// still land on, have no video-reference field at all (see
	// kie.SubmitRequest.VideoURLs's own comment), so a SCRIPTED scene with a
	// video tag and no image tag would still have no character-consistency
	// mechanism on the vendor that actually renders it. Widening this to
	// `len(imageURLs) == 0 && len(videoURLs) == 0` would let exactly that
	// scene through silently.
	if len(imageURLs) == 0 && !promptOnlyAllowed {
		failScene(ctx, deps, logger, scene, fmt.Errorf("no reference frame: scene has no image references"))
		return
	}
	refURL := ""
	if len(imageURLs) > 0 {
		refURL = imageURLs[0]
	}

	// The reference-frame URL has broken a real render before, showing up
	// only as kie's own download failure minutes later, with nothing on our
	// side saying what we actually sent. Log the URL minus its token so the
	// next failure is diagnosable from our own logs instead of by
	// reconstructing the call by hand.
	if idx := strings.Index(refURL, "?"); idx >= 0 {
		logger.Info("dispatch: reference frame url", slog.String("url", refURL[:idx]))
	} else {
		logger.Info("dispatch: reference frame url", slog.String("url", refURL))
	}

	webhookURL := webhookBaseURL + "/webhooks/kie"

	requestID, err := deps.Kie.Submit(ctx, kie.SubmitRequest{
		SelectedModelID: model.ID,
		KieModelID:      model.KieModelID,
		Prompt:          promptForScene(scene, refs, withSpeech(scene, model), model),
		// BytePlus only (see kie.SubmitRequest.ReferencePrompt); kie ignores it.
		ReferencePrompt: referencePrompt(scene, refs, withSpeech(scene, model)),
		ImageURL:        refURL,
		// Every reference, in vendor order. ImageURL above stays the first
		// of them: Hailuo, which takes exactly one, still reads that field
		// directly. Kling reads this whole slice instead — up to its first
		// two entries, start frame then end frame (klingInput, models.go) —
		// which is why a single-image field can no longer stand in for it.
		ImageURLs: imageURLs,
		// Seedance only. Kling and Hailuo have no audio-reference field and
		// their builders never read this, so an operator who tags a voice on
		// a Kling scene gets the clip they asked for without the voice —
		// which is the honest outcome, since the vendor cannot take it.
		AudioURLs: audioURLs,
		// Seedance only, same as AudioURLs above — Kling and Hailuo ignore
		// this too. UNLIKE the two arrays above it, sending this one changes
		// what the render costs (Price x (input + output), not Price x
		// output); see kie.SubmitRequest.VideoURLs's own comment and
		// seedanceInput in models.go.
		VideoURLs:            videoURLs,
		VideoDurationSeconds: videoDurations,
		// Gemini only; ParseRenderSettings leaves Voice empty for every other model.
		AudioIDs: voiceIDs(settings.Voice),
		// Seedance and Hailuo only — see kie.Descriptor.DurationSendAsString.
		DurationSendAsString: model.DurationSendAsString,
		DurationSeconds:      scene.DurationS,
		WebhookURL:           webhookURL,
		Resolution:           model.Resolution,
		AspectRatio:          model.AspectRatio,
		FPS:                  model.FPS,
		GenerateAudio:        model.GenerateAudio,
		// The same fact promptForScene above is already given: whether this
		// clip is spoken. kie's Kling reads it as `sound`.
		HasAudio: withSpeech(scene, model),
	})
	if err != nil {
		// The BytePlus cap's backstop: nothing reached BytePlus and nothing
		// was billed, so the scene goes back in the queue rather than
		// failing. The claim's own cap makes this rare (see
		// store.ClaimQueuedScenes); still never kie.
		//
		// kie.ErrRateLimited takes the same road: kie refused the createTask
		// before queuing it, so nothing was billed and the next tick retries.
		// Reconcile's 45s line is why this is a requeue, not an in-process wait.
		atCapacity := errors.Is(err, byteplus.ErrAtCapacity)
		if atCapacity || errors.Is(err, kie.ErrRateLimited) {
			// Bounded: the claim's cap should keep this from firing at all, so a
			// scene that keeps landing here means the in-flight count looks
			// permanently full (stuck rows, a miscount). Requeuing it forever
			// would hide that behind a silent 30s loop; failing it says so.
			n := deps.CapacityRequeues.note(scene.ID)
			if n > maxCapacityRequeues {
				reason := fmt.Sprintf("kie kept rate-limiting this submission through %d tries in a row", maxCapacityRequeues)
				if atCapacity {
					reason = fmt.Sprintf("BytePlus stayed at capacity through %d tries in a row, so its in-flight count may be stuck", maxCapacityRequeues)
				}
				failScene(ctx, deps, logger, scene, fmt.Errorf("submit render: %s: %w", reason, err))
				return
			}
			recCtx, cancel := recoveryCtx(ctx)
			defer cancel()
			if rerr := deps.Store.ReleaseUnsubmittedClaim(recCtx, scene.ID); rerr != nil {
				failScene(ctx, deps, logger, scene, fmt.Errorf("submit render: %w (and could not return it to the queue: %v)", err, rerr))
				return
			}
			msg := "dispatch: kie rate-limited the submission, scene returned to the queue"
			if atCapacity {
				msg = "dispatch: BytePlus at capacity past the claim's cap, scene returned to the queue"
			}
			logger.Warn(msg,
				slog.String("error", err.Error()), slog.Int("requeues", n), slog.Int("max_requeues", maxCapacityRequeues))
			return
		}
		// The gate closed while this scene waited for its submit slot: nothing
		// was sent. Back to the queue, uncounted — a pause outlasts any
		// requeue bound.
		if errors.Is(err, ErrBalancePaused) {
			returnToQueue(ctx, deps, logger, scene, err, "dispatch: kie account paused, scene returned to the queue")
			return
		}
		// web/lib/spend.ts's pre-flight balance check (part 1b) is a
		// snapshot and always racy: several renders can pass it and still
		// drain the account before kie actually submits this one. This is
		// where the truth arrives — the vendor's own refusal. kie never queued
		// the job, so nothing was billed: close the gate so the next tick
		// claims nothing and the scenes already waiting stop at Admit, then
		// return this scene to the queue instead of failing it.
		if errors.Is(err, kie.ErrInsufficientBalance) {
			pause := deps.Balance.Trip(time.Now())
			logger.Warn("dispatch: account out of credit, pausing dispatch",
				slog.Duration("pause", pause))
			returnToQueue(ctx, deps, logger, scene, err, "dispatch: kie account out of credit, scene returned to the queue")
			return
		}
		failScene(ctx, deps, logger, scene, fmt.Errorf("submit render: %w", err))
		return
	}

	// A submission the router accepted is the only evidence available that the
	// account can pay again — the worker has no balance endpoint (admin
	// scope, which it deliberately does not hold). Clearing here also resets
	// the accumulated backoff, so a process that has been up for months does
	// not meet its next brief outage with an hour-long pause.
	deps.Balance.Clear()
	deps.CapacityRequeues.forget(scene.ID)

	// costAttr, not a bare Float64: when costKnown is false the estimate is
	// still 0, and printing `estimated_cost_usd: 0` says a render that is
	// about to be billed costs nothing. That is precisely the confusion
	// web/lib/kie/rates.ts's header forbids — "unknown is not free and
	// unknown is not fal" — and it was on every production Seedance line,
	// three fields below the ERROR that had just said the rate was missing.
	//
	// fps gets the same treatment for a milder reason: Seedance does not take
	// an fps input at all (SupportsFPSInput false), so `fps: 0` reads as a
	// broken setting rather than an inapplicable one.
	vendor := kie.VendorOf(requestID)
	fields := []any{
		slog.String("model", model.KieModelID),
		slog.String("vendor", vendor),
		slog.Bool("has_audio", model.HasAudio),
		slog.String("resolution", model.Resolution),
		slog.String("kie_task_id", requestID),
	}
	if model.FPS > 0 {
		fields = append(fields, slog.Int("fps", model.FPS))
	}
	if vendor == kie.BytePlusVendor {
		fields = append(fields, slog.String("estimated_cost_usd", "unknown until BytePlus reports completion_tokens"))
	} else if costKnown {
		fields = append(fields, slog.Float64("estimated_cost_usd", estimatedCost))
	} else {
		fields = append(fields, slog.String("estimated_cost_usd", "unknown"))
	}
	logger.Info("dispatch: submitted render", fields...)

	// The router accepted this job; there is no submission to roll back on a
	// MarkRendering failure, only a local bookkeeping problem to log loudly so it gets noticed.
	// The reconcile loop cannot help here since it finds work
	// via kie_task_id, which is exactly what failed to persist.
	if err := markRenderingWithRetry(ctx, deps, scene.ID, requestID); err != nil {
		// Losing the request ID here means reconcile cannot poll for the
		// clip. It is unrecoverable automatically and may already be billable.
		// BytePlus only reports its token bill after completion; the kie
		// estimate is not a safe substitute if the id cannot be persisted.
		wasted := slog.String("wasted_usd", "unknown, BytePlus usage is unavailable")
		if vendor != kie.BytePlusVendor || deps.Config.IsDev() {
			wasted = slog.String("wasted_usd", "unknown, no rate for this model/resolution")
			if costKnown {
				wasted = slog.Float64("wasted_usd", estimatedCost)
			}
		}
		logger.Error("dispatch: submission succeeded but the task id could not be persisted; this render cannot be reconciled automatically",
			slog.String("vendor", vendor),
			slog.String("kie_task_id", requestID),
			wasted,
			slog.String("error", err.Error()),
		)

		// Mark it failed now with the task id in its run row, rather than
		// leaving it stuck in 'rendering' with no task id
		// recorded. Left alone, StaleRendering would eventually find this
		// scene and reconcileScene's nil-KieTaskID branch would mark it
		// failed as "claimed but never submitted" — the vendor did accept
		// the job. Kie can be estimated; BytePlus is marked billing-unknown
		// because its final token count is not available without reconcile.
		failMsg := fmt.Sprintf(
			"%s accepted request %s but the local record of it could not be saved: %v",
			vendor, requestID, err,
		)
		runCost := costOrZeroIfMocked(deps, estimatedCost, costKnown)
		if vendor == kie.BytePlusVendor && !deps.Config.IsDev() {
			// BytePlus charges by completion tokens, which are unavailable
			// without the persisted scene to reconcile.
			failMsg = store.BillingUnknownPrefix + failMsg
			runCost = nil
		}
		billedRun := store.Run{
			ProjectID: scene.ProjectID,
			KieTaskID: &requestID,
			Vendor:    vendor,
			Model:     model.KieModelID,
			// Same rule as ingest.FromResult: a mocked submission was billed
			// nothing, so a failure on that path costs nothing either.
			CostUSD: runCost,
			Error:   &failMsg,
		}
		// recoveryCtx, not ctx: the reason markRenderingWithRetry gave up is
		// usually that ctx is already dead, and this write is the only thing
		// standing between a billed render and a $0 ledger row.
		recCtx, cancel := recoveryCtx(ctx)
		defer cancel()
		if ferr := deps.Store.MarkFailed(recCtx, scene.ID, billedRun); ferr != nil {
			logger.Error("dispatch: mark failed for lost kie task id also failed",
				slog.String("error", ferr.Error()))
		}
	}
}

// markRenderingWithRetry retries the bookkeeping write a few times before
// giving up. A transient database blip between submitting to kie and recording
// the request ID otherwise costs the price of the clip, which is the most
// expensive possible outcome for the cheapest possible failure.
func markRenderingWithRetry(ctx context.Context, deps Deps, sceneID, requestID string) error {
	const attempts = 4

	var err error
	for i := range attempts {
		if err = deps.Store.MarkRendering(ctx, sceneID, requestID); err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return fmt.Errorf("mark rendering: %w", ctx.Err())
		}
		if i < attempts-1 {
			select {
			case <-ctx.Done():
				return fmt.Errorf("mark rendering: %w", ctx.Err())
			case <-time.After(time.Duration(1<<i) * 250 * time.Millisecond):
			}
		}
	}
	return fmt.Errorf("mark rendering after %d attempts: %w", attempts, err)
}

// withSpeech decides whether this submission should carry the scene's spoken
// line, and it is two questions, not one.
//
// model.HasAudio answers the first: will this model generate audio at all.
// It follows AUDIO_ENABLED alone once PickModel lands on a
// SupportsGenerateAudio descriptor — deliberately, since Seedance has no
// per-scene audio route the way Kling does.
//
// scenes.is_talking_head answers the second, and it was missing. With
// AUDIO_ENABLED=1 in production, a B-roll cutaway was handed
// `Dialogue, spoken aloud on camera: "<script line>"` — a hand pouring
// powder into a mug, instructed to speak the voiceover. The model's
// capability said yes and nothing asked whether there was anyone in frame
// to say it.
//
// This gates the DIALOGUE ONLY, not generate_audio, which still follows the
// flag: a silent cutaway with ambient sound is a defensible clip, and
// muting it is a product decision rather than a bug fix. A cutaway reciting
// the voiceover is neither.
func withSpeech(scene store.Scene, model kie.Model) bool {
	return model.HasAudio && scene.IsTalkingHead
}

// uiTagPattern matches the "@name" tokens the /ugc prompt editor uses to
// pick a reference image. Identical to web/lib/elements.ts's TAG_PATTERN —
// no lead-character group.
//
// It USED to carry one: `(^|[^A-Za-z0-9_@-])@(...)`, to leave email addresses
// alone. Consuming that character broke three things at once, all reproduced
// against the real function:
//
//	"@jen@bottle"        -> "@image1@bottle"   a raw '@' survived, because the
//	                                           consumed 'n' left no room for
//	                                           the scan to match at that offset
//	"wide-@jen"          -> unchanged          the '-' failed the lead class, so
//	                                           the tag that ACTUALLY attached the
//	                                           reference never became @image1 —
//	                                           and the editor's own autocomplete
//	                                           produces exactly this shape
//	"josé@example.com"   -> "joséexample.com"  [^A-Za-z0-9_@-] matches any
//	                                           non-ASCII rune, so the email
//	                                           guard only guarded ASCII
//
// The lead is now examined without being consumed, by leadIsWordish below.
var uiTagPattern = regexp.MustCompile(`@([A-Za-z0-9][A-Za-z0-9_-]{0,63})`)

// leadIsWordish reports whether the rune immediately before offset i looks
// like the local part of an email address rather than the start of a tag.
//
// Unicode-aware on purpose: the ASCII-only test this replaces let
// "josé@example.com" through and rewrote it.
func leadIsWordish(prompt string, i int) bool {
	if i == 0 {
		return false
	}
	r, _ := utf8.DecodeLastRuneInString(prompt[:i])
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

// bindUITags rewrites each tag that actually earned a reference into the
// positional tag Seedance understands, and deletes the '@' from every other
// tag in the prompt.
//
//	{jen:1, kitchen:2}:  "@jen in @kitchen"      ->  "@image1 in @image2"
//	{jen:1}:             "@backdrop and @jen"    ->  "backdrop and @image1"
//	{}:                  "@jen at a counter"     ->  "jen at a counter"
//
// BOUND BY NAME, NOT BY TEXT ORDER. An earlier version numbered tags by where
// they appeared in the string, which is wrong in two ways that both end with
// the prompt asserting that @imageN is a picture it is not:
//
//	web/components/ugc-column.tsx resolves the first tag that MATCHES A
//	SAVED ELEMENT, skipping any that match nothing — so "@backdrop @jen"
//	attaches jen while text order would bind @backdrop.
//
//	An explicit picker choice beats every tag, so picking a photo with
//	"@jen" still in the text attaches the photo, not jen.
//
// The worker cannot see either decision — generateClip COPIES the chosen
// image into a fresh asset, severing the link to the element on purpose — so
// the answer is carried in scene_references.tag instead, beside the ordinal
// that says which slot it won. Matched case-insensitively, because
// findElementByTag resolves that way and "@Jen" is the same element as "@jen".
//
// UNBOUND TAGS LOSE THEIR '@' rather than being deleted. A tag naming a
// reference this scene does not carry is a mistake, but the word still reads:
// "and backdrop" is a phrase, "and" is not. What must not survive is the '@',
// which would leave the model an index resolving to nothing.
//
// A VOICE OR VIDEO TAG IS DELETED OUTRIGHT, and it is the one case where
// leaving the word behind is worse than removing it.
//
//	{jen:1}, deleted{voice1}:  "@jen speaking in @voice1"  ->  "@image1 speaking in"
//
// Seedance has no positional syntax for audio — there is no @audio1 — so a
// voice reference cannot be bound to an index the way an image is. It was
// therefore falling through to the unbound branch and arriving as the bare
// word "voice1", which is not a phrase and not a mistake the model can read
// past: it is a name for something already sent by another route entirely,
// sitting in the prose as scene direction. Observed on a real dispatch on
// 2026-09-04: reference_audio_urls carried the clip correctly and the prompt
// read "@image1 speaking in voice1".
//
// VIDEO FOLLOWS THE SAME RULE, added when reference_video_urls started
// carrying the file (0094_video_scene_reference.sql) — but for a different
// reason than the one that used to apply. web/lib/kie-video-describe.ts's
// header, written the same week, still says a video tag "never reaches kie's
// render endpoint" — that premise is exactly what this change ends. What
// does NOT change is that kie's Seedance schema documents exactly one
// positional reference syntax, @image1…N for reference_image_urls (see
// seedanceInput in models.go); nothing in kie's docs establishes an
// equivalent @video1 for reference_video_urls, and inventing one here would
// be the same unverified guess seedanceInput's own header refuses to make
// for a field name. So a video tag that survives to this function — in
// practice only when the element's description hasn't been written yet,
// since actions/ugc.ts's resolveElementTags substitutes a description over
// the tag before the prompt ever reaches this package, exactly as it does
// for images — has no index to bind to and is deleted like a voice tag, not
// because its bytes stay off the render (they don't, now), but because there
// is nowhere verified to point it.
//
// One flanking space goes with it, so deleting a tag does not leave a double
// space where a word used to be. If deleting would empty the prompt entirely
// the bare name is kept instead — a blank prompt is a worse thing to send
// than a stray word, and an operator whose whole prompt is one voice or
// video tag has asked for something this function cannot repair.
func bindUITags(
	prompt string,
	ordinalByTag map[string]int,
	deletedTags map[string]bool,
	roleReferences bool,
) string {
	matches := uiTagPattern.FindAllStringSubmatchIndex(prompt, -1)
	if len(matches) == 0 {
		return prompt
	}

	// []byte rather than strings.Builder: dropping a voice tag has to be able
	// to take the space in front of it back, and a Builder cannot truncate.
	out := make([]byte, 0, len(prompt))
	last := 0
	for _, m := range matches {
		at, end := m[0], m[1]
		name := prompt[m[2]:m[3]]

		out = append(out, prompt[last:at]...)
		if deletedTags[strings.ToLower(name)] {
			// The file is the reference. The word is not.
			//
			// ONE flanking space goes with it, never two, or deleting a word
			// welds its neighbours together. The one in FRONT is preferred,
			// because that is the space the tag was written after — but a tag
			// that opens the prompt has no space in front of it, so the one
			// behind goes instead. Without that second branch a leading voice
			// tag leaves the prompt starting with a space.
			last = end
			if n := len(out); n > 0 && out[n-1] == ' ' && (end >= len(prompt) || prompt[end] == ' ') {
				out = out[:n-1]
			} else if endsBlank(out) && end < len(prompt) && prompt[end] == ' ' {
				last = end + 1
			}
			continue
		}
		if n, ok := ordinalByTag[strings.ToLower(name)]; ok && roleReferences {
			// IDENTITY WINS, wherever it sits — even after a hyphen or a
			// letter. "wide-@jen" is a shape the editor's own autocomplete
			// produces, and refusing it would leave the declaration naming an
			// @image1 the prompt does not contain.
			//
			// ONLY FOR A MODEL THAT READS IT. Kling treats any "@xxx" as a
			// ROLE reference and refuses the submission outright without a
			// kling_elements array, which this product does not send:
			//
			//   code=422 "kling_elements is required when prompt contains
			//   role references like @element_dog."
			//
			// Production, 2026-09-11, three times on one scene. The prompt
			// was "make the @dog dance" and the "@image1" kie objected to
			// was written HERE — the operator never typed it. Falling
			// through to the bare-name branch below is what a model without
			// role references wants: the picture still goes in image_urls,
			// and the word beside it is a word rather than a directive the
			// vendor will reject.
			out = append(out, fmt.Sprintf("@image%d", n)...)
		} else if leadIsWordish(prompt, at) {
			// Almost certainly an email address. Left exactly as written:
			// this token was already going to kie unchanged before any of
			// this existed, so leaving it is the no-op, and mangling an
			// address the operator typed is not.
			out = append(out, prompt[at:end]...)
		} else {
			out = append(out, name...)
		}
		last = end
	}
	out = append(out, prompt[last:]...)

	// A prompt that was nothing but voice tags would now be empty, and an
	// empty prompt is a worse thing to send than a stray word.
	if strings.TrimSpace(string(out)) == "" {
		return prompt
	}
	return string(out)
}

// endsBlank reports whether nothing but whitespace has been written yet — the
// condition under which a deleted tag should take the space AFTER it rather
// than the one before, there being nothing before.
func endsBlank(out []byte) bool {
	return strings.TrimSpace(string(out)) == ""
}

// deletedTagSet is the tags belonging to AUDIO and VIDEO references — the
// ones bindUITags deletes rather than binds, because neither kind has a
// verified positional slot in kie's prompt syntax (see bindUITags's own doc
// comment for why video joins audio here rather than getting an @videoN of
// its own). Separate from ordinalByTag because they answer different
// questions: that map says which slot a tag won, this set says the tag has
// no slot to win and should leave the prose entirely.
//
// Named for what it does, not for one kind it used to be alone: this was
// audioTagSet before 0094_video_scene_reference.sql gave scene_references a
// second kind with the same "no index" property.
func deletedTagSet(refs []store.SceneReference) map[string]bool {
	out := make(map[string]bool, len(refs))
	for _, r := range refs {
		if (r.Kind != "audio" && r.Kind != "video") || r.Tag == nil {
			continue
		}
		if name := strings.ToLower(strings.TrimSpace(*r.Tag)); name != "" {
			out[name] = true
		}
	}
	return out
}

// ordinalByTag maps each reference's snapshotted tag name to the index the
// prompt should use for it. References attached without a tag contribute
// nothing — there is no name for the prompt to have written.
func ordinalByTag(refs []store.SceneReference) map[string]int {
	out := make(map[string]int, len(refs))
	for _, r := range refs {
		if r.Kind != "image" || r.Tag == nil {
			continue
		}
		if name := strings.ToLower(strings.TrimSpace(*r.Tag)); name != "" {
			out[name] = r.Ordinal
		}
	}
	return out
}

// promptForScene picks the best available prompt text for a scene:
// ai_generated_prompt if the operator pressed Refine (0072 — this is the
// text the vendor MUST be sent once it exists, with "@name" tags already
// replaced by Claude's prose), else the operator's own compiled video
// prompt, else the raw script line.
//
// withSpeech is true exactly when the model this scene is about to be
// submitted to will actually generate audio (dispatchScene passes
// model.HasAudio, kie.PickModel's resolved decision — not the raw
// AUDIO_ENABLED flag, since PickModel is what already knows whether this
// particular descriptor supports generate_audio at all). When it is,
// script_line is appended to the prompt as an explicit spoken-dialogue
// instruction.
//
// This is the ONLY place script_line reaches kie for a silent-to-speaking
// model like Seedance: it has no separate "what should the audio say"
// input, so the prompt — the one channel it has for anything — is also the
// only channel for speech. It is deliberately NOT folded into video_prompt
// at compile time. supabase/migrations/0025_seed_template_v6.sql instructs
// the compiler to never put spoken lines in video_prompt, on purpose: a
// quoted/described line in that field used to render as a burned-in
// on-screen caption (see web/lib/claude.ts's applyPronunciationGuide doc
// comment for the same failure mode). That rule must keep holding for every
// silent render — which is most renders, since this is AUDIO_ENABLED-gated
// — so the append happens here, at submit time, on a per-request copy of
// the prompt, rather than by changing what compile.ts writes to
// scenes.video_prompt. One compiled scene therefore serves an
// AUDIO_ENABLED=0 (silent) and an AUDIO_ENABLED=1 (audible) render
// identically, without recompiling.
//
// voice_profile and pronunciation_guide (projects table) are NOT read here.
// They already shape script_line before it ever reaches this function:
// voice_profile steers the compiler's prose (web/lib/claude.ts's
// buildDirectionBlock feeds it to Claude as a generation instruction), and
// pronunciation_guide is spliced into script_line itself as bracketed
// phonetics by applyPronunciationGuide. Both projects.columns are also not
// currently plumbed to the worker at all — store.Scene carries no
// voice_profile/pronunciation_guide field, and ClaimQueuedScenes does not
// join projects for them — so reading them again here would mean adding
// that plumbing for no new effect beyond what script_line already carries.
// THE MODEL, NOT A BOOLEAN LIFTED OFF IT. This took `roleReferences bool`
// for about an hour, and hardcoding `false` at the one call site — which
// would have stripped "@imageN" from every Seedance render this product
// makes — passed the entire suite. The mechanism was tested, the descriptor
// was tested, and the two-word expression joining them was not.
//
// A boolean parameter can be given the wrong value silently. A model cannot
// be given the wrong flag without being a different model, which is a thing
// the tests around it already check.
func promptForScene(
	scene store.Scene,
	refs []store.SceneReference,
	withSpeech bool,
	model kie.Model,
) string {
	base := ""
	switch {
	case scene.AIGeneratedPrompt != nil && *scene.AIGeneratedPrompt != "":
		base = *scene.AIGeneratedPrompt
	case scene.VideoPrompt != nil && *scene.VideoPrompt != "":
		base = *scene.VideoPrompt
	case scene.ScriptLine != nil:
		base = *scene.ScriptLine
	}

	// Before the dialogue append below, not after: what follows is a line to
	// be SPOKEN, quoted verbatim, and rewriting speech is a different act
	// from binding a reference.
	// NO DECLARATION, because this route sends no pictures.
	//
	// There was one — a sentence per reference saying what "@image1" was for,
	// modelled on Higgsfield's own instruction to describe a reference's role
	// at the start of the prompt. It became unreachable the moment /ugc
	// stopped forwarding its references to kie: what Seedance receives is
	// prose Claude already wrote from those pictures at Refine time, so there
	// is no index left to explain. Deleted rather than left in place — an
	// unreachable paragraph asserting "@image1 is the character reference"
	// would tell the next reader something this route does not do.
	//
	// bindUITags still runs, with nothing to bind. An operator who skips
	// Refine leaves "@lena" in the text, and that '@' still has to come off:
	// it names a picture nobody sent.
	//
	// When base came from AIGeneratedPrompt above, this call is a no-op by
	// construction rather than a bug: 0072's whole contract is that Claude
	// already replaced every "@name" tag with prose before the column was
	// written, so ordinalByTag has nothing left in the text to match.
	base = bindUITags(base, ordinalByTag(refs), deletedTagSet(refs), model.SupportsRoleReferences)

	// Only append when there is a real video_prompt to append to and a
	// script_line to speak. When video_prompt is empty, base above already
	// *is* scene.ScriptLine in full — appending it again would just repeat
	// the same sentence twice in one submitted prompt.
	if withSpeech && scene.VideoPrompt != nil && *scene.VideoPrompt != "" &&
		scene.ScriptLine != nil && *scene.ScriptLine != "" {
		base = fmt.Sprintf(`%s Dialogue, spoken aloud on camera: "%s"`, base, *scene.ScriptLine)
	}

	return base
}

// referencePrompt is the scene's own words (video_prompt) with every tag that
// earned a reference bound to BytePlus's positional syntax for its kind:
//
//	{jen: image 1, walking: video 1, voice: audio 1}
//	"@walking with @jen saying hi in @voice" -> "@Video 1 with @Image 1 saying hi in @Audio 1"
//
// N is the reference's ordinal within its kind, which is also its position
// among that kind in the vendor's content array — BytePlus numbers each type
// that way. A tag that earned no reference loses its '@' and stays a word,
// and an email-looking token is left alone, exactly as in bindUITags.
//
// Empty when there is no video_prompt (the scripted route), so the vendor
// falls back to Prompt. The dialogue line is appended the same way
// promptForScene appends it.
func referencePrompt(scene store.Scene, refs []store.SceneReference, withSpeech bool) string {
	if scene.VideoPrompt == nil || strings.TrimSpace(*scene.VideoPrompt) == "" {
		return ""
	}
	prompt := *scene.VideoPrompt
	label := map[string]string{"image": "Image", "video": "Video", "audio": "Audio"}
	bound := make(map[string]string, len(refs))
	for _, r := range refs {
		if r.Tag == nil || label[r.Kind] == "" {
			continue
		}
		if name := strings.ToLower(strings.TrimSpace(*r.Tag)); name != "" {
			bound[name] = fmt.Sprintf("@%s %d", label[r.Kind], r.Ordinal)
		}
	}

	var b strings.Builder
	last := 0
	for _, m := range uiTagPattern.FindAllStringSubmatchIndex(prompt, -1) {
		at, end := m[0], m[1]
		name := prompt[m[2]:m[3]]
		b.WriteString(prompt[last:at])
		switch tag, ok := bound[strings.ToLower(name)]; {
		case ok:
			b.WriteString(tag)
		case leadIsWordish(prompt, at):
			b.WriteString(prompt[at:end])
		default:
			b.WriteString(name)
		}
		last = end
	}
	b.WriteString(prompt[last:])
	out := b.String()

	if withSpeech && scene.ScriptLine != nil && *scene.ScriptLine != "" {
		out = fmt.Sprintf(`%s Dialogue, spoken aloud on camera: "%s"`, out, *scene.ScriptLine)
	}
	return out
}

// failScene marks a claimed scene 'failed', logging both the original
// cause and (if it happens) the failure of the mark-failed write itself —
// a scene that cannot even be marked failed is exactly the kind of stuck
// state the reconcile loop exists to eventually catch via submitted_at,
// but it deserves to be loud here too.
//
// Almost every call site reaching this function failed BEFORE the vendor accepted
// a job: no reference frame to submit, a signing failure, or Submit itself
// erroring without returning a request id (see dispatchScene). None of
// those gets a vendor to start a job, and a request it never started is one
// it cannot have billed for — so the recorded run deliberately
// carries no cost_usd.
//
// The one exception is kie.ErrSubmissionOutcomeUnknown: the submission POST
// was lost or answered ambiguously, so the selected vendor may have accepted and billed the
// job even though this worker holds no request id for it. That run is not a
// free failure and must not be reported as one, but it is not a known charge
// either — cost_usd stays nil (an estimate here would fabricate a charge the vendor
// may never have made) and the error is tagged with store.BillingUnknownPrefix
// so the unresolved ones are queryable. Tagged here rather than at the call
// site because every path into this function that can carry that error routes
// through this one place. (The one dispatch-time failure that IS confidently
// billed — Submit succeeding but the resulting request id failing to
// persist — never reaches this function; see the markRenderingWithRetry
// branch above, which records its own run with a real cost.) model/vendor
// are still recorded even though cost is nil: knowing *what* was attempted
// is worth keeping alongside *what it cost*, and costs nothing to add.
func failScene(ctx context.Context, deps Deps, logger *slog.Logger, scene store.Scene, cause error) {
	deps.CapacityRequeues.forget(scene.ID)
	logger.Error("dispatch: submission failed", slog.String("error", cause.Error()))

	settings, settingsErr := kie.ParseRenderSettings(scene.RenderSettings)
	modelID := settings.Model
	if settingsErr == nil {
		if model, err := kie.PickModel(scene.IsTalkingHead, deps.Config.AudioEnabled, settings); err == nil {
			modelID = model.KieModelID
		}
	}
	errMsg := cause.Error()
	if errors.Is(cause, kie.ErrSubmissionOutcomeUnknown) {
		errMsg = store.BillingUnknownPrefix + errMsg
	}

	run := store.Run{
		ProjectID: scene.ProjectID,
		// This scene never actually reached a vendor (every call site into
		// failScene fails before or at Submit — see this function's doc
		// comment above), so nothing was billed. A vendor-tagged submit error
		// still identifies which vendor this attempt reached.
		Vendor: kie.Vendor,
		Model:  modelID,
		Error:  &errMsg,
	}
	var vendorError interface{ SubmissionVendor() string }
	if errors.As(cause, &vendorError) {
		run.Vendor = vendorError.SubmissionVendor()
	}
	// recoveryCtx for the same reason as the lost-request-id branch above,
	// though less money rides on it: every cause that reaches this function
	// (RefFrameURL, SignedURL, Submit) takes ctx and fails when it is
	// cancelled, so a shutdown mid-dispatch would otherwise mean the
	// mark-failed write is cancelled too. Nothing is misbilled if that
	// happens — none of these paths got a vendor to start a job — but the scene
	// stays in 'rendering' until StaleRendering picks it up 20 minutes later,
	// showing an operator a render that was never running.
	recCtx, cancel := recoveryCtx(ctx)
	defer cancel()
	if err := deps.Store.MarkFailed(recCtx, scene.ID, run); err != nil {
		logger.Error("dispatch: mark failed also failed", slog.String("error", err.Error()))
	}
}

func voiceIDs(voice string) []string {
	if voice == "" {
		return nil
	}
	return []string{voice}
}
