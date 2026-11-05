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

// THE SEAM THAT BROKE THREE TIMES IN ONE DAY (2026-09-04), and the level at
// which none of it was covered.
//
// Turning scene_references rows into kie's arrays (two on 2026-09-04, three
// since 0094_video_scene_reference.sql added video) is one short loop, and
// every failure that reached production went through it:
//
//	an MP3 in reference_image_urls, because the row said kind "image"
//	  -> vendor reported code=500 "File type not supported"
//	a voice tag left in the prose as a bare word, because only image
//	  references were bound to @imageN
//	an audio asset stored under 'ref_frame' with a .mp3 extension, because
//	  the primary-reference path never read the asset's kind
//
// Each was fixed and each got a unit test — of seedanceInput, of
// deletedTagSet, of the store's fallback. None of those drives dispatchScene,
// which is where store rows actually become a request body. A test that
// starts from rows and reads the wire is the only one that would have caught
// all three.

// refDispatch runs dispatchScene against a canned set of scene_references and
// returns the request body kie would have received.
func refDispatch(t *testing.T, refs []store.SceneReference, prompt string) []byte {
	t.Helper()

	// The signer answers every request identically; the URL it returns is not
	// what these tests assert on — WHICH ARRAY a reference lands in is.
	signSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"signedURL":"/object/sign/media/` + strings.TrimPrefix(r.URL.Path, "/storage/v1/object/sign/media/") + `?token=t"}`))
	}))
	t.Cleanup(signSrv.Close)

	capture := &captureTransport{}
	deps := Deps{
		Store: &fakeStore{references: refs},
		Config: &config.Config{
			SupabaseURL:            signSrv.URL,
			SupabaseServiceRoleKey: "test-key",
			AppBaseURL:             "https://worker.example",
			RenderConcurrency:      10,
			AudioEnabled:           true,
		},
		Logger: testLogger(),
		// mock=false: the mock path never builds a body, and the body is the
		// entire subject here.
		Kie: kie.NewClient("test-key", false, &http.Client{Transport: capture}, ""),
	}

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
		t.Fatal("dispatchScene submitted nothing")
	}
	return capture.body
}

type sentInput struct {
	Input struct {
		ReferenceImageURLs []string `json:"reference_image_urls"`
		ReferenceAudioURLs []string `json:"reference_audio_urls"`
		ReferenceVideoURLs []string `json:"reference_video_urls"`
		Prompt             string   `json:"prompt"`
		GenerateAudio      *bool    `json:"generate_audio"`
	} `json:"input"`
}

func parseSent(t *testing.T, body []byte) sentInput {
	t.Helper()
	var s sentInput
	if err := json.Unmarshal(bytes.TrimSpace(body), &s); err != nil {
		t.Fatalf("could not parse submitted body: %v\n%s", err, body)
	}
	return s
}

func tagged(s string) *string { return &s }

// A voice belongs in reference_audio_urls and nowhere else. The failure this
// pins is not subtle — kie answers code=500 "File type not supported" — but
// it reached production because nothing asserted the split at this level.
func TestDispatchSplitsAudioAndImageReferences(t *testing.T) {
	body := refDispatch(t, []store.SceneReference{
		{StorageKey: "projects/p/ref_frame/face.png", Kind: "image", Ordinal: 1, Tag: tagged("jen")},
		{StorageKey: "projects/p/audio/voice.mp3", Kind: "audio", Ordinal: 1, Tag: tagged("voice1")},
		{StorageKey: "projects/p/ref_frame/mug.png", Kind: "image", Ordinal: 2, Tag: tagged("mug")},
	}, "@jen holds @mug and speaks in @voice1")

	sent := parseSent(t, body)

	if got := len(sent.Input.ReferenceImageURLs); got != 2 {
		t.Fatalf("reference_image_urls has %d entries, want the 2 pictures: %v",
			got, sent.Input.ReferenceImageURLs)
	}
	if got := len(sent.Input.ReferenceAudioURLs); got != 1 {
		t.Fatalf("reference_audio_urls has %d entries, want the 1 voice: %v",
			got, sent.Input.ReferenceAudioURLs)
	}
	for _, u := range sent.Input.ReferenceImageURLs {
		if strings.Contains(u, ".mp3") {
			t.Errorf("an MP3 reached reference_image_urls (%q) — this is the code=500 "+
				`"File type not supported" seen in production`, u)
		}
	}
	if !strings.Contains(sent.Input.ReferenceAudioURLs[0], "voice.mp3") {
		t.Errorf("reference_audio_urls[0] = %q, want the voice clip", sent.Input.ReferenceAudioURLs[0])
	}
}

// ORDER IS THE CONTRACT. reference_image_urls is positional: element 0 is what
// the prompt calls "@image1". A sort that disagreed with the ordinals would
// silently repoint every tag at the wrong picture — a wrong render with
// nothing in any log to explain it.
func TestDispatchSendsImagesInOrdinalOrder(t *testing.T) {
	// Deliberately given out of order, as the store's ORDER BY would not
	// guarantee if someone dropped it.
	body := refDispatch(t, []store.SceneReference{
		{StorageKey: "projects/p/ref_frame/third.png", Kind: "image", Ordinal: 3},
		{StorageKey: "projects/p/ref_frame/first.png", Kind: "image", Ordinal: 1},
		{StorageKey: "projects/p/ref_frame/second.png", Kind: "image", Ordinal: 2},
	}, "a scene")

	sent := parseSent(t, body)
	if len(sent.Input.ReferenceImageURLs) != 3 {
		t.Fatalf("got %d images, want 3", len(sent.Input.ReferenceImageURLs))
	}
	// dispatch signs in the order the store hands them over; the store's own
	// query is what sorts. This asserts dispatch does not reorder them.
	for i, want := range []string{"third.png", "first.png", "second.png"} {
		if !strings.Contains(sent.Input.ReferenceImageURLs[i], want) {
			t.Errorf("reference_image_urls[%d] = %q, want %s — dispatch reordered the "+
				"references, which repoints every @imageN in the prompt",
				i, sent.Input.ReferenceImageURLs[i], want)
		}
	}
}

// A voice-only clip is a real state on this route: the operator picked a voice
// as the reference and wrote the scene in prose. It must submit, not fail —
// dispatchScene only refuses an empty image set for the SCRIPTED route.
func TestDispatchAcceptsAVoiceWithNoPicture(t *testing.T) {
	body := refDispatch(t, []store.SceneReference{
		{StorageKey: "projects/p/audio/voice.mp3", Kind: "audio", Ordinal: 1, Tag: tagged("voice1")},
	}, "she speaks in @voice1")

	sent := parseSent(t, body)
	if len(sent.Input.ReferenceAudioURLs) != 1 {
		t.Fatalf("reference_audio_urls = %v, want the voice", sent.Input.ReferenceAudioURLs)
	}
	if len(sent.Input.ReferenceImageURLs) != 0 {
		t.Errorf("reference_image_urls = %v, want none — nothing should be invented to fill it",
			sent.Input.ReferenceImageURLs)
	}
}

// A video reference lands in reference_video_urls and nowhere else —
// 0094_video_scene_reference.sql made "video" a known kind, distinct from
// the unknown-kind case below it, which this test used to double as before
// that migration existed.
func TestDispatchRoutesVideoReferencesIntoTheVideoArray(t *testing.T) {
	body := refDispatch(t, []store.SceneReference{
		{StorageKey: "projects/p/ref_frame/face.png", Kind: "image", Ordinal: 1},
		{StorageKey: "projects/p/video/clip.mp4", Kind: "video", Ordinal: 1},
	}, "a scene")

	sent := parseSent(t, body)
	if len(sent.Input.ReferenceImageURLs) != 1 {
		t.Errorf("reference_image_urls = %v, want only the picture", sent.Input.ReferenceImageURLs)
	}
	if got := len(sent.Input.ReferenceVideoURLs); got != 1 {
		t.Fatalf("reference_video_urls has %d entries, want the 1 video: %v",
			got, sent.Input.ReferenceVideoURLs)
	}
	if !strings.Contains(sent.Input.ReferenceVideoURLs[0], "clip.mp4") {
		t.Errorf("reference_video_urls[0] = %q, want the video clip", sent.Input.ReferenceVideoURLs[0])
	}
	if len(sent.Input.ReferenceAudioURLs) != 0 {
		t.Errorf("reference_audio_urls = %v, want none", sent.Input.ReferenceAudioURLs)
	}
}

// An unknown kind is still dropped rather than guessed into an array.
// scene_references CHECKs kind in ('image','audio','video'), so this is
// defence against a future member arriving before dispatch knows what to do
// with it — sending it as a picture would be a vendor refusal, and sending
// it as audio or video would be worse.
func TestDispatchIgnoresAReferenceKindItDoesNotKnow(t *testing.T) {
	body := refDispatch(t, []store.SceneReference{
		{StorageKey: "projects/p/ref_frame/face.png", Kind: "image", Ordinal: 1},
		{StorageKey: "projects/p/other/file.bin", Kind: "some_future_kind", Ordinal: 1},
	}, "a scene")

	sent := parseSent(t, body)
	if len(sent.Input.ReferenceImageURLs) != 1 {
		t.Errorf("reference_image_urls = %v, want only the picture", sent.Input.ReferenceImageURLs)
	}
	if len(sent.Input.ReferenceAudioURLs) != 0 {
		t.Errorf("reference_audio_urls = %v, want none", sent.Input.ReferenceAudioURLs)
	}
	if len(sent.Input.ReferenceVideoURLs) != 0 {
		t.Errorf("reference_video_urls = %v, want none", sent.Input.ReferenceVideoURLs)
	}
}
