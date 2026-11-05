package http

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ugc-pipeline/worker/internal/config"
	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/store"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fakeWebhookScenes is an in-memory stand-in for *store.Store's
// SceneByKieTaskID/MarkFailed, so idempotency can be exercised without a
// real Postgres connection. Moved here from the fal-era webhook_test.go
// (deleted alongside handleFalWebhook/ingestOnce when fal was
// decommissioned) — this is now the only webhook handler, so there is only
// one place left for its own test doubles to live.
type fakeWebhookScenes struct {
	scene          *store.Scene
	markFailedRuns []store.Run
}

func (f *fakeWebhookScenes) SceneByKieTaskID(ctx context.Context, requestID string) (*store.Scene, error) {
	if f.scene == nil || f.scene.KieTaskID == nil || *f.scene.KieTaskID != requestID {
		return nil, store.ErrNotFound
	}
	cp := *f.scene
	return &cp, nil
}

func (f *fakeWebhookScenes) MarkFailed(ctx context.Context, sceneID string, run store.Run) error {
	f.markFailedRuns = append(f.markFailedRuns, run)
	f.scene.Status = "failed"
	return nil
}

type fakeResulter struct{}

func (fakeResulter) Result(ctx context.Context, requestID string) (kie.Result, error) {
	return kie.Result{VideoURL: "https://cdn.kie.ai/video.mp4", DurationSeconds: 8}, nil
}

func (fakeResulter) BilledUSD(ctx context.Context, requestID string) (*float64, error) {
	return nil, nil
}

// ---------------------------------------------------------------------------
// signature verification
// ---------------------------------------------------------------------------

// kieSign builds the signature kie actually sends:
// base64(HMAC-SHA256(taskId + "." + timestamp, secret)). Deliberately a
// second implementation of the construction rather than a call into the
// handler's own — a test that signs with the code under test agrees with
// itself no matter how wrong both are, which is how the previous guess
// (hex over the whole body, "X-Kie-Signature") passed four tests while
// matching nothing kie sends.
func kieSign(secret, taskID, timestamp string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(taskID + "." + timestamp))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func kieReq(taskID, timestamp, signature string) *http.Request {
	req := httptest.NewRequest("POST", "/webhooks/kie",
		bytes.NewReader([]byte(`{"taskId":"`+taskID+`"}`)))
	if signature != "" {
		req.Header.Set(kieSignatureHeader, signature)
	}
	if timestamp != "" {
		req.Header.Set(kieTimestampHeader, timestamp)
	}
	return req
}

func nowUnix() string { return strconv.FormatInt(time.Now().Unix(), 10) }

func TestVerifyKieSignature_Valid(t *testing.T) {
	s := &Server{config: &config.Config{KieWebhookSecret: "shh"}, logger: testLogger()}
	ts := nowUnix()

	if !s.verifyKieSignature(kieReq("abc", ts, kieSign("shh", "abc", ts)), "abc") {
		t.Fatal("verifyKieSignature() = false, want true for kie's own construction")
	}
}

// Each of these is a way the previous guess was wrong. They fail against
// that guess and pass against kie's documented scheme, which is the only
// reason to trust the new one.
func TestVerifyKieSignature_RejectsTheOldGuess(t *testing.T) {
	s := &Server{config: &config.Config{KieWebhookSecret: "shh"}, logger: testLogger()}
	ts := nowUnix()
	body := []byte(`{"taskId":"abc"}`)

	t.Run("hex encoding instead of base64", func(t *testing.T) {
		mac := hmac.New(sha256.New, []byte("shh"))
		mac.Write([]byte("abc." + ts))
		if s.verifyKieSignature(kieReq("abc", ts, hex.EncodeToString(mac.Sum(nil))), "abc") {
			t.Fatal("hex-encoded signature accepted; kie sends base64")
		}
	})

	t.Run("signing the body instead of taskId.timestamp", func(t *testing.T) {
		mac := hmac.New(sha256.New, []byte("shh"))
		mac.Write(body)
		if s.verifyKieSignature(kieReq("abc", ts, base64.StdEncoding.EncodeToString(mac.Sum(nil))), "abc") {
			t.Fatal("body-signed signature accepted; kie signs taskId.timestamp")
		}
	})

	t.Run("case-folded, as the hex comparison used to be", func(t *testing.T) {
		// base64 is case-significant. Lowercasing a valid signature must not
		// still match — the old code applied strings.ToLower, which would
		// have corrupted every real kie signature.
		lower := strings.ToLower(kieSign("shh", "abc", ts))
		valid := kieSign("shh", "abc", ts)
		if lower == valid {
			t.Skip("signature happened to contain no uppercase; nothing to prove here")
		}
		if s.verifyKieSignature(kieReq("abc", ts, lower), "abc") {
			t.Fatal("case-folded signature accepted; base64 is case-significant")
		}
	})
}

func TestVerifyKieSignature_Invalid(t *testing.T) {
	s := &Server{config: &config.Config{KieWebhookSecret: "shh"}, logger: testLogger()}
	ts := nowUnix()

	if s.verifyKieSignature(kieReq("abc", ts, kieSign("wrong-secret", "abc", ts)), "abc") {
		t.Fatal("verifyKieSignature() = true, want false for a wrongly-signed request")
	}
}

// The signature covers the taskId, so a captured signature must not carry
// over to a different task.
func TestVerifyKieSignature_WrongTaskID(t *testing.T) {
	s := &Server{config: &config.Config{KieWebhookSecret: "shh"}, logger: testLogger()}
	ts := nowUnix()

	if s.verifyKieSignature(kieReq("other", ts, kieSign("shh", "abc", ts)), "other") {
		t.Fatal("a signature for task abc was accepted for task other")
	}
}

func TestVerifyKieSignature_MissingHeaders(t *testing.T) {
	s := &Server{config: &config.Config{KieWebhookSecret: "shh"}, logger: testLogger()}
	ts := nowUnix()

	if s.verifyKieSignature(kieReq("abc", ts, ""), "abc") {
		t.Fatal("accepted a request with no signature header")
	}
	// The timestamp is half the signed string; without it there is nothing
	// to verify against, and guessing "now" would make every replay valid.
	if s.verifyKieSignature(kieReq("abc", "", kieSign("shh", "abc", ts)), "abc") {
		t.Fatal("accepted a request with no timestamp header")
	}
}

// Nothing in the signed string is a body digest, so one captured signature
// would otherwise stay valid forever.
func TestVerifyKieSignature_StaleTimestamp(t *testing.T) {
	s := &Server{config: &config.Config{KieWebhookSecret: "shh"}, logger: testLogger()}

	old := strconv.FormatInt(time.Now().Add(-2*kieTimestampTolerance).Unix(), 10)
	if s.verifyKieSignature(kieReq("abc", old, kieSign("shh", "abc", old)), "abc") {
		t.Fatal("accepted a correctly-signed but stale callback")
	}

	future := strconv.FormatInt(time.Now().Add(2*kieTimestampTolerance).Unix(), 10)
	if s.verifyKieSignature(kieReq("abc", future, kieSign("shh", "abc", future)), "abc") {
		t.Fatal("accepted a correctly-signed callback from the future")
	}

	// Ordinary clock skew must still pass — too tight a window recreates the
	// silent 401 this whole change exists to end.
	skewed := strconv.FormatInt(time.Now().Add(-kieTimestampTolerance/2).Unix(), 10)
	if !s.verifyKieSignature(kieReq("abc", skewed, kieSign("shh", "abc", skewed)), "abc") {
		t.Fatal("rejected a callback within the tolerance window")
	}
}

func TestVerifyKieSignature_GarbageTimestamp(t *testing.T) {
	s := &Server{config: &config.Config{KieWebhookSecret: "shh"}, logger: testLogger()}

	if s.verifyKieSignature(kieReq("abc", "not-a-number", kieSign("shh", "abc", "not-a-number")), "abc") {
		t.Fatal("accepted an unparseable timestamp")
	}
}

// An unconfigured KieWebhookSecret must reject everything rather than treat
// a missing secret as "accept anything".
func TestVerifyKieSignature_EmptySecret(t *testing.T) {
	s := &Server{config: &config.Config{KieWebhookSecret: ""}, logger: testLogger()}
	ts := nowUnix()

	if s.verifyKieSignature(kieReq("abc", ts, kieSign("", "abc", ts)), "abc") {
		t.Fatal("verifyKieSignature() = true, want false when the configured secret is empty")
	}
}

// ---------------------------------------------------------------------------
// idempotency — mirrors webhook_test.go's ingestOnce tests, reusing the
// same fakeWebhookScenes/fakeResulter doubles since kie's version of this
// logic (ingestKieOnce) shares the same store.webhookScenes/webhookResulter
// seams, keyed by taskId instead of fal's request_id.
// ---------------------------------------------------------------------------

func TestIngestKieOnce_SameTaskIDTwice_IngestsOnce(t *testing.T) {
	taskID := "task-123"
	scenes := &fakeWebhookScenes{
		scene: &store.Scene{ID: "scene-1", Status: "rendering", KieTaskID: &taskID},
	}

	var ingestCount int32
	doIngest := func(ctx context.Context, scene store.Scene, result kie.Result) error {
		atomic.AddInt32(&ingestCount, 1)
		scenes.scene.Status = "done"
		return nil
	}

	payload := kieWebhookPayload{Data: kieWebhookData{TaskID: taskID, State: "success"}}

	ingestKieOnce(context.Background(), testLogger(), scenes, fakeResulter{}, payload, false, doIngest)
	ingestKieOnce(context.Background(), testLogger(), scenes, fakeResulter{}, payload, false, doIngest)

	if got := atomic.LoadInt32(&ingestCount); got != 1 {
		t.Fatalf("doIngest called %d times for two deliveries of the same taskId, want 1", got)
	}
	if scenes.scene.Status != "done" {
		t.Fatalf("scene status = %q, want %q", scenes.scene.Status, "done")
	}
}

// TestIngestKieOnce_FailureState_MarksFailedNotIngested mirrors
// TestIngestOnce_FailurePayload_MarksFailedNotIngested (webhook_test.go): a
// non-"success" state must mark the scene failed with a billed run, not
// ingest, and not silently drop the failure.
func TestIngestKieOnce_FailureState_MarksFailedNotIngested(t *testing.T) {
	taskID := "task-456"
	scenes := &fakeWebhookScenes{
		scene: &store.Scene{ID: "scene-2", Status: "rendering", KieTaskID: &taskID},
	}

	var ingestCount int32
	doIngest := func(ctx context.Context, scene store.Scene, result kie.Result) error {
		atomic.AddInt32(&ingestCount, 1)
		return nil
	}

	payload := kieWebhookPayload{Data: kieWebhookData{TaskID: taskID, State: "fail", FailMsg: "vendor rejected the prompt"}}
	ingestKieOnce(context.Background(), testLogger(), scenes, fakeResulter{}, payload, false, doIngest)

	if got := atomic.LoadInt32(&ingestCount); got != 0 {
		t.Fatalf("doIngest called %d times for a failure state, want 0", got)
	}
	if scenes.scene.Status != "failed" {
		t.Fatalf("scene status = %q, want %q", scenes.scene.Status, "failed")
	}
	if len(scenes.markFailedRuns) != 1 {
		t.Fatalf("MarkFailed received %d runs, want 1", len(scenes.markFailedRuns))
	}
	run := scenes.markFailedRuns[0]
	if run.KieTaskID == nil || *run.KieTaskID != taskID {
		t.Errorf("MarkFailed run.KieTaskID = %v, want %q", run.KieTaskID, taskID)
	}
	if run.Error == nil || *run.Error != "vendor rejected the prompt" {
		t.Errorf("MarkFailed run.Error = %v, want the vendor's failMsg", run.Error)
	}
}

// TestIngestKieOnce_UnknownTaskID_NoOp mirrors
// TestIngestOnce_UnknownRequestID_NoOp: a webhook for a taskId this worker
// has no scene for must be a silent no-op, not an error or a crash — the
// same shape as a duplicate/late fal delivery for a scene already cleaned
// up.
func TestIngestKieOnce_UnknownTaskID_NoOp(t *testing.T) {
	scenes := &fakeWebhookScenes{scene: nil}

	var ingestCount int32
	doIngest := func(ctx context.Context, scene store.Scene, result kie.Result) error {
		atomic.AddInt32(&ingestCount, 1)
		return nil
	}

	payload := kieWebhookPayload{Data: kieWebhookData{TaskID: "does-not-exist", State: "success"}}
	ingestKieOnce(context.Background(), testLogger(), scenes, fakeResulter{}, payload, false, doIngest)

	if got := atomic.LoadInt32(&ingestCount); got != 0 {
		t.Fatalf("doIngest called %d times for an unknown taskId, want 0", got)
	}
}

// The rejection was silent for six days. Production logs showed only
// "reconcile: ingested render whose webhook never arrived" on the other
// side, which reads as "the vendor never called" — and a live probe
// disproved that: an unsigned POST to this route returns 401, not 404, so
// kie was calling and being turned away. These pin that the door says which
// lock stopped it.
//
// BOTH HALVES ARE FIXED NOW. This side says why it refused; the reconcile
// side stopped claiming to know why it had work to do — it reads "ingested a
// render the webhook path had not" as of 2026-09-03, after that exact pair of
// lines appeared thirty seconds apart for one task and still invited the same
// wrong conclusion. The old string is quoted above as history, not as
// something to grep for.
func TestKieWebhookLogsWhyItRejected(t *testing.T) {
	cases := []struct {
		name              string
		secret            string
		setSignature      bool
		wantSecretSet     bool
		wantHeaderPresent bool
	}{
		// The three reasons verifyKieSignature returns false, which are
		// indistinguishable from outside the process and have completely
		// different fixes: set a secret, learn kie's signing scheme, or
		// investigate a genuine mismatch.
		{"no secret configured", "", true, false, true},
		{"no signature header", "shh", false, true, false},
		{"neither", "", false, false, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			s := &Server{
				config: &config.Config{KieWebhookSecret: tc.secret},
				logger: slog.New(slog.NewTextHandler(&buf, nil)),
			}
			body := []byte(`{"taskId":"abc"}`)
			req := httptest.NewRequest("POST", "/webhooks/kie", bytes.NewReader(body))
			if tc.setSignature {
				req.Header.Set(kieSignatureHeader, "not-a-real-signature")
			}
			rec := httptest.NewRecorder()

			s.handleKieWebhook(rec, req)

			if rec.Code != 401 {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
			out := buf.String()
			if !strings.Contains(out, "rejected unverified request") {
				t.Fatalf("rejection was not logged at all:\n%s", out)
			}
			if want := "secret_configured=" + strconv.FormatBool(tc.wantSecretSet); !strings.Contains(out, want) {
				t.Fatalf("missing %q in:\n%s", want, out)
			}
			if want := "signature_header_present=" + strconv.FormatBool(tc.wantHeaderPresent); !strings.Contains(out, want) {
				t.Fatalf("missing %q in:\n%s", want, out)
			}
			// The rejected body is attacker-controlled; this line says which
			// door was locked, never what was knocking.
			if strings.Contains(out, "not-a-real-signature") {
				t.Fatalf("logged the rejected signature value:\n%s", out)
			}
		})
	}
}
