package kie

import "testing"

// THE BUG THIS PINS, observed in production on 2026-09-04.
//
// Every seedance receipt was filed in the Silent table, and every render this
// product makes sets generate_audio true. rateFor has no fallback by design,
// so the sound lookup found nothing and each dispatch logged "cost estimate
// unavailable; no rate for this model at this audio tier" with
// estimated_cost_usd=unknown. Four renders went out that way in eleven
// minutes. None of them failed — the only symptom was the log line, and
// runs.cost_usd stayed correct afterwards because it prefers kie's own
// creditsConsumed. So the damage was a missing quote and an unenforced cap,
// not a wrong ledger, which is exactly why it survived so long.
//
// The table was full of correct numbers filed under the wrong tier. Every
// test asked "is 28 cr/s right?" and none asked "is it where the code looks?"

// The pair production actually renders, priced from receipts. Asserting the
// number without asserting its tier is what let the bug live.
func TestSeedance480pSoundRateIsTheMeasuredOne(t *testing.T) {
	rate, ok := rateFor("seedance-2.5", "480p", true)
	if !ok {
		t.Fatal("no sound rate at 480p — this is the production bug itself")
	}
	if rate.CreditsPerSecond != 28 {
		t.Errorf("CreditsPerSecond = %v, want 28 (six receipts, 4s through 10s)", rate.CreditsPerSecond)
	}
	if rate.Provenance != ProvenanceReceipt {
		t.Errorf("Provenance = %q, want %q — this was measured, not published", rate.Provenance, ProvenanceReceipt)
	}

	// The arithmetic the log prints, against two real receipts: 6s billed
	// $0.84 (task e9dc4e5b) and 5s billed $0.70 (tasks 4ed3b1f9, 452cf434,
	// 7131c412, 2d31fc04 — four of them at that length alone).
	for _, c := range []struct {
		seconds float64
		wantUSD float64
	}{{6, 0.84}, {5, 0.70}} {
		if got := rate.CreditsPerSecond * c.seconds / CreditsPerUSD; got != c.wantUSD {
			t.Errorf("%vs at this rate = $%.2f, want $%.2f to match the receipt", c.seconds, got, c.wantUSD)
		}
	}
}

// Above 480p the sound rate comes from kie's published page, not a receipt
// (owner's decision, 2026-10-30: a documented rate is sold). That is allowed;
// what this test stops is such a rate passing as measured. Each must say it is
// published, carry the page it was read from, and differ from the 480p number
// it must not be copied from.
func TestSeedanceSoundRatesAbove480pAreLabelledPublished(t *testing.T) {
	measured, _ := rateFor("seedance-2.5", "480p", true)
	for _, resolution := range []string{"720p", "1080p"} {
		rate, ok := rateFor("seedance-2.5", resolution, true)
		if !ok {
			t.Fatalf("seedance %s lost its published sound rate", resolution)
		}
		if rate.Provenance != ProvenancePublished {
			t.Errorf("seedance %s sound Provenance = %q, want %q — no render at that "+
				"resolution has been billed with generate_audio known-true",
				resolution, rate.Provenance, ProvenancePublished)
		}
		if rate.Note == "" {
			t.Errorf("seedance %s sound rate carries no Note naming where it was read from", resolution)
		}
		if rate.CreditsPerSecond == measured.CreditsPerSecond {
			t.Errorf("seedance %s sound rate equals the 480p number — copied across, not read", resolution)
		}
	}
}
