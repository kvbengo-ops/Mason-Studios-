package loop

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"ugc-pipeline/worker/internal/config"
	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/store"
)

func TestDispatchPromptOnly(t *testing.T) {
	for _, tc := range []struct {
		name     string
		model    string
		kind     string
		frame    *string
		readErr  error
		wantSend bool
	}{
		{"seedance", "seedance-2.5", "clip", nil, store.ErrNotFound, true},
		{"kling", "kling-3.0-pro", "clip", nil, store.ErrNotFound, true},
		{"wan", "wan-3.0", "clip", nil, store.ErrNotFound, true},
		{"scripted still needs a frame", "seedance-2.5", "scripted", nil, store.ErrNotFound, false},
		{"keyframe endpoint needs a frame", "kling-4.0", "clip", nil, store.ErrNotFound, false},
		{"broken reference is not prompt only", "seedance-2.5", "clip", strPtr("missing-asset"), store.ErrNotFound, false},
		{"database failure is not prompt only", "seedance-2.5", "clip", nil, errors.New("database unavailable"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			capture := &captureTransport{}
			fs := &fakeStore{refFrameURLErr: tc.readErr}
			settings, err := json.Marshal(map[string]string{"model": tc.model})
			if err != nil {
				t.Fatal(err)
			}
			deps := Deps{
				Store: fs, Logger: testLogger(), Config: &config.Config{AudioEnabled: true},
				Kie: kie.NewClient("test", false, &http.Client{Transport: capture}, ""),
			}
			scene := store.Scene{ID: "scene-1", ProjectID: "project-1", ProjectKind: tc.kind,
				VideoPrompt: strPtr("A cat watches the sunset."), DurationS: 6, Status: "rendering",
				RefFrameAssetID: tc.frame, RenderSettings: settings}
			dispatchScene(context.Background(), deps, scene, "https://worker.example")
			if !tc.wantSend {
				if len(capture.body) != 0 || len(fs.markFailedCalls) != 1 {
					t.Fatalf("invalid frameless scene submitted: body=%s failures=%v", capture.body, fs.markFailedCalls)
				}
				return
			}
			var sent struct {
				Input map[string]any `json:"input"`
			}
			if err := json.Unmarshal(capture.body, &sent); err != nil {
				t.Fatalf("no valid submission: %v; failures=%v", err, fs.markFailedCalls)
			}
			if sent.Input["prompt"] != *scene.VideoPrompt || fs.markRenderingCalls != 1 {
				t.Fatalf("prompt-only submission did not reach rendering: %s", capture.body)
			}
			for _, key := range []string{"image_urls", "reference_image_urls", "first_frame_url", "image_url"} {
				if _, ok := sent.Input[key]; ok {
					t.Errorf("prompt-only request contains %s", key)
				}
			}
		})
	}
}
