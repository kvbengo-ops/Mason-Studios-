package kie

import "testing"

// The two production receipts, reproduced.
//
// A video-conditioned render is billed Price x (Input + Output) — kie's own
// published shape — but NOT at the price in the Sound table. seedance-2.5
// 480p bills 17 cr/s with a video attached against 28 without, measured
// 2026-09-10 over two renders that differed only in output length:
//
//	4s out -> 136 credits ($0.68)   task b0e0a5e8120f2dfe5f953b82cd6a123d
//	8s out -> 204 credits ($1.02)   task 49426148c9d828405e65a704c22e98aa
//
// Both carried the same 4.064s video, two images and one voice, at 480p with
// generate_audio true. 68 credits over 4 extra seconds is 17 cr/s, and the
// 68-credit intercept is 17 x 4 — the video's own length.
//
// These assert the DOLLARS, not the formula, because a test written against
// the formula would agree with any rearrangement of it that happened to be
// wrong in the same way as the code.
func TestEstimateCostWithVideoMatchesTheReceipts(t *testing.T) {
	seconds := func(v float64) *float64 { return &v }
	model := Model{ID: "seedance-2.5", Resolution: "480p", HasAudio: true}

	for _, tc := range []struct {
		name     string
		duration float64
		wantUSD  float64
	}{
		{"4s out, task b0e0a5e8, 136 credits", 4, 0.68},
		{"8s out, task 49426148, 204 credits", 8, 1.02},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := EstimateCostWithVideo(model, tc.duration, []*float64{seconds(4.064)})
			if !ok {
				t.Fatalf("could not price a render this account has actually been billed for")
			}
			if diff := got - tc.wantUSD; diff > 1e-9 || diff < -1e-9 {
				t.Errorf("estimate %.4f, real bill %.4f", got, tc.wantUSD)
			}
		})
	}
}

// The input is counted WHOLE. 17 x 8.064 is 137.1 credits and the bill was
// 136, so the fractional part is not carried. Credits are billed
// fractionally elsewhere in this file (seedance-2-fast's 11.7 cr/s), so this
// is a real property of the input side rather than a rounding artefact of
// the ledger.
func TestVideoInputSecondsAreCountedWhole(t *testing.T) {
	seconds := func(v float64) *float64 { return &v }
	model := Model{ID: "seedance-2.5", Resolution: "480p", HasAudio: true}

	got, ok := EstimateCostWithVideo(model, 4, []*float64{seconds(4.9)})
	if !ok {
		t.Fatal("refused a priceable render")
	}
	if diff := got - 0.68; diff > 1e-9 || diff < -1e-9 {
		t.Errorf("4.9s of input priced at %.4f; flooring to 4 gives 0.68", got)
	}
}

// An unmeasured duration makes the whole render unpriceable. Quoting it as
// though it carried no video would be a confident wrong number where the
// caller already knows how to print "unknown" — the distinction this
// package's header draws between unknown and free.
func TestUnmeasuredVideoDurationIsUnknownNotFree(t *testing.T) {
	model := Model{ID: "seedance-2.5", Resolution: "480p", HasAudio: true}

	if _, ok := EstimateCostWithVideo(model, 4, []*float64{nil}); ok {
		t.Error("priced a render whose video has no measured duration")
	}

	seconds := func(v float64) *float64 { return &v }
	if _, ok := EstimateCostWithVideo(model, 4, []*float64{seconds(4), nil}); ok {
		t.Error("one known duration diluted an unknown one")
	}
}

// No fallback to the Sound table. The two rates are 17 and 28 — far enough
// apart that a plausible wrong number would block affordable renders at the
// cap while looking like it worked.
func TestNoVideoReceiptIsARefusal(t *testing.T) {
	seconds := func(v float64) *float64 { return &v }
	// Kling 4.0 Reference has a price per second with no video input and none
	// for a render that carries one ("refused rather than guessed", models.go).
	// Seedance 2.5 used to be the example here; its 720p and 1080p now have a
	// published with-video rate (2026-10-30), so it prices.
	model := Model{ID: "kling-4.0-reference", Resolution: "720p"}

	if _, ok := EstimateCostWithVideo(model, 4, []*float64{seconds(4)}); ok {
		t.Error("priced a Kling 4.0 Reference render with a video input, which has no rate")
	}
}

// The branch that must not move: no video reference, no change. Every
// ordinary render still prices off the Sound table at 28 cr/s, and routing
// them through the video table would underquote each by 39%.
func TestNoVideoReferencePricesUnchanged(t *testing.T) {
	model := Model{ID: "seedance-2.5", Resolution: "480p", HasAudio: true}

	withNil, ok := EstimateCostWithVideo(model, 4, nil)
	if !ok {
		t.Fatal("refused an ordinary render")
	}
	if diff := withNil - 0.56; diff > 1e-9 || diff < -1e-9 {
		t.Errorf("an ordinary 4s render priced at %.4f, not the measured 0.56", withNil)
	}

	legacy, ok := EstimateCost(model, 4)
	if !ok || legacy != withNil {
		t.Errorf("EstimateCost disagreed with EstimateCostWithVideo(nil): %.4f vs %.4f", legacy, withNil)
	}
}
