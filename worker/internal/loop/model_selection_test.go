package loop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ugc-pipeline/worker/internal/config"
	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/store"
)

func TestDispatchScene_PreservesSelectedModel(t *testing.T) {
	signServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"signedURL":"/object/sign/media/frame.png?token=test"}`))
	}))
	defer signServer.Close()

	for _, tc := range []struct{ settings, want string }{
		// The first and third settings are the actual production scene overrides.
		{`{"model":"wan-3.0","resolution":"480P"}`, "wan/3-0-video"},
		{`{"model":"wan-3.0","resolution":"480p"}`, "wan/3-0-video"},
		{`{"model":"seedance-2-mini","resolution":"480p"}`, "bytedance/seedance-2-mini"},
		{`{"model":"kling-4.0","resolution":"720p"}`, "kling-4.0/keyframe-to-video"},
		{`{"model":"unknown-model","resolution":"480p"}`, ""},
		{`{"model":"","resolution":"480p"}`, ""},
		{`{"model":"wan-3.0","fps":"broken"}`, ""},
	} {
		t.Run(tc.settings, func(t *testing.T) {
			capture := &captureTransport{}
			fs := &fakeStore{refFrameURL: "projects/project-1/ref_frame/scene-1.png"}
			deps := Deps{
				Store: fs, Logger: testLogger(),
				Config: &config.Config{SupabaseURL: signServer.URL, SupabaseServiceRoleKey: "test", AudioEnabled: true},
				Kie:    kie.NewClient("test", false, &http.Client{Transport: capture}, ""),
			}
			scene := store.Scene{ID: "scene-1", ProjectID: "project-1", ProjectKind: "clip",
				VideoPrompt: strPtr("a product shot"), DurationS: 15, Status: "rendering",
				RenderSettings: []byte(tc.settings)}
			dispatchScene(context.Background(), deps, scene, "https://worker.example")
			if tc.want == "" {
				if len(capture.body) != 0 || fs.markRenderingCalls != 0 || len(fs.markFailedCalls) != 1 {
					t.Fatalf("invalid selection submitted or not failed: body=%s failures=%d", capture.body, len(fs.markFailedCalls))
				}
				if fs.markFailedCalls[0].run.CostUSD != nil {
					t.Fatal("unsubmitted failure recorded a charge")
				}
				return
			}
			var sent struct {
				Model string `json:"model"`
			}
			if err := json.Unmarshal(capture.body, &sent); err != nil {
				t.Fatal(err)
			}
			if sent.Model != tc.want || fs.markRenderingCalls != 1 || len(fs.markFailedCalls) != 0 {
				t.Fatalf("submitted %q, want %q; failures=%v", sent.Model, tc.want, fs.markFailedCalls)
			}
		})
	}
}
