package loop

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ugc-pipeline/worker/internal/config"
	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/store"
)

// Production runs AUDIO_ENABLED=1 (render.yaml), so the first case here was
// live behaviour: a B-roll scene submitted with the voiceover appended as a
// spoken-dialogue instruction. Found by rendering PickModel's own answer for
// a silent scene and reading the prompt it produced:
//
//	"A hand pouring green powder into a mug. Dialogue, spoken aloud on
//	 camera: \"Half the caffeine, plus lion's mane.\""
//
// The scene settings panel offers that roll as "B-roll · silent".
func TestWithSpeech(t *testing.T) {
	settings := kie.RenderSettings{Model: "seedance-2.5", Resolution: "720p", FPS: 24}

	tests := []struct {
		name          string
		isTalkingHead bool
		audioEnabled  bool
		want          bool
	}{
		{"B-roll with audio enabled account-wide", false, true, false},
		{"A-roll with audio enabled", true, true, true},
		{"B-roll with audio off", false, false, false},
		{"A-roll with audio off", true, false, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			model, err := kie.PickModel(tt.isTalkingHead, tt.audioEnabled, settings)
			if err != nil {
				t.Fatal(err)
			}
			scene := store.Scene{IsTalkingHead: tt.isTalkingHead}
			if got := withSpeech(scene, model); got != tt.want {
				t.Errorf("withSpeech = %v, want %v (HasAudio=%v)", got, tt.want, model.HasAudio)
			}
		})
	}
}

// The fix gates the dialogue only. generate_audio still follows the flag, so
// a B-roll clip may still come back with ambient sound — that is a product
// decision, and pinning it here keeps a later change to it deliberate rather
// than accidental.
func TestBRollStillGeneratesAudioWhenFlagIsOn(t *testing.T) {
	model, err := kie.PickModel(false, true, kie.RenderSettings{Model: "seedance-2.5", Resolution: "720p", FPS: 24})
	if err != nil {
		t.Fatal(err)
	}
	if model.GenerateAudio == nil {
		t.Fatal("GenerateAudio is nil; it must always be sent explicitly on a SupportsGenerateAudio model")
	}
	if !*model.GenerateAudio {
		t.Error("generate_audio = false; the fix was meant to gate the spoken line, not silence the model")
	}
	if !model.HasAudio {
		t.Error("HasAudio = false; withSpeech, not PickModel, is where the roll is applied")
	}
}

// The prompt itself, end to end through the function dispatchScene calls —
// the assertion that would have caught this originally.
func TestPromptForSceneDropsDialogueOnBRoll(t *testing.T) {
	vp := "A hand pouring green powder into a mug."
	sl := "Half the caffeine, plus lion's mane."
	scene := store.Scene{VideoPrompt: &vp, ScriptLine: &sl, IsTalkingHead: false}
	model, err := kie.PickModel(false, true, kie.RenderSettings{Model: "seedance-2.5", Resolution: "720p", FPS: 24})
	if err != nil {
		t.Fatal(err)
	}

	got := promptForScene(scene, nil, withSpeech(scene, model), kie.Model{SupportsRoleReferences: true})
	if got != vp {
		t.Errorf("prompt = %q, want the video prompt alone (%q)", got, vp)
	}
}

// TestDispatchScene_KlingUgcSceneSubmitsSoundTrueWithNoDialogue is the
// /ugc-shaped seam pin the web-side change (offering Kling in the /ugc
// picker, is_talking_head following the chosen model) leans on: a
// talking-head Kling scene, with AUDIO_ENABLED on and no script_line — every
// /ugc scene's real shape, since that route writes no Dialogue field (see
// web/actions/ugc.ts's generateClip) — must submit createTask carrying
// model "kling-3.0/video", input.sound: true, and a prompt with no appended
// Dialogue clause.
//
// Drives the real dispatchScene end to end — kie.PickModel, withSpeech,
// promptForScene, Descriptor.BuildInput and kie.Client.Submit's own request
// marshalling — through the package's existing harness (captureTransport,
// fakeStore; see clip_reference_test.go), rather than hand-chaining those
// functions and a hand-built SubmitRequest. The earlier version of this test
// did that, and hand-chaining meant it could not fail: it called
// kie.PickModel and built HasAudio itself, so it kept passing even if
// dispatch.go's own wiring — `kie.PickModel(scene.IsTalkingHead, ...)`, or
// `HasAudio: withSpeech(scene, model)` on the Submit call — was broken or
// deleted. Driving dispatchScene means a regression in any of those seams,
// or in klingInput reading the wrong field for "sound", fails HERE instead
// of only showing up as a silently-silent production render.
func TestDispatchScene_KlingUgcSceneSubmitsSoundTrueWithNoDialogue(t *testing.T) {
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
			AudioEnabled:           true,
		},
		Logger: testLogger(),
		// mock=false on purpose, same reason clip_reference_test.go gives:
		// the mock path never builds a request body, and the body is the
		// whole point here.
		Kie: kie.NewClient("test-key", false, &http.Client{Transport: capture}, ""),
	}

	vp := "A woman speaks confidently to the camera in a softly lit studio."
	scene := store.Scene{
		ID:          "scene-1",
		ProjectID:   "project-1",
		ProjectKind: "clip",
		VideoPrompt: &vp,
		ScriptLine:  nil, // /ugc never writes a script_line
		// {"model":"kling-3.0-pro","resolution":"720p"} — the effective
		// render settings a /ugc project that has picked Kling carries (the
		// project's own render_settings merged with this scene's override,
		// same as dispatch.go always receives; see store.Scene.RenderSettings).
		// 720p, not 1080p: kie's std mode, /ugc's own tier as of 2026-09-10
		// (20 cr/s with sound — see kie.Rates["kling-3.0-pro"]). This is the
		// resolution-rule seam too: nativeAudioModel used to ignore
		// settings.Resolution outright and always resolve to pro/1080p, so
		// this scene would have rendered on the wrong tier had that not been
		// fixed alongside adding std as a second one — see this test's
		// mode assertion below.
		RenderSettings: []byte(`{"model":"kling-3.0-pro","resolution":"720p"}`),
		IsTalkingHead:  true,
		DurationS:      4,
		Status:         "rendering",
	}

	dispatchScene(context.Background(), deps, scene, "https://worker.example")

	if len(capture.body) == 0 {
		t.Fatal("no request body captured: dispatchScene never submitted")
	}

	var sent struct {
		Model string `json:"model"`
		Input struct {
			Sound       bool     `json:"sound"`
			Mode        string   `json:"mode"`
			Prompt      string   `json:"prompt"`
			ImageURLs   []string `json:"image_urls"`
			Duration    float64  `json:"duration"`
			AspectRatio string   `json:"aspect_ratio"`
		} `json:"input"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(capture.body), &sent); err != nil {
		t.Fatalf("could not parse submitted body: %v\n%s", err, capture.body)
	}

	if sent.Model != "kling-3.0/video" {
		t.Errorf("model = %q, want %q -- PickModel did not route this scene onto Kling's kie model id", sent.Model, "kling-3.0/video")
	}
	if !sent.Input.Sound {
		t.Error(`input.sound = false, want true -- a /ugc talking-head Kling scene with AUDIO_ENABLED must render WITH sound`)
	}
	// mode "std", not "pro" -- the scene's own stored 720p must survive
	// nativeAudioModel intact, not get forced to Kling's DefaultResolution
	// (pro/1080p) the way it was before Kling had a second tier. See
	// klingInput's own comment for the std/pro mapping.
	if sent.Input.Mode != "std" {
		t.Errorf("input.mode = %q, want %q -- the scene's stored 720p did not reach kie as std", sent.Input.Mode, "std")
	}
	if strings.Contains(sent.Input.Prompt, "Dialogue") {
		t.Errorf("prompt = %q, want no Dialogue clause -- /ugc scenes carry no script_line to speak one", sent.Input.Prompt)
	}
	if len(sent.Input.ImageURLs) != 1 {
		t.Fatalf("input.image_urls = %v, want exactly one signed reference frame", sent.Input.ImageURLs)
	}
	if !strings.Contains(sent.Input.ImageURLs[0], "scene-1.png") {
		t.Errorf("input.image_urls[0] = %q, want the scene's own reference frame", sent.Input.ImageURLs[0])
	}
	if sent.Input.Duration != 4 {
		t.Errorf("input.duration = %v, want 4", sent.Input.Duration)
	}
	if sent.Input.AspectRatio != "9:16" {
		t.Errorf("input.aspect_ratio = %q, want %q", sent.Input.AspectRatio, "9:16")
	}
}
