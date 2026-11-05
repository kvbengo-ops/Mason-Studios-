package kie

import (
	"strings"
	"testing"
)

// The reason exists to send a reader to the right place: a missing SOUND tier
// is a different gap from a missing resolution, and the old message ("no kie
// rate for resolved model/resolution") pointed at the resolution for both.
//
// This test was written on 2026-09-04 against seedance, whose sound tier was
// the live example. Hours later that tier was measured and filled, and on
// 2026-10-30 its 720p and 1080p sound rates were filled from kie's published
// page, so the example moved again — to Hailuo, which has a silent rate and no
// sound rate at all. That the example moves is the healthy outcome;
// MissingRateReason's job is unchanged.
func TestMissingRateReasonNamesTheAudioTier(t *testing.T) {
	// Hailuo has a silent rate and, deliberately, no sound rate. Asking for
	// the sound side is the exact case this message exists for.
	got := MissingRateReason(Model{ID: "hailuo-2.3-pro", Resolution: "768P", HasAudio: true})
	if got == "" {
		t.Fatalf("expected a reason for hailuo 768P with audio; did it gain a sound rate?")
	}
	if want := "sound-tier"; !contains(got, want) {
		t.Errorf("reason %q does not name the audio tier; a reader would go looking at the resolution", got)
	}
}

func TestMissingRateReasonIsEmptyWhenPriced(t *testing.T) {
	// 480p WITH SOUND is the pair every production render asks for, and it is
	// measured six times over. This assertion is the one that would have gone
	// red on 2026-09-04 if it had existed then, instead of four renders going
	// out with estimated_cost_usd=unknown.
	if got := MissingRateReason(Model{ID: "seedance-2.5", Resolution: "480p", HasAudio: true}); got != "" {
		t.Errorf("expected no reason for the pair production actually renders, got %q", got)
	}
	// The silent tier for the same pair is priced too.
	if got := MissingRateReason(Model{ID: "seedance-2.5", Resolution: "480p"}); got != "" {
		t.Errorf("expected no reason for a priced pair, got %q", got)
	}
	// And Kling has both tiers.
	if got := MissingRateReason(Model{ID: "kling-3.0-pro", Resolution: "1080p", HasAudio: true}); got != "" {
		t.Errorf("expected no reason for kling with audio, got %q", got)
	}
}

func TestMissingRateReasonSeparatesAnUnpricedResolution(t *testing.T) {
	// Nothing at all is priced at this resolution — a different gap, found in
	// a different place, and it must not claim the audio tier is the problem.
	got := MissingRateReason(Model{ID: "seedance-2.5", Resolution: "4320p", HasAudio: true})
	if contains(got, "sound-tier") {
		t.Errorf("reason %q blames the audio tier for an unpriced resolution", got)
	}
}

func contains(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}
