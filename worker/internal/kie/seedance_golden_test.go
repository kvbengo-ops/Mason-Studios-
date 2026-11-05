package kie

import (
	"reflect"
	"testing"
)

// THE GOLDEN. Pins seedanceInput's exact output for one representative
// request — images, audio, video, a duration and a resolution, and
// generate_audio all present at once — so that /ugc's Kling mode (added
// beside this function, not inside it) cannot change what Seedance sends
// without this test failing first. Seedance must stay byte-for-byte
// unchanged by that work; this is the byte-for-byte check.
//
// Every field here is already covered individually by another test in this
// package (seedance_audio_test.go, seedance_video_test.go,
// role_reference_flag_test.go). What only this test catches is the
// COMBINATION drifting — a change that is invisible to each narrow test but
// changes the map a real /ugc render actually produces.
func TestSeedanceInputGolden(t *testing.T) {
	on := true
	got := seedanceInput(SubmitRequest{
		KieModelID:      "bytedance/seedance-2-5",
		Prompt:          "a woman at a counter, reaching for a mug",
		ImageURL:        "https://storage.test/face.png",
		ImageURLs:       []string{"https://storage.test/face.png", "https://storage.test/product.png"},
		AudioURLs:       []string{"https://storage.test/voice.mp3"},
		VideoURLs:       []string{"https://storage.test/clip.mp4"},
		DurationSeconds: 6,
		Resolution:      "480p",
		AspectRatio:     "9:16",
		GenerateAudio:   &on,
	})

	want := map[string]any{
		"prompt":               "a woman at a counter, reaching for a mug",
		"reference_image_urls": []string{"https://storage.test/face.png", "https://storage.test/product.png"},
		"reference_audio_urls": []string{"https://storage.test/voice.mp3"},
		"reference_video_urls": []string{"https://storage.test/clip.mp4"},
		"duration":             float64(6),
		"resolution":           "480p",
		"aspect_ratio":         "9:16",
		"generate_audio":       true,
	}

	if !reflect.DeepEqual(got, want) {
		t.Errorf("seedanceInput() =\n%#v\nwant\n%#v", got, want)
	}
}

// klingInput's own equivalent of the negative control this golden protects
// against: sending only the first entry of a two-image slice is the exact
// regression /ugc's Kling Start/End frame pair would introduce if the
// fallback here were ever narrowed back to req.ImageURL alone.
func TestKlingInputSendsUpToTwoImages(t *testing.T) {
	t.Run("one frame falls back to ImageURL", func(t *testing.T) {
		input := klingInput(SubmitRequest{
			Prompt:   "a dog skateboarding",
			ImageURL: "https://storage.test/start.png",
		})
		images, ok := input["image_urls"].([]string)
		if !ok || len(images) != 1 || images[0] != "https://storage.test/start.png" {
			t.Errorf("image_urls = %v, want a one-element array with the start frame", input["image_urls"])
		}
	})

	t.Run("two frames, start then end", func(t *testing.T) {
		input := klingInput(SubmitRequest{
			Prompt: "a dog skateboarding",
			ImageURLs: []string{
				"https://storage.test/start.png",
				"https://storage.test/end.png",
			},
		})
		images, ok := input["image_urls"].([]string)
		if !ok || len(images) != 2 ||
			images[0] != "https://storage.test/start.png" ||
			images[1] != "https://storage.test/end.png" {
			t.Errorf("image_urls = %v, want [start, end]", input["image_urls"])
		}
	})

	t.Run("no frame at all leaves image_urls out rather than sending []", func(t *testing.T) {
		input := klingInput(SubmitRequest{Prompt: "a dog skateboarding"})
		if v, present := input["image_urls"]; present {
			t.Errorf("image_urls = %v, want the key absent when there is no frame", v)
		}
	})

	t.Run("never more than two, even if scene_references somehow carried more", func(t *testing.T) {
		input := klingInput(SubmitRequest{
			Prompt: "a dog skateboarding",
			ImageURLs: []string{
				"https://storage.test/start.png",
				"https://storage.test/end.png",
				"https://storage.test/third.png",
			},
		})
		images, ok := input["image_urls"].([]string)
		if !ok || len(images) != 2 {
			t.Errorf("image_urls = %v, want exactly 2 (start, end), never 3", input["image_urls"])
		}
	})
}
