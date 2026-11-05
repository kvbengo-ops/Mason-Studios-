package kie

import (
	"reflect"
	"testing"
)

func TestGeminiOmniInputGolden(t *testing.T) {
	videoSeconds := 10.0
	got := geminiOmniInput(SubmitRequest{
		Prompt:               "neon street",
		ImageURLs:            []string{"https://storage.test/one.png", "https://storage.test/two.png"},
		VideoURLs:            []string{"https://storage.test/source.mp4"},
		VideoDurationSeconds: []*float64{&videoSeconds},
		DurationSeconds:      4,
		Resolution:           "720p",
	})
	want := map[string]any{
		"prompt": "neon street", "duration": "4", "aspect_ratio": "9:16", "resolution": "720p",
		"image_urls": []string{"https://storage.test/one.png", "https://storage.test/two.png"},
		"video_list": []map[string]any{{"url": "https://storage.test/source.mp4", "start": 0, "ends": 10.0}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("geminiOmniInput() = %#v, want %#v", got, want)
	}
}

func TestGeminiOmniSendsVoiceAsAudioIDs(t *testing.T) {
	got := geminiOmniInput(SubmitRequest{
		Prompt: "hi", ImageURLs: []string{"https://storage.test/one.png"},
		AudioIDs: []string{"achernar"}, DurationSeconds: 4, Resolution: "720p",
	})
	if !reflect.DeepEqual(got["audio_ids"], []string{"achernar"}) {
		t.Errorf("audio_ids = %#v, want [achernar]", got["audio_ids"])
	}
}

func TestParseRenderSettingsKeepsVoiceForGeminiOnly(t *testing.T) {
	if v := mustParseRenderSettings(t, []byte(`{"model":"gemini-omni-video","voice":"achernar"}`)).Voice; v != "achernar" {
		t.Errorf("Gemini voice = %q, want achernar", v)
	}
	if v := mustParseRenderSettings(t, []byte(`{"model":"seedance-2.5","voice":"achernar"}`)).Voice; v != "" {
		t.Errorf("Seedance voice = %q, want empty", v)
	}
}

func TestGeminiOmniCostsAreExactAndVideoIsFixed(t *testing.T) {
	m := mustPickModel(t, false, true, RenderSettings{Model: "gemini-omni-video", Resolution: "720p", FPS: 24})
	for duration, wantCredits := range map[float64]float64{4: 63, 6: 84, 8: 105, 10: 126} {
		got, ok := EstimateCost(m, duration)
		if !ok || got != wantCredits/CreditsPerUSD {
			t.Errorf("EstimateCost(%gs) = %v, %v; want %v, true", duration, got, ok, wantCredits/CreditsPerUSD)
		}
	}
	seconds := 10.0
	got, ok := EstimateCostWithVideo(m, 4, []*float64{&seconds})
	if !ok || got != 168.0/CreditsPerUSD {
		t.Errorf("Gemini video cost = %v, %v; want %v, true", got, ok, 168.0/CreditsPerUSD)
	}
}

func TestGeminiOmniRefusesTwoVideoInputs(t *testing.T) {
	m := mustPickModel(t, false, true, RenderSettings{Model: "gemini-omni-video", Resolution: "720p", FPS: 24})
	a, b := 4.0, 5.0
	if _, ok := EstimateCostWithVideo(m, 4, []*float64{&a, &b}); ok {
		t.Fatal("two Gemini video inputs priced successfully")
	}
}

func TestGeminiOmniIsNotPaidFromPublishedSchedule(t *testing.T) {
	m := mustPickModel(t, false, false, RenderSettings{Model: "gemini-omni-video", Resolution: "720p", FPS: 24})
	withSound := mustPickModel(t, false, true, RenderSettings{Model: "gemini-omni-video", Resolution: "720p", FPS: 24})
	if withSound.HasAudio || withSound.GenerateAudio != nil {
		t.Fatal("Gemini sound mode implied audio would be sent")
	}
	if !GeminiOmniVideoPaid(m) {
		t.Fatal("receipted Gemini 720p was refused")
	}
	if GeminiOmniVideoInputPaid(m) {
		t.Fatal("published Gemini video-input schedule was treated as a paid receipt")
	}
}
