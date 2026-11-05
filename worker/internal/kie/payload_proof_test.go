package kie

import (
	"encoding/json"
	"strings"
	"testing"
)

// Prints the ACTUAL body seedanceInput builds for a scene carrying a video
// reference, so the wire shape is read rather than reasoned about.
//
// This exists because reading the builder is not the same as reading what it
// emits, and this is the one field where the difference costs money: per
// worker/internal/kie/client.go's own note, kie accepts an unknown or
// wrongly-typed key, answers 200, and BILLS THE RENDER. A misspelled
// "reference_video_url" would therefore look exactly like success — the scene
// would render, the operator would be charged, and the video would simply not
// have conditioned anything.
//
// Run it with -v to see the JSON:
//
//	go test ./internal/kie/ -run TestSeedancePayloadProof -v
func TestSeedancePayloadProof(t *testing.T) {
	input := seedanceInput(SubmitRequest{
		KieModelID:      "bytedance/seedance-2-5",
		Prompt:          "a woman holding the product, warm kitchen light",
		ImageURLs:       []string{"https://signed.example/ref_frame.jpg"},
		AudioURLs:       []string{"https://signed.example/voice.mp3"},
		VideoURLs:       []string{"https://signed.example/clip.mp4"},
		DurationSeconds: 4,
	})

	body, err := json.MarshalIndent(input, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	t.Logf("createTask input:\n%s", body)

	// The exact key kie's Seedance 2.5 schema names. Asserted as a literal
	// string against the marshalled JSON rather than as a map lookup, because
	// a map lookup with the same typo in it would agree with itself.
	if !strings.Contains(string(body), `"reference_video_urls"`) {
		t.Fatalf("reference_video_urls is absent from the submitted body:\n%s", body)
	}
	if !strings.Contains(string(body), "https://signed.example/clip.mp4") {
		t.Fatalf("the signed video URL never reached the body:\n%s", body)
	}

	// And the neighbours are undisturbed — a new key must not have displaced
	// the two that were already carrying material.
	for _, want := range []string{`"reference_image_urls"`, `"reference_audio_urls"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("%s went missing when video was added:\n%s", want, body)
		}
	}
}
