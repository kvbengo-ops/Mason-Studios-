package kie

import "testing"

func TestParseRenderSettingsQuality(t *testing.T) {
	for raw, want := range map[string]string{
		`{"quality":"max"}`:     "max",
		`{"quality":"high"}`:    "high",
		`{"quality":"bogus"}`:   "",
		`{"resolution":"480p"}`: "",
	} {
		got, err := ParseRenderSettings([]byte(raw))
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if got.Quality != want {
			t.Errorf("%s: Quality = %q, want %q", raw, got.Quality, want)
		}
	}
}
