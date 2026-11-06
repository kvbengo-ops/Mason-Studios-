package byteplus

import (
	"context"
	"encoding/json"
	"errors"
	"io"
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

// server is a fake ModelArk: it records the create body and answers every
// get with `task`.
func server(t *testing.T, task string) (*Client, *map[string]any) {
	t.Helper()
	var created map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("Authorization = %q, want Bearer test-key", r.Header.Get("Authorization"))
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/contents/generations/tasks":
			b, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(b, &created); err != nil {
				t.Errorf("create body is not JSON: %v", err)
			}
			_, _ = io.WriteString(w, `{"id":"cgt-123"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/contents/generations/tasks/cgt-123":
			_, _ = io.WriteString(w, task)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	c := NewClient("test-key", srv.Client())
	c.baseURL = srv.URL
	return c, &created
}

func seedanceRequest() kie.SubmitRequest {
	audio := true
	return kie.SubmitRequest{
		KieModelID:      KieSeedance25,
		Prompt:          "a figure walks down a neon street",
		ImageURLs:       []string{"https://s.test/face.png?token=a"},
		VideoURLs:       []string{"https://s.test/walk.mp4?token=b"},
		AudioURLs:       []string{"https://s.test/voice.mp3?token=c"},
		DurationSeconds: 4,
		Resolution:      "480P",
		AspectRatio:     "9:16",
		GenerateAudio:   &audio,
	}
}

func TestRouterSendsSeedance25ToBytePlusWithReferenceRoles(t *testing.T) {
	c, created := server(t, `{}`)
	k := &fakeKie{}
	r := Router{Kie: k, BytePlus: c}

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

	body := *created
	if body["model"] != ModelSeedance25 {
		t.Errorf("model = %v, want %s", body["model"], ModelSeedance25)
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
	for _, item := range body["content"].([]any) {
		m := item.(map[string]any)
		if role, ok := m["role"].(string); ok {
			roles = append(roles, role)
		} else {
			roles = append(roles, m["type"].(string))
		}
	}
	want := []string{"text", "reference_image", "reference_video", "reference_audio"}
	if strings.Join(roles, ",") != strings.Join(want, ",") {
		t.Errorf("content roles = %v, want %v", roles, want)
	}
	for _, role := range roles {
		if role == "first_frame" || role == "last_frame" {
			t.Errorf("sent %s — BytePlus refuses frame roles mixed with reference roles", role)
		}
	}
}

func TestRouterKeepsEverythingOnKieWithoutAKey(t *testing.T) {
	k := &fakeKie{}
	r := Router{Kie: k}

	id, err := r.Submit(context.Background(), seedanceRequest())
	if err != nil || id != "kie-task-1" {
		t.Fatalf("Submit = %q, %v; want kie's id", id, err)
	}
	if len(k.submitted) != 1 {
		t.Errorf("kie submissions = %v, want the one Seedance render", k.submitted)
	}
}

func TestRouterKeepsOtherModelsOnKie(t *testing.T) {
	c, created := server(t, `{}`)
	k := &fakeKie{}
	r := Router{Kie: k, BytePlus: c}

	req := seedanceRequest()
	req.KieModelID = "kling-3.0/video"
	if _, err := r.Submit(context.Background(), req); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if *created != nil {
		t.Errorf("BytePlus received %v for a non-Seedance-2.5 model", *created)
	}
	if len(k.submitted) != 1 {
		t.Errorf("kie submissions = %v, want the Kling render", k.submitted)
	}
}

func TestRouterRoutesPollsByPrefix(t *testing.T) {
	c, _ := server(t, `{"id":"cgt-123","status":"running"}`)
	k := &fakeKie{}
	r := Router{Kie: k, BytePlus: c}

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
	c, _ := server(t, `{"id":"cgt-123","status":"succeeded","resolution":"480p","duration":4,
		"content":{"video_url":"https://ark.test/out.mp4"},"usage":{"completion_tokens":38430}}`)
	r := Router{Kie: &fakeKie{}, BytePlus: c}

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

func TestFailedTaskIsNotBilled(t *testing.T) {
	c, _ := server(t, `{"id":"cgt-123","status":"failed","error":{"code":"InvalidParameter","message":"bad"}}`)
	r := Router{Kie: &fakeKie{}, BytePlus: c}

	billed, err := r.BilledUSD(context.Background(), kie.BytePlusTaskPrefix+"cgt-123")
	if err != nil || billed == nil || *billed != 0 {
		t.Errorf("BilledUSD = %v, %v; want 0 — BytePlus bills only successful videos", billed, err)
	}
	if _, err := r.Result(context.Background(), kie.BytePlusTaskPrefix+"cgt-123"); err == nil {
		t.Error("Result of a failed task returned no error")
	}
}

func TestLostSubmitIsBillingUnknown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(srv.Close)
	c := NewClient("test-key", srv.Client())
	c.baseURL = srv.URL
	r := Router{Kie: &fakeKie{}, BytePlus: c}

	_, err := r.Submit(context.Background(), seedanceRequest())
	if !errors.Is(err, kie.ErrSubmissionOutcomeUnknown) {
		t.Errorf("err = %v, want kie.ErrSubmissionOutcomeUnknown — a 5xx on create may already be billed", err)
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
