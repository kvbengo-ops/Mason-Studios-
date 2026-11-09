package media

import "testing"

// Lower CRF is a higher bitrate; unset must keep the old 20 so API and older
// scenes encode exactly as before.
func TestCRFFor(t *testing.T) {
	for quality, want := range map[string]int{"": 20, "standard": 20, "high": 17, "max": 14, "ultra": 20} {
		if got := CRFFor(quality); got != want {
			t.Errorf("CRFFor(%q) = %d, want %d", quality, got, want)
		}
	}
}
