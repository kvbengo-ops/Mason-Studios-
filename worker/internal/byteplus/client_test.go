package byteplus

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ugc-pipeline/worker/internal/kie"
)

// fakeKie records what reached kie, so a test can prove a render did NOT go
// there (or did).
type fakeKie struct {
	submitted []string
	polled    []string
}

func (f *fakeKie) Submit(_ context.Context, req kie.SubmitRequest) (string, error) {
	f.submitted = append(f.submitted, req.KieModelID)
	return "kie-task-1", nil
}

func (f *fakeKie) Status(_ context.Context, id string) (kie.Status, error) {
	f.polled = append(f.polled, id)
	return kie.StatusInProgress, nil
}

func (f *fakeKie) Result(_ context.Context, id string) (kie.Result, error) {
	f.polled = append(f.polled, id)
	return kie.Result{VideoURL: "https://kie.test/clip.mp4"}, nil
}

func (f *fakeKie) BilledUSD(_ context.Context, id string) (*float64, error) {
	f.polled = append(f.polled, id)
	return nil, nil
}

// fakeArk is a fake ModelArk: it records each create body and answers create
// with createStatus/createBody, and every get with task.
type fakeArk struct {
	created      []map[string]any
	createStatus int
	createBody   string
	task         string
}

func (a *fakeArk) client(t *testing.T) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("Authorization = %q, want Bearer test-key", r.Header.Get("Authorization"))
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/contents/generations/tasks":
			b, _ := io.ReadAll(r.Body)
			var body map[string]any
			if err := json.Unmarshal(b, &body); err != nil {
				t.Errorf("create body is not JSON: %v", err)
			}
			a.created = append(a.created, body)
			if a.createStatus != 0 {
				w.WriteHeader(a.createStatus)
				_, _ = io.WriteString(w, a.createBody)
				return
			}
			_, _ = io.WriteString(w, `{"id":"cgt-123"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/contents/generations/tasks/cgt-123":
			_, _ = io.WriteString(w, a.task)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	c := NewClient("test-key", "", srv.Client())
	c.baseURL = srv.URL
	return c
}

func router(k Vendor, c *Client) *Router {
	return &Router{Kie: k, BytePlus: c, Route: true, MaxInflight: 3,
		Inflight: func(context.Context) (int, error) { return 0, nil }}
}

func seedanceRequest() kie.SubmitRequest {
	audio := true
	return kie.SubmitRequest{
		SelectedModelID: kie.BytePlusSeedance25ID,
		KieModelID:      KieSeedance25,
		Prompt:          "a figure walks down a neon street, @image1 in front",
		ReferencePrompt: "@Video 1 walks down a neon street with @Image 1",
		ImageURLs:       []string{"https://s.test/face.png?token=a"},
		VideoURLs:       []string{"https://s.test/walk.mp4?token=b"},
		AudioURLs:       []string{"https://s.test/voice.mp3?token=c"},
		DurationSeconds: 4,
		Resolution:      "480P",
		AspectRatio:     "9:16",
		GenerateAudio:   &audio,
	}
}

func TestRouterSendsSeedance25ToBytePlusAsAReferenceTask(t *testing.T) {
	ark := &fakeArk{task: `{}`}
	k := &fakeKie{}
	r := router(k, ark.client(t))

	id, err := r.Submit(context.Background(), seedanceRequest())
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if id != kie.BytePlusTaskPrefix+"video:cgt-123" {
		t.Errorf("id = %q, want the prefixed BytePlus id with the video marker", id)
	}
	if len(k.submitted) != 0 {
		t.Errorf("kie also received %v — a BytePlus render must not reach kie", k.submitted)
	}

	body := ark.created[0]
	if body["model"] != ModelSeedance25 {
		t.Errorf("model = %v, want %s", body["model"], ModelSeedance25)
	}
	if body["omni_reference_task_type"] != "reference" {
		t.Errorf("omni_reference_task_type = %v, want reference (validated at submit, not after queueing)", body["omni_reference_task_type"])
	}
	if body["resolution"] != "480p" {
		t.Errorf("resolution = %v, want lowercase 480p", body["resolution"])
	}
	if body["duration"] != float64(4) {
		t.Errorf("duration = %v (%T), want the integer 4", body["duration"], body["duration"])
	}
	if body["ratio"] != "9:16" || body["generate_audio"] != true || body["watermark"] != false {
		t.Errorf("ratio/generate_audio/watermark = %v/%v/%v", body["ratio"], body["generate_audio"], body["watermark"])
	}
	if body["execution_expires_after"] != float64(executionExpiresAfterS) {
		t.Errorf("execution_expires_after = %v, want %d", body["execution_expires_after"], executionExpiresAfterS)
	}

	var roles []string
	var text string
	for _, item := range body["content"].([]any) {
		m := item.(map[string]any)
		if role, ok := m["role"].(string); ok {
			roles = append(roles, role)
		} else {
			roles = append(roles, m["type"].(string))
			text, _ = m["text"].(string)
		}
	}
	want := []string{"text", "reference_image", "reference_video", "reference_audio"}
	if strings.Join(roles, ",") != strings.Join(want, ",") {
		t.Errorf("content roles = %v, want %v", roles, want)
	}
	if text != "@Video 1 walks down a neon street with @Image 1" {
		t.Errorf("prompt = %q, want the ReferencePrompt, not kie's description-pasted Prompt", text)
	}
}

func TestPromptFallsBackToKiePromptWithBytePlusSyntax(t *testing.T) {
	req := seedanceRequest()
	req.ReferencePrompt = ""
	if got := promptFor(req); got != "a figure walks down a neon street, @Image 1 in front" {
		t.Errorf("promptFor = %q, want @image1 rewritten to @Image 1", got)
	}
}

func TestTextOnlyRenderSendsNoTaskType(t *testing.T) {
	body := buildCreateRequest(kie.SubmitRequest{Prompt: "a cat"}, ModelSeedance25)
	if body.OmniReferenceTaskType != "" {
		t.Errorf("omni_reference_task_type = %q for a text-only render, want omitted", body.OmniReferenceTaskType)
	}
}

func TestBytePlusPickNeverFallsBackToKieWithoutAKey(t *testing.T) {
	k := &fakeKie{}
	r := &Router{Kie: k}

	if _, err := r.Submit(context.Background(), seedanceRequest()); err == nil || len(k.submitted) != 0 {
		t.Fatalf("err = %v, kie %v; want a failure and nothing on kie", err, k.submitted)
	}
}

func TestDevelopmentMocksTheBytePlusPickThroughKie(t *testing.T) {
	k := &fakeKie{}
	r := &Router{Kie: k, Mock: true}

	if id, err := r.Submit(context.Background(), seedanceRequest()); err != nil || id != "kie-task-1" {
		t.Fatalf("Submit = %q, %v; want the mocked kie id", id, err)
	}
}

func TestRouteOffFailsNewRendersButStillPollsBytePlus(t *testing.T) {
	ark := &fakeArk{task: `{"id":"cgt-123","status":"running"}`}
	k := &fakeKie{}
	r := router(k, ark.client(t))
	r.Route = false

	if _, err := r.Submit(context.Background(), seedanceRequest()); err == nil {
		t.Fatal("Submit succeeded with routing off; want a failure")
	}
	if len(ark.created) != 0 || len(k.submitted) != 0 {
		t.Errorf("BytePlus creates %d, kie submits %v; want neither", len(ark.created), k.submitted)
	}
	if s, err := r.Status(context.Background(), kie.BytePlusTaskPrefix+"cgt-123"); err != nil || s != kie.StatusInProgress {
		t.Errorf("Status of a running BytePlus task with routing off = %v, %v; want it still polled", s, err)
	}
}

func TestRouterKeepsOtherModelsOnKie(t *testing.T) {
	ark := &fakeArk{task: `{}`}
	k := &fakeKie{}
	r := router(k, ark.client(t))

	kling := seedanceRequest()
	kling.SelectedModelID, kling.KieModelID = "kling-3.0-pro", "kling-3.0/video"
	// kie's own Seedance 2.5 shares BytePlus's wire id; only the picked model routes.
	kieSeedance := seedanceRequest()
	kieSeedance.SelectedModelID = "seedance-2.5"
	for _, req := range []kie.SubmitRequest{kling, kieSeedance} {
		if _, err := r.Submit(context.Background(), req); err != nil {
			t.Fatalf("Submit %s: %v", req.SelectedModelID, err)
		}
	}
	if len(ark.created) != 0 || len(k.submitted) != 2 {
		t.Errorf("BytePlus creates %d, kie submits %v; want Kling and kie's Seedance 2.5 on kie only", len(ark.created), k.submitted)
	}
}

// Inflight includes the scene being submitted (it was claimed into
// 'rendering' first), so the cap is exceeded only at MaxInflight+1.
func TestOverMaxInflightTheRenderFailsInsteadOfGoingToKie(t *testing.T) {
	ark := &fakeArk{task: `{}`}
	k := &fakeKie{}
	r := router(k, ark.client(t))
	r.Inflight = func(context.Context) (int, error) { return 4, nil }

	_, err := r.Submit(context.Background(), seedanceRequest())
	if !errors.Is(err, ErrAtCapacity) || !strings.Contains(err.Error(), "try again") {
		t.Fatalf("err = %v; want ErrAtCapacity with a try-again reason", err)
	}
	if len(ark.created) != 0 || len(k.submitted) != 0 {
		t.Errorf("BytePlus creates %d, kie submits %v over the cap; want neither", len(ark.created), k.submitted)
	}
}

// The claim let in exactly MaxInflight scenes, this one among them: every
// one of them must submit. The old count (database + a 15s in-memory window)
// read the third of three as four and refused it.
func TestAClaimAtExactlyTheCapStillSubmits(t *testing.T) {
	ark := &fakeArk{task: `{}`}
	k := &fakeKie{}
	r := router(k, ark.client(t))
	r.Inflight = func(context.Context) (int, error) { return 3, nil }

	for i := 0; i < 3; i++ {
		if _, err := r.Submit(context.Background(), seedanceRequest()); err != nil {
			t.Fatalf("Submit %d at n == MaxInflight: %v", i+1, err)
		}
	}
	if len(ark.created) != 3 || len(k.submitted) != 0 {
		t.Errorf("BytePlus creates %d, kie submits %d; want 3 and 0", len(ark.created), len(k.submitted))
	}
}

func TestMissingInflightCounterFailsClosed(t *testing.T) {
	ark := &fakeArk{task: `{}`}
	k := &fakeKie{}
	r := router(k, ark.client(t))
	r.Inflight = nil
	if _, err := r.Submit(context.Background(), seedanceRequest()); err == nil {
		t.Fatal("Submit succeeded without an in-flight counter; want a failure")
	}
	if len(ark.created) != 0 || len(k.submitted) != 0 {
		t.Errorf("BytePlus creates %d, kie submits %d; want neither", len(ark.created), len(k.submitted))
	}
}

// Only the cap is ErrAtCapacity. A missing key, routing off and BytePlus's own
// refusals keep failing the scene as before, so none may carry it.
func TestOnlyTheCapIsErrAtCapacity(t *testing.T) {
	noKey := router(&fakeKie{}, nil)
	noKey.BytePlus = nil
	_, err := noKey.Submit(context.Background(), seedanceRequest())
	if err == nil || errors.Is(err, ErrAtCapacity) {
		t.Errorf("no key: err = %v; want a failure that is not ErrAtCapacity", err)
	}

	off := router(&fakeKie{}, (&fakeArk{task: `{}`}).client(t))
	off.Route = false
	_, err = off.Submit(context.Background(), seedanceRequest())
	if err == nil || errors.Is(err, ErrAtCapacity) {
		t.Errorf("routing off: err = %v; want a failure that is not ErrAtCapacity", err)
	}

	refused := router(&fakeKie{}, (&fakeArk{createStatus: 404,
		createBody: `{"error":{"code":"ModelNotOpen","message":"not activated"}}`}).client(t))
	_, err = refused.Submit(context.Background(), seedanceRequest())
	if err == nil || errors.Is(err, ErrAtCapacity) {
		t.Errorf("refusal: err = %v; want a failure that is not ErrAtCapacity", err)
	}
}

func TestCapacityAndAccountRefusalsFailAndNeverReachKie(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		want   string
	}{
		{429, `{"error":{"code":"ModelAccountRpmRateLimitExceeded","message":"slow down"}}`, "slow down"},
		{429, `{"error":{"code":"QuotaExceeded","message":"queue full"}}`, "queue full"},
		{403, `{"error":{"code":"AccountOverdueError","message":"balance < 0"}}`, "balance < 0"},
		{404, `{"error":{"code":"ModelNotOpen","message":"not activated"}}`, "not activated"},
	} {
		ark := &fakeArk{createStatus: tc.status, createBody: tc.body}
		k := &fakeKie{}
		r := router(k, ark.client(t))

		_, err := r.Submit(context.Background(), seedanceRequest())
		if err == nil || !strings.Contains(err.Error(), tc.want) || len(k.submitted) != 0 {
			t.Errorf("%d %s: err = %v, kie %v; want BytePlus's reason and nothing on kie", tc.status, tc.body, err, k.submitted)
		}
	}
}

func TestParameterAndSafetyRefusalsFailTheScene(t *testing.T) {
	ark := &fakeArk{createStatus: 400, createBody: `{"error":{"code":"InputImageSensitiveContentDetected.PrivacyInformation","message":"may contain real person"}}`}
	k := &fakeKie{}
	r := router(k, ark.client(t))

	_, err := r.Submit(context.Background(), seedanceRequest())
	if err == nil || len(k.submitted) != 0 {
		t.Fatalf("err = %v, kie %v; want a failure, not a silent kie re-render", err, k.submitted)
	}
	if !strings.Contains(err.Error(), "real person") {
		t.Errorf("err = %q, want it to say a real person was refused", err)
	}
}

func TestLostSubmitIsBillingUnknownAndNeverRetriedOnKie(t *testing.T) {
	ark := &fakeArk{createStatus: http.StatusBadGateway}
	k := &fakeKie{}
	r := router(k, ark.client(t))

	_, err := r.Submit(context.Background(), seedanceRequest())
	if !errors.Is(err, kie.ErrSubmissionOutcomeUnknown) {
		t.Errorf("err = %v, want kie.ErrSubmissionOutcomeUnknown — a 5xx on create may already be billed", err)
	}
	if len(k.submitted) != 0 {
		t.Errorf("kie received %v — BytePlus may already be rendering it; a second render bills twice", k.submitted)
	}
}

func TestMalformedSuccessResponseIsBillingUnknownAndNeverRetriedOnKie(t *testing.T) {
	ark := &fakeArk{createStatus: http.StatusOK, createBody: `{}`}
	k := &fakeKie{}
	r := router(k, ark.client(t))
	_, err := r.Submit(context.Background(), seedanceRequest())
	if !errors.Is(err, kie.ErrSubmissionOutcomeUnknown) {
		t.Errorf("err = %v, want billing-unknown when a successful response has no task id", err)
	}
	if len(k.submitted) != 0 {
		t.Errorf("kie received %v after BytePlus may have accepted the render", k.submitted)
	}
}

func TestSubmitLogRedactsReferenceQueryStrings(t *testing.T) {
	var log bytes.Buffer
	c := &Client{log: slog.New(slog.NewTextHandler(&log, nil))}
	c.logRequest(buildCreateRequest(seedanceRequest(), ModelSeedance25))
	if strings.Contains(log.String(), "token=") || !strings.Contains(log.String(), "redacted") {
		t.Errorf("submit log did not redact reference URL query strings: %s", log.String())
	}
}

func TestRouterRoutesPollsByPrefix(t *testing.T) {
	ark := &fakeArk{task: `{"id":"cgt-123","status":"running"}`}
	k := &fakeKie{}
	r := router(k, ark.client(t))

	if s, err := r.Status(context.Background(), "kie-abc"); err != nil || s != kie.StatusInProgress {
		t.Fatalf("kie Status = %v, %v", s, err)
	}
	if len(k.polled) != 1 || k.polled[0] != "kie-abc" {
		t.Errorf("kie polled %v, want [kie-abc]", k.polled)
	}
	s, err := r.Status(context.Background(), kie.BytePlusTaskPrefix+"cgt-123")
	if err != nil || s != kie.StatusInProgress {
		t.Fatalf("BytePlus Status = %v, %v; want in progress", s, err)
	}
	if len(k.polled) != 1 {
		t.Errorf("a BytePlus id reached kie: %v", k.polled)
	}
}

func TestStatusMapping(t *testing.T) {
	for in, want := range map[string]kie.Status{
		"queued":    kie.StatusInQueue,
		"running":   kie.StatusInProgress,
		"succeeded": kie.StatusCompleted,
		"failed":    kie.StatusFailed,
		"expired":   kie.StatusFailed,
		"cancelled": kie.StatusFailed,
		"something": kie.StatusInProgress,
	} {
		if got := statusOf(in); got != want {
			t.Errorf("statusOf(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestResultAndBillingFromTokens(t *testing.T) {
	// 38,430 tokens at 480p = a 4s 9:16 clip; $6.40/M with a reference video.
	ark := &fakeArk{task: `{"id":"cgt-123","status":"succeeded","resolution":"480p","duration":4,
		"content":{"video_url":"https://ark.test/out.mp4"},"usage":{"completion_tokens":38430}}`}
	r := router(&fakeKie{}, ark.client(t))

	res, err := r.Result(context.Background(), kie.BytePlusTaskPrefix+"video:cgt-123")
	if err != nil {
		t.Fatalf("Result: %v", err)
	}
	if res.VideoURL != "https://ark.test/out.mp4" || res.DurationSeconds != 4 {
		t.Errorf("result = %+v", res)
	}
	want := 38430 / 1e6 * 6.40
	if res.ActualCostUSD == nil || math.Abs(*res.ActualCostUSD-want) > 1e-9 {
		t.Errorf("ActualCostUSD = %v, want %v (reference-video price)", res.ActualCostUSD, want)
	}

	billed, err := r.BilledUSD(context.Background(), kie.BytePlusTaskPrefix+"cgt-123")
	wantNoVideo := 38430 / 1e6 * 10.70
	if err != nil || billed == nil || math.Abs(*billed-wantNoVideo) > 1e-9 {
		t.Errorf("BilledUSD = %v, %v; want %v (no-video price)", billed, err, wantNoVideo)
	}
}

func TestFailedTaskIsNotBilledAndSaysWhy(t *testing.T) {
	ark := &fakeArk{task: `{"id":"cgt-123","status":"failed","error":{"code":"InputVideoSensitiveContentDetected.PrivacyInformation","message":"may contain real person"}}`}
	r := router(&fakeKie{}, ark.client(t))

	billed, err := r.BilledUSD(context.Background(), kie.BytePlusTaskPrefix+"cgt-123")
	if err != nil || billed == nil || *billed != 0 {
		t.Errorf("BilledUSD = %v, %v; want 0 — BytePlus bills only successful videos", billed, err)
	}
	if _, err := r.Result(context.Background(), kie.BytePlusTaskPrefix+"cgt-123"); err == nil {
		t.Error("Result of a failed task returned no error")
	}
	why, err := r.FailureReason(context.Background(), kie.BytePlusTaskPrefix+"cgt-123")
	if err != nil || !strings.Contains(why, "real person") {
		t.Errorf("FailureReason = %q, %v; want the real-face refusal in words", why, err)
	}
	if why, _ := r.FailureReason(context.Background(), "kie-abc"); why != "" {
		t.Errorf("FailureReason for a kie id = %q, want empty", why)
	}
}

func TestVendorOf(t *testing.T) {
	if got := kie.VendorOf(kie.BytePlusTaskPrefix + "cgt-1"); got != kie.BytePlusVendor {
		t.Errorf("VendorOf(byteplus id) = %q", got)
	}
	if got := kie.VendorOf("abc123"); got != kie.Vendor {
		t.Errorf("VendorOf(kie id) = %q", got)
	}
}
