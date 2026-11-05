package kie

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newTestClient(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	c := NewClient("test-key", false, srv.Client(), "")
	c.baseURL = srv.URL
	return c
}

// TestClient_Submit_Success pins the UNVERIFIED request shape this file's
// header comment describes: POST .../createTask with a Bearer auth header
// and {model, input, callBackUrl}. If kie.ai's real shape differs, this test
// is the thing to update once a probe confirms it — see the header comment
// on exactly which parts are guesses.
func TestClient_Submit_Success(t *testing.T) {
	var gotAuth, gotPath string
	var gotBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 200,
			"msg":  "success",
			"data": map[string]string{"taskId": "task-123"},
		})
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	id, err := c.Submit(context.Background(), SubmitRequest{
		KieModelID:      "bytedance/seedance-2-5",
		Prompt:          "a dog skateboarding",
		ImageURL:        "https://example.com/frame.png",
		DurationSeconds: 6,
		WebhookURL:      "https://worker.example.com/webhooks/kie",
	})
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	if id != "task-123" {
		t.Errorf("Submit() = %q, want %q", id, "task-123")
	}
	if gotAuth != "Bearer test-key" {
		t.Errorf("Authorization header = %q, want %q", gotAuth, "Bearer test-key")
	}
	if gotPath != "/api/v1/jobs/createTask" {
		t.Errorf("path = %q, want %q", gotPath, "/api/v1/jobs/createTask")
	}
	if gotBody["model"] != "bytedance/seedance-2-5" {
		t.Errorf("request body model = %v, want kie's own id %q", gotBody["model"], "bytedance/seedance-2-5")
	}
	if gotBody["callBackUrl"] != "https://worker.example.com/webhooks/kie" {
		t.Errorf("request body callBackUrl = %v, want the webhook url", gotBody["callBackUrl"])
	}
	input, ok := gotBody["input"].(map[string]any)
	if !ok {
		t.Fatalf("request body input = %v, want a map", gotBody["input"])
	}
	// reference_image_urls, not image_urls. The old name came from the fal
	// era and appears nowhere in kie's schema for bytedance/seedance-2-5 —
	// see seedanceInput's doc comment for why the rename is a design
	// choice (reference_image_urls is what "@image1" indexes into).
	//
	// KLING KEEPS image_urls, and the Kling test below still asserts it:
	// kie documents that name for kling-3.0/video. The two models
	// genuinely disagree, which is why BuildInput is per-model.
	imageURLs, ok := input["reference_image_urls"].([]any)
	if !ok || len(imageURLs) != 1 || imageURLs[0] != "https://example.com/frame.png" {
		t.Errorf("input[reference_image_urls] = %v, want a one-element array with the reference frame", input["reference_image_urls"])
	}
	if _, stale := input["image_urls"]; stale {
		t.Errorf("seedance input still carries the fal-era image_urls key: %v", input["image_urls"])
	}
	if input["prompt"] != "a dog skateboarding" {
		t.Errorf("input[prompt] = %v", input["prompt"])
	}
}

func TestClient_SubmitUploadsLoopbackImageReferences(t *testing.T) {
	const uploadedURL = "https://tempfile.redpandaai.co/kieai/image.png"
	var uploads int
	var submittedImages []any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/storage/v1/object/sign/media/reference.png":
			_, _ = w.Write([]byte("image bytes"))
		case "/api/file-stream-upload":
			uploads++
			if r.Header.Get("Authorization") != "Bearer test-key" {
				t.Errorf("upload Authorization = %q", r.Header.Get("Authorization"))
			}
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Errorf("parse Kie upload form: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if r.FormValue("uploadPath") != "images/ugc-reference" || r.FormValue("fileName") != "reference.png" {
				t.Errorf("upload fields = %v", r.MultipartForm.Value)
			}
			file, _, err := r.FormFile("file")
			if err != nil {
				t.Errorf("uploaded file missing: %v", err)
			} else {
				data, _ := io.ReadAll(file)
				_ = file.Close()
				if string(data) != "image bytes" {
					t.Errorf("uploaded file = %q", data)
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": true,
				"code":    200,
				"data":    map[string]string{"downloadUrl": uploadedURL},
			})
		case "/api/v1/jobs/createTask":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode submit body: %v", err)
				return
			}
			input := body["input"].(map[string]any)
			submittedImages = input["image_urls"].([]any)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 200,
				"data": map[string]string{"taskId": "task-123"},
			})
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	c.uploadBaseURL = srv.URL
	localURL := srv.URL + "/storage/v1/object/sign/media/reference.png?token=local-test"
	_, err := c.Submit(context.Background(), SubmitRequest{
		KieModelID:      "kling-4.0/reference-to-video",
		Prompt:          "use @image_1",
		ImageURL:        localURL,
		ImageURLs:       []string{localURL},
		DurationSeconds: 4,
		Resolution:      "720p",
		AspectRatio:     "16:9",
	})
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	if uploads != 1 {
		t.Fatalf("file uploads = %d, want one upload for the duplicate image fields", uploads)
	}
	if len(submittedImages) != 1 || submittedImages[0] != uploadedURL {
		t.Errorf("submitted image_urls = %v, want [%q]", submittedImages, uploadedURL)
	}
}

// TestClient_Submit_Seedance_Shape and TestClient_Submit_Kling_Shape are a
// pair, deliberately: each asserts BOTH what its own model sends AND what
// the OTHER model's keys must be absent, so a regression that gives both
// models the same (wrong) shape fails at least one of the two rather than
// passing silently — the exact trap a test that only checks "my keys are
// present" falls into.
func TestClient_Submit_Seedance_Shape(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]string{"taskId": "task-1"}})
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	generateAudio := true
	_, err := c.Submit(context.Background(), SubmitRequest{
		KieModelID:      "bytedance/seedance-2-5",
		Prompt:          "a dog skateboarding",
		ImageURL:        "https://example.com/frame.png",
		DurationSeconds: 6,
		Resolution:      "1080p",
		AspectRatio:     "9:16",
		GenerateAudio:   &generateAudio,
	})
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	if gotBody["model"] != "bytedance/seedance-2-5" {
		t.Errorf("model = %v, want %q", gotBody["model"], "bytedance/seedance-2-5")
	}
	input := gotBody["input"].(map[string]any)
	if input["resolution"] != "1080p" {
		t.Errorf("input[resolution] = %v, want 1080p", input["resolution"])
	}
	if input["generate_audio"] != true {
		t.Errorf("input[generate_audio] = %v, want true", input["generate_audio"])
	}
	// Kling's keys must NOT appear on a Seedance submission — this is the
	// half a test that only checks Seedance's own keys would miss.
	for _, key := range []string{"mode", "sound", "multi_shots"} {
		if _, present := input[key]; present {
			t.Errorf("input[%s] = %v, want absent — that is Kling's key, not Seedance's", key, input[key])
		}
	}
}

func TestClient_Submit_Kling_Shape(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]string{"taskId": "task-1"}})
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	// Deliberately the shape nativeAudioModel actually produces for Kling
	// (models.go): no Resolution, no GenerateAudio, no AspectRatio — Kling
	// has none of those inputs, so PickModel never sets them.
	//
	// `sound` is the exception, and it is covered separately at the end of
	// this test: it comes off SubmitRequest.HasAudio, not hardcoded.
	_, err := c.Submit(context.Background(), SubmitRequest{
		KieModelID:      "kling-3.0/video",
		Prompt:          "a dog skateboarding, speaking to camera",
		ImageURL:        "https://example.com/frame.png",
		DurationSeconds: 6,
	})
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	if gotBody["model"] != "kling-3.0/video" {
		t.Errorf("model = %v, want %q", gotBody["model"], "kling-3.0/video")
	}
	input := gotBody["input"].(map[string]any)
	if input["mode"] != "pro" {
		t.Errorf("input[mode] = %v, want %q", input["mode"], "pro")
	}
	if input["multi_shots"] != false {
		t.Errorf("input[multi_shots] = %v, want false", input["multi_shots"])
	}
	if input["aspect_ratio"] != "9:16" {
		t.Errorf("input[aspect_ratio] = %v, want 9:16", input["aspect_ratio"])
	}
	imageURLs, ok := input["image_urls"].([]any)
	if !ok || len(imageURLs) != 1 || imageURLs[0] != "https://example.com/frame.png" {
		t.Errorf("input[image_urls] = %v, want a one-element array with the reference frame", input["image_urls"])
	}
	// Seedance's keys must NOT appear on a Kling submission.
	for _, key := range []string{"resolution", "generate_audio"} {
		if _, present := input[key]; present {
			t.Errorf("input[%s] = %v, want absent — that is Seedance's key, not Kling's", key, input[key])
		}
	}

	// `sound` tracks HasAudio, and both directions are asserted.
	//
	// false is the case that was impossible until klingInput stopped
	// hardcoding true — it is what makes an 18 cr/s silent Kling render
	// reachable at all, against the 63 cr/s Seedance route every silent
	// scene used to be forced onto. true is the case that must keep
	// working: a talking-head clip rendered silently is a lip-synced shot
	// with no voice, which is worse than paying the surcharge.
	for _, hasAudio := range []bool{true, false} {
		gotBody = nil
		_, err := c.Submit(context.Background(), SubmitRequest{
			KieModelID:      "kling-3.0/video",
			Prompt:          "a dog skateboarding",
			ImageURL:        "https://example.com/frame.png",
			DurationSeconds: 6,
			HasAudio:        hasAudio,
		})
		if err != nil {
			t.Fatalf("Submit(HasAudio=%v) error = %v", hasAudio, err)
		}
		in := gotBody["input"].(map[string]any)
		if in["sound"] != hasAudio {
			t.Errorf("HasAudio=%v: input[sound] = %v, want %v", hasAudio, in["sound"], hasAudio)
		}
		if _, present := in["generate_audio"]; present {
			t.Errorf("HasAudio=%v: generate_audio leaked onto a Kling submission", hasAudio)
		}
	}
}

// TestClient_Submit_MissingImageURL is the negative control on the
// reference-frame requirement.
func TestClient_Submit_MissingImageURL(t *testing.T) {
	c := NewClient("test-key", false, nil, "")
	_, err := c.Submit(context.Background(), SubmitRequest{
		KieModelID: "bytedance/seedance-2-5",
		Prompt:     "a dog skateboarding",
	})
	if err == nil {
		t.Fatal("Submit() error = nil, want an error for a missing reference frame")
	}
}

// TestClient_Submit_EmptyKieModelID is the negative control for the other
// required field. Renamed from TestClient_Submit_EmptyEndpoint: the field
// used to be SubmitRequest.Endpoint (a fal path), now KieModelID (kie's own
// wire id) — see types.go.
func TestClient_Submit_EmptyKieModelID(t *testing.T) {
	c := NewClient("test-key", false, nil, "")
	_, err := c.Submit(context.Background(), SubmitRequest{
		Prompt:   "a dog skateboarding",
		ImageURL: "https://example.com/frame.png",
	})
	if err == nil {
		t.Fatal("Submit() error = nil, want an error for a missing kie model id")
	}
}

// TestClient_Submit_UnknownKieModelID pins Submit's refusal when no
// Descriptor's KieModelID matches the request — the safety net that used to
// live in a separate kieModels-map lookup (kie/models.go, before Descriptor
// carried BuildInput directly) and now lives in DescriptorByKieModelID's ok
// return.
func TestClient_Submit_UnknownKieModelID(t *testing.T) {
	c := NewClient("test-key", false, nil, "")
	_, err := c.Submit(context.Background(), SubmitRequest{
		KieModelID: "not-a-real-model",
		Prompt:     "x",
		ImageURL:   "https://example.com/frame.png",
	})
	if err == nil {
		t.Fatal("Submit() error = nil, want an error for an unroutable kie model id")
	}
}

// TestClient_Status_And_Result pins recordInfo's UNVERIFIED shape and this
// client's translation of it: state -> Status, resultJson.resultUrls[0] ->
// VideoURL, creditsConsumed -> ActualCostUSD at $0.005/credit.
func TestClient_Status_And_Result(t *testing.T) {
	var gotPaths []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.RawQuery)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 200,
			"msg":  "success",
			"data": map[string]any{
				"taskId":          "task-1",
				"state":           "success",
				"resultJson":      `{"resultUrls":["https://cdn.kie.ai/clip.mp4"]}`,
				"creditsConsumed": 183,
			},
		})
	}))
	defer srv.Close()

	c := newTestClient(t, srv)

	status, err := c.Status(context.Background(), "task-1")
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if status != StatusCompleted {
		t.Errorf("Status() = %q, want %q", status, StatusCompleted)
	}

	res, err := c.Result(context.Background(), "task-1")
	if err != nil {
		t.Fatalf("Result() error = %v", err)
	}
	if res.VideoURL != "https://cdn.kie.ai/clip.mp4" {
		t.Errorf("Result().VideoURL = %q", res.VideoURL)
	}
	if res.ActualCostUSD == nil {
		t.Fatal("Result().ActualCostUSD = nil, want 183 credits * $0.005")
	}
	const want = 183 * 0.005
	if *res.ActualCostUSD != want {
		t.Errorf("Result().ActualCostUSD = %v, want %v", *res.ActualCostUSD, want)
	}

	for _, q := range gotPaths {
		if q != "taskId=task-1" {
			t.Errorf("query = %q, want taskId=task-1", q)
		}
	}
}

// TestClient_RecordInfo_FractionalCreditsConsumed is the regression test for
// the bug that hung the first real kie render in production.
//
// The fixture above encodes creditsConsumed through map[string]any as the Go
// int 183, so it reaches the decoder as the JSON literal `183`. The live API
// does not do that: a real recordInfo response carries `"creditsConsumed":
// 378.0`, and encoding/json will not unmarshal `378.0` into an int. That does
// not merely drop the field — it fails the ENTIRE response, so Status() and
// Result() both returned "decode response" errors, reconcile logged one every
// 30 seconds, and the scene sat in `rendering` until the 20-minute timeout,
// with kie having already finished the render and billed 378 credits for it.
//
// The response body is a raw string here rather than a marshalled Go value on
// purpose: json.Marshal(378.0) emits `378`, which is exactly the integer form
// that already passed. Only a literal `378.0` in the wire bytes reaches the
// branch this test exists to protect — revert CreditsConsumed to *int and this
// test fails while the one above still passes.
func TestClient_RecordInfo_FractionalCreditsConsumed(t *testing.T) {
	const body = `{"code":200,"msg":"success","data":{` +
		`"taskId":"task-1","state":"success",` +
		`"resultJson":"{\"resultUrls\":[\"https://cdn.kie.ai/clip.mp4\"]}",` +
		`"creditsConsumed":378.0}}`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)

	status, err := c.Status(context.Background(), "task-1")
	if err != nil {
		t.Fatalf("Status() error = %v, want a decoded success", err)
	}
	if status != StatusCompleted {
		t.Errorf("Status() = %q, want %q", status, StatusCompleted)
	}

	res, err := c.Result(context.Background(), "task-1")
	if err != nil {
		t.Fatalf("Result() error = %v, want a decoded success", err)
	}
	if res.VideoURL != "https://cdn.kie.ai/clip.mp4" {
		t.Errorf("Result().VideoURL = %q", res.VideoURL)
	}
	if res.ActualCostUSD == nil {
		t.Fatal("Result().ActualCostUSD = nil, want 378 credits * $0.005")
	}
	// Compared with a tolerance, not ==: 378 * 0.005 is not exactly
	// representable in binary floating point (it evaluates to
	// 1.8900000000000001), so an equality check here fails on arithmetic
	// rather than on the behaviour under test.
	const want = 378 * 0.005
	if diff := *res.ActualCostUSD - want; diff > 1e-9 || diff < -1e-9 {
		t.Errorf("Result().ActualCostUSD = %v, want %v", *res.ActualCostUSD, want)
	}
}

// TestClient_Result_NotYetComplete is the negative control on Result's own
// contract: callers must only call it once Status reports StatusCompleted.
func TestClient_Result_NotYetComplete(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 200,
			"data": map[string]any{"taskId": "task-1", "state": "generating"},
		})
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.Result(context.Background(), "task-1")
	if err == nil {
		t.Fatal("Result() error = nil, want an error for a task that has not completed")
	}
}

// TestClient_Result_NoResultUrls is the negative control for a "success"
// state whose resultJson this client's guess fails to parse — the shape
// most likely to be wrong on day one, per this file's own UNVERIFIED
// disclaimer.
func TestClient_Result_NoResultUrls(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 200,
			"data": map[string]any{"taskId": "task-1", "state": "success", "resultJson": `{}`},
		})
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.Result(context.Background(), "task-1")
	if err == nil {
		t.Fatal("Result() error = nil, want an error when resultJson.resultUrls is empty/absent")
	}
}

// TestStatusFromState pins the guessed kie-state -> Status mapping,
// including the negative control that matters most: an unrecognized state
// must read as "still working", never as terminal — see statusFromState's
// doc comment for why erroring or defaulting to failed/completed would be
// unsafe for a scene that may already be billed.
func TestStatusFromState(t *testing.T) {
	tests := []struct {
		state string
		want  Status
	}{
		{"waiting", StatusInQueue},
		{"queuing", StatusInQueue},
		{"generating", StatusInProgress},
		{"success", StatusCompleted},
		{"fail", StatusFailed},
		{"some-unrecognized-future-state", StatusInProgress},
		{"", StatusInProgress},
	}
	for _, tt := range tests {
		if got := statusFromState(tt.state); got != tt.want {
			t.Errorf("statusFromState(%q) = %q, want %q", tt.state, got, tt.want)
		}
	}
}

// TestClient_VendorReportedError pins that a non-2xx `code` in an otherwise-
// 200 HTTP response is treated as a failure — kie's documented envelope
// carries its own code/msg independent of the HTTP status.
func TestClient_VendorReportedError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Same reasoning as the Submit twin below: a well-formed data block
		// is included so the envelope's `code` is the only thing that can
		// fail this, not a downstream "state was empty" branch.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 500,
			"msg":  "internal error",
			"data": map[string]any{"taskId": "task-1", "state": "success"},
		})
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.Status(context.Background(), "task-1")
	if err == nil {
		t.Fatal("Status() error = nil, want an error for a vendor-reported non-success code")
	}
}

// TestClient_Submit_VendorReportedError is the submit-side twin of the test
// above, and it is not redundant: kie answers HTTP 200 even when the request
// failed, putting the real outcome in the envelope's `code`. That was
// observed against the live API on 2026-08-28 — an `Authorization: Key ...`
// header (fal's scheme, not kie's) came back as HTTP 200 with
// {"code":401,"msg":"Unauthorized – Authentication failed..."}. A client that
// reads the HTTP status alone treats a rejected credential as a successful
// submit and then polls a task id it never received.
func TestClient_Submit_VendorReportedError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Verbatim shape of the live response, HTTP 200 included.
		w.WriteHeader(http.StatusOK)
		// A taskId is included ON PURPOSE. Without one, the Submit path's
		// next check ("response had no taskId") returns an error anyway and
		// this test passes whether or not the code check exists — green
		// against broken code, which is worse than no test. The taskId makes
		// the envelope's `code` the only thing that can catch this.
		_, _ = w.Write([]byte(`{"code":401,"msg":"Unauthorized – Authentication failed. Please check that your Authorization and Content-Type headers are correctly set.","data":{"taskId":"must-not-be-used"}}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	taskID, err := c.Submit(context.Background(), SubmitRequest{
		KieModelID: "bytedance/seedance-2-5",
		Prompt:     "a dog skateboarding",
		ImageURL:   "https://example.com/frame.png",
	})
	if err == nil {
		t.Fatal("Submit() error = nil for HTTP 200 carrying code=401 — a rejected credential read as success")
	}
	if taskID != "" {
		t.Errorf("Submit() taskID = %q, want empty when the vendor reported an error", taskID)
	}
}

// TestClient_Submit_InsufficientBalance pins ErrInsufficientBalance against
// the measured envelope (see that error's own doc comment): HTTP 200
// carrying {"code":402,"msg":"Credits insufficient : ..."}.
func TestClient_Submit_InsufficientBalance(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"code":402,"msg":"Credits insufficient : Your current balance isn't enough to run this request."}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.Submit(context.Background(), SubmitRequest{
		KieModelID: "bytedance/seedance-2-5",
		Prompt:     "x",
		ImageURL:   "https://example.com/frame.png",
	})
	if err == nil {
		t.Fatal("Submit() error = nil, want ErrInsufficientBalance")
	}
	if !errors.Is(err, ErrInsufficientBalance) {
		t.Errorf("Submit() error = %v, want it to wrap ErrInsufficientBalance", err)
	}
}

// TestClient_Submit_OrdinaryVendorError_NotInsufficientBalance is the
// negative control: an ordinary 422-shaped envelope error must NOT be
// misclassified as an out-of-credit refusal — the exact failure mode that
// would tell an admin to add funds for a request that was simply malformed.
func TestClient_Submit_OrdinaryVendorError_NotInsufficientBalance(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"code":422,"msg":"multi_shots cannot be empty"}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.Submit(context.Background(), SubmitRequest{
		KieModelID: "bytedance/seedance-2-5",
		Prompt:     "x",
		ImageURL:   "https://example.com/frame.png",
	})
	if err == nil {
		t.Fatal("Submit() error = nil, want an error for a rejected request")
	}
	if errors.Is(err, ErrInsufficientBalance) {
		t.Errorf("Submit() error = %v, wrongly classified as ErrInsufficientBalance", err)
	}
}

// TestLooksLikeInsufficientBalance covers the classifier directly, both
// signals and the negative control.
func TestLooksLikeInsufficientBalance(t *testing.T) {
	tests := []struct {
		name string
		code int
		msg  string
		want bool
	}{
		{"402 trusted outright regardless of msg", 402, "", true},
		{"measured phrase at a different code", 400, "Credits insufficient : add funds", true},
		{"case-insensitive", 400, "CREDITS INSUFFICIENT", true},
		{"ordinary validation error", 422, "multi_shots cannot be empty", false},
		{"unrelated 500", 500, "internal error", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := looksLikeInsufficientBalance(tt.code, tt.msg); got != tt.want {
				t.Errorf("looksLikeInsufficientBalance(%d, %q) = %v, want %v", tt.code, tt.msg, got, tt.want)
			}
		})
	}
}

// TestClient_4xx_NotRetried: an ordinary 4xx must not be retried.
func TestClient_4xx_NotRetried(t *testing.T) {
	var attempts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":400,"msg":"bad request"}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.Submit(context.Background(), SubmitRequest{
		KieModelID: "bytedance/seedance-2-5",
		Prompt:     "x",
		ImageURL:   "https://example.com/frame.png",
	})
	if err == nil {
		t.Fatal("Submit() error = nil, want an error")
	}
	if attempts != 1 {
		t.Errorf("attempts = %d, want 1 (an ordinary 4xx must not be retried)", attempts)
	}
}

// TestClient_429_Retried: an explicit 429 is safe to retry because the
// vendor refused the request before starting work.
func TestClient_429_Retried(t *testing.T) {
	var attempts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts < 3 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]string{"taskId": "task-1"}})
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	id, err := c.Submit(context.Background(), SubmitRequest{
		KieModelID: "bytedance/seedance-2-5",
		Prompt:     "x",
		ImageURL:   "https://example.com/frame.png",
	})
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	if id != "task-1" {
		t.Errorf("Submit() = %q, want %q", id, "task-1")
	}
	if attempts != 3 {
		t.Errorf("attempts = %d, want 3", attempts)
	}
}

// TestClient_408OnPOST_TagsSubmissionOutcomeUnknown pins the real gap fixed
// alongside this migration: fal.Client's now-deleted doJSON used to be the
// only producer of ErrSubmissionOutcomeUnknown, so an ambiguous lost-POST
// failure on kie was silently recorded as a confident, free failure instead
// of a billing-unknown one — invisible while fal still took most
// submissions, a real gap the moment kie became the only vendor. A 408 on
// this client's own POST (createTask may have already been accepted and
// billed even though the response was lost) must now wrap
// ErrSubmissionOutcomeUnknown too.
func TestClient_408OnPOST_TagsSubmissionOutcomeUnknown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusRequestTimeout)
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.Submit(context.Background(), SubmitRequest{
		KieModelID: "bytedance/seedance-2-5",
		Prompt:     "x",
		ImageURL:   "https://example.com/frame.png",
	})
	if err == nil {
		t.Fatal("Submit() error = nil, want an error for a 408")
	}
	if !errors.Is(err, ErrSubmissionOutcomeUnknown) {
		t.Errorf("Submit() error = %v, want it to wrap ErrSubmissionOutcomeUnknown", err)
	}
}

// TestClassifyAmbiguousFailure_POST_TagsSubmissionOutcomeUnknown covers the
// classifier directly: a transport-level or 5xx failure on a POST must be
// wrapped, not returned bare — the other of the two places
// ErrSubmissionOutcomeUnknown can now originate from (see the 408 test
// above for the other).
func TestClassifyAmbiguousFailure_POST_TagsSubmissionOutcomeUnknown(t *testing.T) {
	cause := errors.New("connection reset")
	retry, err := classifyAmbiguousFailure(http.MethodPost, cause)
	if retry {
		t.Error("classifyAmbiguousFailure(POST) retry = true, want false")
	}
	if !errors.Is(err, ErrSubmissionOutcomeUnknown) {
		t.Errorf("classifyAmbiguousFailure(POST) error = %v, want it to wrap ErrSubmissionOutcomeUnknown", err)
	}
	if !errors.Is(err, cause) {
		t.Errorf("classifyAmbiguousFailure(POST) error = %v, want it to still wrap the original cause", err)
	}
}

func TestClassifyAmbiguousFailure_GET_NotTagged(t *testing.T) {
	cause := errors.New("connection reset")
	retry, err := classifyAmbiguousFailure(http.MethodGet, cause)
	if !retry {
		t.Error("classifyAmbiguousFailure(GET) retry = false, want true")
	}
	if errors.Is(err, ErrSubmissionOutcomeUnknown) {
		t.Error("classifyAmbiguousFailure(GET) wrongly wrapped ErrSubmissionOutcomeUnknown — GET is idempotent and safe to retry")
	}
}

// ---------------------------------------------------------------------------
// mock mode
// ---------------------------------------------------------------------------

func TestClient_Mock_SubmitAndComplete(t *testing.T) {
	c := NewClient("test-key", true, nil, "https://worker.example.com/mock/clip.mp4")

	id, err := c.Submit(context.Background(), SubmitRequest{
		KieModelID: "bytedance/seedance-2-5",
		Prompt:     "x",
		ImageURL:   "https://example.com/frame.png",
	})
	if err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	if id == "" {
		t.Fatal("Submit() returned an empty id")
	}

	// Immediately after submit, mock mode reports in-progress.
	status, err := c.Status(context.Background(), id)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if status != StatusInProgress {
		t.Errorf("Status() immediately after submit = %q, want %q", status, StatusInProgress)
	}

	time.Sleep(mockRenderDelay + 50*time.Millisecond)

	status, err = c.Status(context.Background(), id)
	if err != nil {
		t.Fatalf("Status() after delay error = %v", err)
	}
	// mockFailureRate means this can legitimately come back Failed; either
	// terminal status is acceptable here, this just must not still be
	// in-progress or queued.
	if status != StatusCompleted && status != StatusFailed {
		t.Errorf("Status() after delay = %q, want a terminal status", status)
	}
}

func TestClient_Mock_UnknownTaskID(t *testing.T) {
	c := NewClient("test-key", true, nil, "")
	if _, err := c.Status(context.Background(), "unknown-task"); err == nil {
		t.Error("Status() error = nil for an unknown mock task id, want an error")
	}
	if _, err := c.Result(context.Background(), "unknown-task"); err == nil {
		t.Error("Result() error = nil for an unknown mock task id, want an error")
	}
}

// Exercise every descriptor through settings parsing, routing, and the real
// request encoder; the HTTP server is local and no vendor is called.
func TestSubmit_PreservesEverySelectedModel(t *testing.T) {
	for _, descriptor := range Descriptors {
		t.Run(descriptor.ID, func(t *testing.T) {
			var submitted string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Model string `json:"model"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				submitted = body.Model
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"code":200,"data":{"taskId":"model-test"}}`))
			}))
			defer srv.Close()
			raw, err := json.Marshal(RenderSettings{Model: descriptor.ID, Resolution: descriptor.DefaultResolution, FPS: descriptor.DefaultFPS})
			if err != nil {
				t.Fatal(err)
			}
			settings := mustParseRenderSettings(t, raw)
			model := mustPickModel(t, true, true, settings)
			_, err = newTestClient(t, srv).Submit(context.Background(), SubmitRequest{
				KieModelID: model.KieModelID, Resolution: model.Resolution,
				Prompt: "product shot", ImageURL: "https://example.com/frame.png",
				DurationSeconds: float64(descriptor.AllowedDurationsS[0]),
				GenerateAudio:   model.GenerateAudio, HasAudio: model.HasAudio,
				DurationSendAsString: model.DurationSendAsString,
				WebhookURL:           "https://worker.example/webhooks/kie",
			})
			if err != nil {
				t.Fatal(err)
			}
			if submitted != descriptor.KieModelID {
				t.Fatalf("selection %q submitted %q, want %q", descriptor.ID, submitted, descriptor.KieModelID)
			}
		})
	}
}
