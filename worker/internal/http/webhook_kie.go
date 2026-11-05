package http

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"ugc-pipeline/worker/internal/ingest"
	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/store"
)

// maxWebhookBodyBytes bounds how much of the request body we'll read.
// kie's webhook payload is a small JSON status envelope, not the video
// itself (the video is fetched separately via kie.Client.Result), so this
// is generous headroom against an oversized/malicious body, not a tight fit.
//
// Formerly shared with the fal-specific handler this file's own doc
// comment used to distinguish itself from — webhook.go (handleFalWebhook,
// ingestOnce, and the webhookScenes/webhookResulter interfaces below) was
// deleted when fal.ai was decommissioned, and this became the worker's
// only webhook handler. Nothing here was renamed to drop "Kie" from its
// name (handleKieWebhook, ingestKieOnce, kieWebhookPayload, ...): those
// names are still accurate — this genuinely is kie's webhook — and the
// route stays at /webhooks/kie rather than moving to something
// vendor-neutral like /webhooks, since that path is URL-facing (kie.ai's
// own dashboard is configured to call it) and renaming it is a deploy
// coordination question separate from deleting fal's code.
const maxWebhookBodyBytes = 1 << 20 // 1MB

// webhookScenes is the subset of *store.Store that ingestKieOnce needs to
// look up and finalize a scene by its kie taskId. Kept small and
// interface-typed (rather than passing *store.Store directly) purely so
// idempotency is testable with a fake in-memory store — *store.Store
// already satisfies this structurally, no changes to package store
// required.
type webhookScenes interface {
	SceneByKieTaskID(ctx context.Context, requestID string) (*store.Scene, error)
	MarkFailed(ctx context.Context, sceneID string, run store.Run) error
}

// webhookResulter is the subset of *kie.Client that ingestKieOnce needs.
type webhookResulter interface {
	Result(ctx context.Context, requestID string) (kie.Result, error)
	BilledUSD(ctx context.Context, requestID string) (*float64, error)
}

// kie.ai's actual signing convention, from their published webhook
// verification docs (docs.kie.ai/common-api/webhook-verification), read
// 2026-08-29. This replaced a guess that was wrong in all three of its
// parts — it looked for "X-Kie-Signature", HMAC'd the whole request BODY,
// and compared hex. kie sends two headers, signs a short constructed
// string, and encodes base64.
const (
	kieSignatureHeader = "X-Webhook-Signature"
	kieTimestampHeader = "X-Webhook-Timestamp"
)

// kieTimestampTolerance bounds how old a callback may be.
//
// kie's docs specify no window, and the signed string is taskId.timestamp
// with no body digest — so without a bound, one captured signature stays
// valid forever. The damage is small (this handler re-fetches from
// recordInfo and MarkDone is idempotent, so a replay costs one redundant
// API call, not a bad write), which is why this is generous rather than
// tight: too narrow a window turns ordinary clock skew into the same silent
// 401 that hid this whole problem for six days.
const kieTimestampTolerance = 10 * time.Minute

// handleKieWebhook is kie.ai's render-completion callback: verify the
// signature before doing anything else, be idempotent (a scene already
// 'done' short-circuits), and always return 200 even when something on our
// side goes wrong — a 500 makes kie retry forever, which for a
// permanently-broken payload just multiplies wasted work without ever
// succeeding.
//
// The most important guess this handler embeds: callBackUrl's payload is
// UNVERIFIED to carry no signature at all (see internal/kie/client.go's
// header comment) — meaning kieSignatureHeader/verifyKieSignature below may
// be checking a header kie.ai never sends. That is a SAFE guess to be wrong
// about: verifySignature-shaped code that never sees the header it expects
// just rejects every request (returns false, same as an empty secret), so
// the failure mode of a wrong guess here is "the route 401s everything"
// (loud, immediately obvious in worker logs) rather than "the route trusts
// an attacker-controlled payload" (silent, exactly the failure this
// function exists to prevent).
func (s *Server) handleKieWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxWebhookBodyBytes))
	if err != nil {
		s.logger.Error("kie webhook: read body failed", slog.String("error", err.Error()))
		w.WriteHeader(http.StatusOK) // never make kie retry a body we can't even read.
		return
	}

	// kie signs taskId.timestamp, NOT the body — so the taskId has to be
	// read out of the payload before the signature can be checked at all.
	// This decodes first and trusts nothing: the body is size-limited
	// above, only TaskID is taken from it here, and every other field is
	// re-read from recordInfo after verification rather than believed.
	//
	// The signature covering only taskId.timestamp is also exactly why that
	// re-fetch is not optional. A valid signature proves kie sent SOME
	// callback about this task; it says nothing about the state, URLs, or
	// credit figures in the body accompanying it.
	var payload kieWebhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		s.logger.Error("kie webhook: decode payload failed", slog.String("error", err.Error()))
		w.WriteHeader(http.StatusOK)
		return
	}

	if verified, why := s.checkKieSignature(r, payload.Data.TaskID); !verified {
		// Logged, because the silence was the real problem the first time
		// this route was misconfigured. The three fields separate the three
		// different reasons this returns false, which otherwise look
		// identical from outside: no secret configured at all, a request
		// carrying no signature header (the likely truth if kie simply does
		// not sign), and a real mismatch. Only the last is a security
		// event; the first two are configuration facts nobody can see
		// today.
		//
		// Deliberately not the body or the header VALUE — a rejected payload
		// is attacker-controlled, and this line exists to say which door was
		// locked, not to quote whoever knocked.
		s.logger.Warn("kie webhook: rejected unverified request",
			slog.Bool("secret_configured", s.config.KieWebhookSecret != ""),
			slog.Bool("signature_header_present", r.Header.Get(kieSignatureHeader) != ""),
			slog.Bool("timestamp_header_present", r.Header.Get(kieTimestampHeader) != ""),
			slog.String("signature_header", kieSignatureHeader),
			slog.String("reason", why),
		)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	if payload.Data.TaskID == "" {
		s.logger.Error("kie webhook: payload had no taskId")
		w.WriteHeader(http.StatusOK)
		return
	}

	w.WriteHeader(http.StatusOK)
	go s.processKieWebhook(payload)
}

// kieWebhookPayload is kie.ai's queue webhook envelope — UNVERIFIED, same
// disclaimer as everywhere else in this integration. Field names are
// guessed to mirror internal/kie/client.go's recordInfoResponse shape
// (taskId/state/failMsg), on the theory that a vendor's webhook payload
// usually echoes its own polling response's vocabulary rather than
// inventing a second one. Deliberately NOT parsed for the result itself
// (the video URL): this handler re-fetches via kie.Client.Result rather
// than trusting anything the callback body claims, so a wrong guess about
// the result shape here can never matter — only taskId and state need to
// be right enough to route the lookup and tell success from failure.
// kieWebhookPayload is kie's callback body, and every field it needs lives
// inside `data` rather than at the top level.
//
// THIS IS WHY NO CALLBACK HAS EVER BEEN ACCEPTED. The struct read taskId,
// state and failMsg from the top level, so all three were empty on every
// delivery — and the signature covers taskId.timestamp, so verification was
// refused before anything else could be looked at:
//
//	kie webhook: rejected unverified request  reason="no taskId in the payload to sign"
//
// Every render in production has therefore been picked up by the 45-second
// reconcile poll instead, for as long as this handler has existed. The
// symptom was a WARN line and 45 seconds of latency, which is why a month
// went by: nothing failed, and three plausible explanations (wrong secret,
// wrong timestamp unit, different signed string) all produce the same log.
// The reason string added the day before this fix is what named it.
//
// Shape confirmed against kie's own OpenAPI spec for
// docs.kie.ai/market/bytedance/seedance-2-5 on 2026-09-04:
//
//	{"code":200,"msg":"...","data":{"taskId":"...","state":"success","failMsg":null,...}}
//
// NO TOP-LEVEL FALLBACK. A struct that accepted both shapes would keep
// working if kie moved the field again, and would say nothing while doing
// it — which is exactly how this bug survived. If the shape changes, the
// reason string above should say so on the first delivery.
type kieWebhookPayload struct {
	// Code is the envelope's own result: 200 for a completed task, 501 for a
	// failed one. Not read as the verdict — `data.state` is, because it is
	// the field kie documents as carrying success/fail and the one the
	// polling path already agrees with.
	Code int            `json:"code"`
	Msg  string         `json:"msg"`
	Data kieWebhookData `json:"data"`
}

type kieWebhookData struct {
	TaskID  string `json:"taskId"`
	State   string `json:"state"` // "success" | "fail", per kie's spec.
	FailMsg string `json:"failMsg"`
}

// verifyKieSignature mirrors the shape a signature verifier always takes
// (HMAC-SHA256, constant-time compare, empty-secret-rejects-everything)
// against Config.KieWebhookSecret — see kieSignatureHeader's doc comment
// for why the header itself is an unconfirmed guess.
func (s *Server) verifyKieSignature(r *http.Request, taskID string) bool {
	ok, _ := s.checkKieSignature(r, taskID)
	return ok
}

// checkKieSignature is verifyKieSignature plus the answer to "which of these
// checks was it".
//
// EVERY rejection in production looked identical: secret_configured=true,
// signature_header_present=true, timestamp_header_present=true, and refused
// anyway — for a month, on every callback, while reconcile quietly picked up
// each render 45s late. Three different faults produce that exact line and
// the log could not tell them apart, so the only way to guess was to change
// the secret and wait.
//
// The reason is a fixed string chosen from this function's own branches, not
// anything derived from the request. A rejected payload is attacker-
// controlled, and this exists to say which door was locked, not to quote
// whoever knocked. The one number that does escape is the timestamp's DIGIT
// COUNT, because "kie sends milliseconds and we parse seconds" is a real
// candidate here and is otherwise indistinguishable from a wrong secret: a
// millisecond value parses fine, lands ~50,000 years in the future, and fails
// the window silently.
func (s *Server) checkKieSignature(r *http.Request, taskID string) (bool, string) {
	if s.config.KieWebhookSecret == "" {
		return false, "no secret configured"
	}

	got := r.Header.Get(kieSignatureHeader)
	rawTS := r.Header.Get(kieTimestampHeader)
	if got == "" {
		return false, "no signature header"
	}
	if rawTS == "" {
		return false, "no timestamp header"
	}
	if taskID == "" {
		return false, "no taskId in the payload to sign"
	}

	// Bounded before the HMAC, not after: an out-of-window request is
	// refused on the timestamp alone, so a replay cannot even reach the
	// comparison. Unix SECONDS, per kie's docs.
	seconds, err := strconv.ParseInt(rawTS, 10, 64)
	if err != nil {
		return false, "timestamp is not an integer"
	}
	age := time.Since(time.Unix(seconds, 0))
	if age < -kieTimestampTolerance || age > kieTimestampTolerance {
		return false, fmt.Sprintf(
			"timestamp outside the %s window (%d digits, so %s; age %s)",
			kieTimestampTolerance, len(rawTS), timestampUnitGuess(rawTS), age.Round(time.Second),
		)
	}

	// base64(HMAC-SHA256(taskId + "." + timestamp, secret)) — kie's exact
	// construction. The timestamp is used as the header SENT it, not
	// reformatted from the parsed integer: re-rendering it would change the
	// signed bytes if kie ever pads or zero-prefixes.
	mac := hmac.New(sha256.New, []byte(s.config.KieWebhookSecret))
	mac.Write([]byte(taskID + "." + rawTS))
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	// Constant-time, and NOT case-folded: base64 is case-significant.
	if !hmac.Equal([]byte(got), []byte(want)) {
		// Everything else matched, so this is the secret VALUE or the signed
		// construction. Nothing about either is logged — the point is only
		// that the other doors are eliminated.
		return false, "signature mismatch: wrong secret, or kie signs something other than taskId.timestamp"
	}
	return true, ""
}

// timestampUnitGuess names the unit a timestamp's magnitude implies. Ten
// digits is Unix seconds; thirteen is milliseconds, which this handler would
// read as a date ~50,000 years out and reject on the window with no hint that
// the UNIT was the problem.
func timestampUnitGuess(raw string) string {
	switch n := len(raw); {
	case n >= 13:
		return "probably MILLISECONDS, which this code reads as seconds"
	case n >= 10:
		return "seconds, as expected"
	default:
		return "too short to be a Unix timestamp"
	}
}

// processKieWebhook does the actual ingest work asynchronously: look up the
// scene, check idempotency, and either fetch+ingest the result or mark the
// scene failed.
//
// r.Context() is cancelled the moment the handler returns (which already
// happened, by design, before this goroutine was spawned), so this
// deliberately uses a fresh background context rather than one tied to the
// original request.
func (s *Server) processKieWebhook(payload kieWebhookPayload) {
	s.webhookSem <- struct{}{}
	defer func() { <-s.webhookSem }()

	if s.kie == nil {
		// Reachable only if a request somehow passed verifyKieSignature
		// (i.e. KieWebhookSecret is set) while s.kie is nil — a test-built
		// Server, or a hand-constructed one; cmd/worker/main.go always
		// constructs a real kie.Client (KieAPIKey is a required config var).
		// Logged loudly rather than panicking: this is a configuration
		// mismatch, not a code invariant violation.
		s.logger.Error("kie webhook: verified but no kie client is configured")
		return
	}

	ingestKieOnce(context.Background(), s.logger, s.store, s.kie, payload, s.config.AudioEnabled, func(ctx context.Context, scene store.Scene, result kie.Result) error {
		return ingest.FromResult(ctx, ingest.Deps{Store: s.store, Config: s.config, Media: s.media, Logger: s.logger}, scene, result)
	})
}

// ingestKieOnce holds the idempotent decision logic shared by the real
// handler and its tests: look the scene up by taskId (both fal's old
// request_id and kie's taskId are stored in the same scenes.kie_task_id
// / runs.kie_task_id column — see store.Scene.KieTaskID's doc
// comment for why that fal-named column is reused rather than renamed),
// bail if it's already 'done', mark it failed on a failure payload, or
// fetch the result and hand it to doIngest exactly once.
//
// audioEnabled is threaded through explicitly (rather than read off a
// config struct here) so ingestKieOnce stays testable without constructing
// a full config.Config — it must match whatever kie.PickModel used to
// submit the render in the first place, since PickModel's model choice is
// also how the correct kie result is fetched below.
func ingestKieOnce(ctx context.Context, logger *slog.Logger, scenes webhookScenes, resulter webhookResulter, payload kieWebhookPayload, audioEnabled bool, doIngest func(context.Context, store.Scene, kie.Result) error) {
	logger = logger.With(slog.String("kie_task_id", payload.Data.TaskID))

	scene, err := scenes.SceneByKieTaskID(ctx, payload.Data.TaskID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			logger.Warn("kie webhook: no scene for taskId")
			return
		}
		logger.Error("kie webhook: scene lookup failed", slog.String("error", err.Error()))
		return
	}

	if scene.Status == "done" {
		return
	}

	// UNVERIFIED which of kie's guessed states this webhook actually
	// carries terminally — see internal/kie/client.go's statusFromState.
	// Anything that isn't literally "success" is treated as a failure
	// rather than left pending, the safer of the two wrong guesses: a
	// webhook that arrived at all means kie considers the task done one way
	// or the other, so treating an unrecognized terminal state as "still
	// working" would strand the scene in 'rendering' with no further
	// callback ever coming.
	if payload.Data.State != "success" {
		reason := payload.Data.FailMsg
		if reason == "" {
			reason = "kie reported state " + payload.Data.State
		}

		settings, settingsErr := kie.ParseRenderSettings(scene.RenderSettings)
		model, modelErr := kie.PickModel(scene.IsTalkingHead, audioEnabled, settings)
		// On a failed render this estimate is the final recorded cost
		// (nothing overwrites it the way a vendor-reported ActualCostUSD
		// does on success), so cost staying nil rather than a fabricated
		// number matters here the same way it does in dispatch.go's
		// failScene — see kie.EstimateCost's own doc comment.
		cost, costKnown := kie.EstimateCost(model, scene.DurationS)
		var costPtr *float64
		if settingsErr == nil && modelErr == nil && costKnown {
			costPtr = &cost
		} else {
			logger.Error("kie webhook: cost estimate unavailable; no rate for this model at this audio tier",
				slog.String("model", model.ID),
				slog.String("resolution", model.Resolution),
				slog.Bool("has_audio", model.HasAudio),
				slog.String("reason", kie.MissingRateReason(model)))
		}

		if payload.Data.State == "fail" {
			costPtr = kie.FailedRunCost(ctx, resulter, payload.Data.TaskID, costPtr)
		}
		run := store.Run{
			ProjectID: scene.ProjectID,
			KieTaskID: &payload.Data.TaskID,
			Vendor:    kie.Vendor,
			Model:     model.KieModelID,
			CostUSD:   costPtr,
			Error:     &reason,
		}
		if err := scenes.MarkFailed(ctx, scene.ID, run); err != nil {
			logger.Error("kie webhook: mark failed failed", slog.String("error", err.Error()))
		}
		return
	}

	result, err := resulter.Result(ctx, payload.Data.TaskID)
	if err != nil {
		// Leave the scene in 'rendering' — the reconcile loop will retry
		// this same fetch once the scene shows up as stale.
		logger.Error("kie webhook: fetch kie result failed", slog.String("error", err.Error()))
		return
	}

	if err := doIngest(ctx, *scene, result); err != nil {
		logger.Error("kie webhook: ingest failed", slog.String("error", err.Error()))
		return
	}
	logger.Info("kie webhook: ingested render")
}
