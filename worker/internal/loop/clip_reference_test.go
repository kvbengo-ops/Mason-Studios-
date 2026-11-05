package loop

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ugc-pipeline/worker/internal/config"
	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/store"
)

// captureTransport records the body of the createTask request and answers with
// a canned acceptance, so a test can assert what was actually put on the wire
// without a network call. kie.Client's baseURL is a package constant, but the
// http.Client is injectable, which is enough.
type captureTransport struct {
	body []byte
}

// prepResponse answers the two calls the kie client makes BEFORE createTask when a
// reference image lives at a private (loopback) URL kie cannot fetch: the download
// from storage and the copy through kie's file upload. ok is false for everything
// else — in particular the createTask itself, which the tests care about.
//
// The upload answers with a URL that keeps the uploaded file's name, so the
// assertions that a reference arrives under its own name still mean something.
func prepResponse(r *http.Request) (*http.Response, bool) {
	reply := func(body string) (*http.Response, bool) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
			Request:    r,
		}, true
	}
	switch {
	case r.Method == http.MethodGet:
		return reply("image-bytes")
	case strings.HasSuffix(r.URL.Path, "/api/file-stream-upload"):
		raw, _ := io.ReadAll(r.Body)
		return reply(`{"code":200,"msg":"success","data":{"downloadUrl":"https://files.example/` +
			uploadedFileName(r.Header.Get("Content-Type"), raw) + `"}}`)
	}
	return nil, false
}

// uploadedFileName is the multipart upload's fileName field.
func uploadedFileName(contentType string, body []byte) string {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return "upload"
	}
	parts := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	for {
		part, err := parts.NextPart()
		if err != nil {
			return "upload"
		}
		if part.FormName() == "fileName" {
			name, _ := io.ReadAll(part)
			return string(name)
		}
	}
}

func (c *captureTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if resp, ok := prepResponse(r); ok {
		return resp, nil
	}
	if r.Body != nil {
		c.body, _ = io.ReadAll(r.Body)
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(`{"code":200,"msg":"success","data":{"taskId":"task-1"}}`)),
		Request:    r,
	}, nil
}

// A /ugc clip must submit its reference image.
//
// It used to not. The route described its references into the prompt instead
// and nulled the images out, on the argument that the prose was the whole
// reference. The first real render disproved that: the wardrobe and staging
// survived being written down and the face did not — a woman of about thirty
// in the reference came back about sixty. Nothing in the suite caught the
// change either way, because no test drove this branch at all. This is that
// test.
func TestDispatchScene_ClipSubmitsItsReferenceImage(t *testing.T) {
	signSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"signedURL":"/object/sign/media/projects/project-1/ref_frame/scene-1.png?token=test"}`))
	}))
	defer signSrv.Close()

	capture := &captureTransport{}
	fs := &fakeStore{refFrameURL: "projects/project-1/ref_frame/scene-1.png"}

	deps := Deps{
		Store: fs,
		Config: &config.Config{
			SupabaseURL:            signSrv.URL,
			SupabaseServiceRoleKey: "test-key",
			AppBaseURL:             "https://worker.example",
			RenderConcurrency:      10,
		},
		Logger: testLogger(),
		// mock=false on purpose: the mock path never builds a request body,
		// and the body is the whole point here.
		Kie: kie.NewClient("test-key", false, &http.Client{Transport: capture}, ""),
	}

	prompt := "a woman at a kitchen counter"
	scene := store.Scene{
		ID:          "scene-1",
		ProjectID:   "project-1",
		ProjectKind: "clip",
		VideoPrompt: &prompt,
		DurationS:   4,
		Status:      "rendering",
	}

	dispatchScene(context.Background(), deps, scene, "https://worker.example")

	if len(capture.body) == 0 {
		t.Fatal("no request body captured: dispatchScene never submitted")
	}

	var sent struct {
		Input struct {
			ReferenceImageURLs []string `json:"reference_image_urls"`
			Prompt             string   `json:"prompt"`
		} `json:"input"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(capture.body), &sent); err != nil {
		t.Fatalf("could not parse submitted body: %v\n%s", err, capture.body)
	}

	if len(sent.Input.ReferenceImageURLs) != 1 {
		t.Fatalf("reference_image_urls = %v, want exactly one signed reference; a clip that "+
			"sends none is the behaviour that returned the wrong face", sent.Input.ReferenceImageURLs)
	}
	if !strings.Contains(sent.Input.ReferenceImageURLs[0], "scene-1.png") {
		t.Errorf("reference_image_urls[0] = %q, want the scene's own reference frame",
			sent.Input.ReferenceImageURLs[0])
	}
	// The prose still goes with it. The picture carries the identity; the
	// prompt carries everything a picture cannot say.
	if sent.Input.Prompt != prompt {
		t.Errorf("prompt = %q, want %q", sent.Input.Prompt, prompt)
	}
}
