package kie

import (
	"encoding/json"
	"reflect"
	"sort"
	"testing"
)

// The exact key sets kie's docs name for the two new builders (read
// 2026-10-25). kie bills a render whose misspelled key it silently dropped,
// and kling-4.0 refuses any key it does not list, so the keys are asserted
// whole from the marshalled JSON rather than one at a time.
func marshalledKeys(t *testing.T, input map[string]any) []string {
	t.Helper()
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	keys := make([]string, 0, len(decoded))
	for k := range decoded {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func TestKling4InputSendsOnlyDocumentedKeys(t *testing.T) {
	input := kling4Input(SubmitRequest{
		Prompt:          "she lifts the mug",
		ImageURLs:       []string{"https://signed.example/start.png", "https://signed.example/end.png"},
		Resolution:      "720p",
		DurationSeconds: 5,
		HasAudio:        true,
	})
	want := []string{"aspect_ratio", "duration", "first_frame_url", "last_frame_url", "prompt", "resolution"}
	if got := marshalledKeys(t, input); !reflect.DeepEqual(got, want) {
		t.Fatalf("keys = %v, want %v", got, want)
	}
	if input["first_frame_url"] != "https://signed.example/start.png" || input["last_frame_url"] != "https://signed.example/end.png" {
		t.Fatalf("frames out of order: %v", input)
	}
}

func TestWanInputSendsAudioNotGenerateAudio(t *testing.T) {
	on := true
	input := wanInput(SubmitRequest{
		Prompt:          "a woman holding the product",
		ImageURLs:       []string{"https://signed.example/ref.jpg"},
		AudioURLs:       []string{"https://signed.example/voice.mp3"},
		Resolution:      "480P",
		AspectRatio:     "9:16",
		DurationSeconds: 4,
		GenerateAudio:   &on,
	})
	want := []string{"aspect_ratio", "audio", "duration", "prompt", "reference_audio_urls", "reference_image_urls", "resolution"}
	if got := marshalledKeys(t, input); !reflect.DeepEqual(got, want) {
		t.Fatalf("keys = %v, want %v", got, want)
	}
	if input["resolution"] != "480P" {
		t.Fatalf("resolution = %v, want kie's uppercase 480P", input["resolution"])
	}
}

func TestKling4ReferenceInputBindsImageTagsInOrder(t *testing.T) {
	images := []string{"https://signed.example/person.png", "https://signed.example/product.png"}
	input := kling4RefInput(SubmitRequest{
		Prompt:          "@image1 picks up @image2 beside @image1",
		ImageURLs:       images,
		Resolution:      "720p",
		AspectRatio:     "9:16",
		DurationSeconds: 4,
	})
	want := []string{"aspect_ratio", "duration", "image_urls", "prompt", "resolution"}
	if got := marshalledKeys(t, input); !reflect.DeepEqual(got, want) {
		t.Fatalf("keys = %v, want %v", got, want)
	}
	if input["prompt"] != "@image_1 picks up @image_2 beside @image_1" {
		t.Fatalf("prompt tags = %v, want Kling's image ordinals", input["prompt"])
	}
	if !reflect.DeepEqual(input["image_urls"], images) {
		t.Fatalf("image_urls = %v, want %v", input["image_urls"], images)
	}
	if !kling4Ref.SupportsRoleReferences || kling4Ref.NativeAudio {
		t.Fatal("Kling 4.0 Reference must use the References box and role tags")
	}
}
