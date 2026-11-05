package kie

import "testing"

// reference_video_urls is the third reference array, added by
// 0094_video_scene_reference.sql — but unlike reference_audio_urls beside it,
// attaching this one is not free. Per this file's own kiePublishedSource note,
// kie prices a render carrying a video reference as Price x (input + output)
// rather than Price x output, so this test also stands as the receipt that
// the key actually gets sent when a scene has one: the day it silently
// stopped being sent is the day every quote upstream of this function is
// wrong in the OTHER direction (the operator billed for input+output pricing
// that never actually applied).

func TestSeedanceSendsReferenceVideoWhenPresent(t *testing.T) {
	input := seedanceInput(SubmitRequest{
		Prompt:    "a woman at a counter",
		ImageURLs: []string{"https://storage.test/face.png"},
		VideoURLs: []string{"https://storage.test/clip.mp4"},
	})

	video, ok := input["reference_video_urls"].([]string)
	if !ok {
		t.Fatalf("reference_video_urls missing or not a []string: %#v", input["reference_video_urls"])
	}
	if len(video) != 1 || video[0] != "https://storage.test/clip.mp4" {
		t.Errorf("reference_video_urls = %v, want the one signed clip URL", video)
	}

	// The images must not have absorbed it, and vice versa.
	images, _ := input["reference_image_urls"].([]string)
	if len(images) != 1 || images[0] != "https://storage.test/face.png" {
		t.Errorf("reference_image_urls = %v, want only the picture", images)
	}
}

// An absent key and an empty array are different statements to a vendor, and
// only one of them is true when a scene carries no video reference. The
// images and the audio already follow this rule; the video has to as well —
// an empty reference_video_urls would still be a statement that the render
// carries a video input, and kie's own pricing note says that statement is
// what changes the bill.
func TestSeedanceOmitsReferenceVideoWhenThereIsNone(t *testing.T) {
	input := seedanceInput(SubmitRequest{
		Prompt:    "a woman at a counter",
		ImageURLs: []string{"https://storage.test/face.png"},
	})

	if _, present := input["reference_video_urls"]; present {
		t.Errorf("reference_video_urls should be absent with no video reference, got %#v", input["reference_video_urls"])
	}
}

// Kling and Hailuo have no video-reference field. A scene that tags a video
// on one of them renders without it rather than sending a key the vendor
// does not document — the honest outcome, since it cannot be honoured, and
// the same rule already established for AudioURLs.
func TestOtherModelsIgnoreVideoReferences(t *testing.T) {
	for name, build := range map[string]func(SubmitRequest) map[string]any{
		"kling":  klingInput,
		"hailuo": hailuoInput,
	} {
		input := build(SubmitRequest{
			Prompt:    "a woman at a counter",
			ImageURL:  "https://storage.test/face.png",
			VideoURLs: []string{"https://storage.test/clip.mp4"},
		})
		if _, present := input["reference_video_urls"]; present {
			t.Errorf("%s: sent reference_video_urls, which its schema has no field for", name)
		}
	}
}
