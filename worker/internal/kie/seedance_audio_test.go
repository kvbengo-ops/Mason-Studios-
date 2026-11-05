package kie

import "testing"

// reference_audio_urls is the voice half of a Seedance request, and it is a
// genuinely different thing from generate_audio: one is material the model
// listens to, the other decides whether the OUTPUT carries sound. kie's own
// schema documents them as independent, and this product sets both.

func TestSeedanceSendsReferenceAudioSeparatelyFromGenerateAudio(t *testing.T) {
	on := true
	input := seedanceInput(SubmitRequest{
		Prompt:        "a woman at a counter",
		ImageURLs:     []string{"https://storage.test/face.png"},
		AudioURLs:     []string{"https://storage.test/voice.mp3"},
		GenerateAudio: &on,
	})

	audio, ok := input["reference_audio_urls"].([]string)
	if !ok {
		t.Fatalf("reference_audio_urls missing or not a []string: %#v", input["reference_audio_urls"])
	}
	if len(audio) != 1 || audio[0] != "https://storage.test/voice.mp3" {
		t.Errorf("reference_audio_urls = %v, want the one signed voice URL", audio)
	}

	// The images must not have absorbed it, and vice versa. An MP3 in
	// reference_image_urls is a refusal from the vendor at best.
	images, _ := input["reference_image_urls"].([]string)
	if len(images) != 1 || images[0] != "https://storage.test/face.png" {
		t.Errorf("reference_image_urls = %v, want only the picture", images)
	}

	if input["generate_audio"] != true {
		t.Errorf("generate_audio = %v, want true — it is set independently of the reference", input["generate_audio"])
	}
}

// An absent key and an empty array are different statements to a vendor, and
// only one of them is true when a prompt tagged no voice. The images already
// followed this rule; the audio has to as well or every /ugc render starts
// asserting "no reference audio" rather than saying nothing.
func TestSeedanceOmitsReferenceAudioWhenThereIsNone(t *testing.T) {
	input := seedanceInput(SubmitRequest{
		Prompt:    "a woman at a counter",
		ImageURLs: []string{"https://storage.test/face.png"},
	})

	if _, present := input["reference_audio_urls"]; present {
		t.Errorf("reference_audio_urls should be absent with no voice, got %#v", input["reference_audio_urls"])
	}
}

// Kling and Hailuo have no audio-reference field. A scene that tags a voice
// on one of them renders without it rather than sending a key the vendor
// does not document — the honest outcome, since it cannot be honoured.
func TestOtherModelsIgnoreAudioReferences(t *testing.T) {
	for name, build := range map[string]func(SubmitRequest) map[string]any{
		"kling":  klingInput,
		"hailuo": hailuoInput,
	} {
		input := build(SubmitRequest{
			Prompt:    "a woman at a counter",
			ImageURL:  "https://storage.test/face.png",
			AudioURLs: []string{"https://storage.test/voice.mp3"},
		})
		if _, present := input["reference_audio_urls"]; present {
			t.Errorf("%s: sent reference_audio_urls, which its schema has no field for", name)
		}
	}
}
