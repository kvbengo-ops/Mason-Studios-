package kie

import (
	"encoding/json"
	"testing"
)

// This file replaces two predecessors, both deleted when fal was
// decommissioned:
//
//   - worker/internal/fal/models_test.go (998 lines) pinned PickModel,
//     EstimateCost/EstimateCostForVendor, ParseRenderSettings,
//     DescriptorByID, and ClampFPSForDuration against a 13-descriptor,
//     fal-shaped table with USD-per-second pricing and an
//     Enabled/DisabledReason/Substituted fallback mechanism. Every case
//     asserting VendorFal specifically, or exercising a disabled
//     descriptor's substitution, tested code that no longer exists — see
//     models.go's own header comment for why there is nothing left to
//     substitute away from.
//   - This package's own models_test.go (58 lines) pinned modelIDFor, the
//     function that translated a fal.Descriptor.Endpoint into kie's wire
//     model id. There is no fal endpoint any more to translate FROM — a
//     Descriptor's KieModelID field IS the wire id directly — so
//     modelIDFor is gone and TestDescriptorKieModelID_Pinned below is its
//     replacement: same literal-string-not-derived-from-the-map pinning
//     (TestModelIDFor's own stated reason for existing), now pointed at
//     Descriptor.KieModelID instead of a lookup function's return value.
//
// What carries forward: the exact wire-id literals (kling-3.0/video,
// bytedance/seedance-2-5, hailuo/2-3-image-to-video-pro) and the
// unknown-id-must-refuse safety net, now via DescriptorByKieModelID's ok
// return rather than modelIDFor's error.

func TestDescriptorKieModelID_Pinned(t *testing.T) {
	cases := []struct {
		id   string
		want string
	}{
		{"seedance-2.5", "bytedance/seedance-2-5"},
		{"kling-3.0-pro", "kling-3.0/video"},
		{"hailuo-2.3-pro", "hailuo/2-3-image-to-video-pro"},
	}
	for _, c := range cases {
		d, ok := DescriptorByID(c.id)
		if !ok {
			t.Fatalf("unknown model %q", c.id)
		}
		if d.KieModelID != c.want {
			t.Errorf("DescriptorByID(%q).KieModelID = %q, want %q", c.id, d.KieModelID, c.want)
		}
	}
}

func TestDescriptorByKieModelID_Unknown_Refuses(t *testing.T) {
	for _, bad := range []string{"", "fal-ai/kling-video/v3/pro/image-to-video", "bytedance/seedance-2.5"} {
		if _, ok := DescriptorByKieModelID(bad); ok {
			t.Errorf("DescriptorByKieModelID(%q) ok = true, want false — kie has no such model", bad)
		}
	}
}

func TestDescriptorByKieModelID_RoundTrips(t *testing.T) {
	for _, d := range Descriptors {
		// BytePlus's Seedance 2.5 shares kie's wire id on purpose: kie is its
		// fallback, and the lookup only feeds kie's request builder.
		if d.ID == BytePlusSeedance25ID {
			continue
		}
		got, ok := DescriptorByKieModelID(d.KieModelID)
		if !ok {
			t.Errorf("DescriptorByKieModelID(%q) ok = false, want true", d.KieModelID)
			continue
		}
		if got.ID != d.ID {
			t.Errorf("DescriptorByKieModelID(%q).ID = %q, want %q", d.KieModelID, got.ID, d.ID)
		}
	}
}

func TestDescriptorByID_UnknownRefuses(t *testing.T) {
	for _, bad := range []string{"", "ltx-2.3-fast", "seedance-2.0-mini", "typo"} {
		if _, ok := DescriptorByID(bad); ok {
			t.Errorf("DescriptorByID(%q) accepted an unknown model", bad)
		}
	}
}

// TestRatesCoverAllowedResolutions is the guard EstimateCost's own doc
// comment cites: every Descriptor's AllowedResolutions must have a
// matching Rates silent entry (every model can render silent), and a
// NativeAudio descriptor must have BOTH a silent and a sound rate at EVERY
// AllowedResolution, not just its DefaultResolution — it renders both ways
// depending on is_talking_head (nativeAudioModel honours settings.Resolution
// via the same containsString check standardModel uses, so ANY of its
// AllowedResolutions, not only the default, is a tier a real render can
// land on). Kling's std/720p is exactly the case this widened to catch: it
// shipped with a sound rate but no silent one, which priced every B-roll
// (non-talking-head, silent) scene on a std/720p project at +Infinity. If
// this test ever goes red, kie.EstimateCost's ok=false path has become
// reachable through ordinary PickModel usage, not just the defensive
// hand-edited-row case its doc comment describes.
func TestRatesCoverAllowedResolutions(t *testing.T) {
	for _, d := range Descriptors {
		// IN EITHER TIER, not specifically the silent one. This asked only
		// about silence, on the assumption every model can render without
		// sound — true of every descriptor in this file when it was written,
		// and false twice over since: seedance 2.5's silent entry is an
		// inference copied from its sound receipts, and the two 2.0 models
		// have no silent entry at all because nothing has been rendered on
		// them that way.
		//
		// What EstimateCost needs is that a pair PickModel can reach is
		// priceable at the tier the render will actually use. The
		// SupportsGenerateAudio branch below pins the audio side, which is
		// the tier this product renders at.
		for _, resolution := range d.AllowedResolutions {
			_, silent := rateFor(d.ID, resolution, false)
			_, spoken := rateFor(d.ID, resolution, true)
			if !silent && !spoken {
				t.Errorf(
					"%s: resolution %q is in AllowedResolutions with no rate in EITHER audio tier, "+
						"so PickModel can reach a pair EstimateCost cannot price",
					d.ID, resolution,
				)
			}
		}
		if d.NativeAudio {
			// EVERY AllowedResolution, not just DefaultResolution: a
			// NativeAudio descriptor renders silent (B-roll) or with sound
			// (talking-head) at whichever resolution the settings row
			// actually names, via nativeAudioModel's containsString check —
			// see this function's own doc comment above.
			for _, resolution := range d.AllowedResolutions {
				if _, ok := rateFor(d.ID, resolution, false); !ok {
					t.Errorf("%s: NativeAudio descriptor has no SILENT rate at AllowedResolution %q — a B-roll (non-talking-head) scene at this tier prices at +Infinity", d.ID, resolution)
				}
				if _, ok := rateFor(d.ID, resolution, true); !ok {
					t.Errorf("%s: NativeAudio descriptor has no SOUND rate at AllowedResolution %q — a talking-head scene at this tier prices at +Infinity", d.ID, resolution)
				}
			}
		}
		// ADDED 2026-09-04, replacing TestSeedanceHasNoSoundRate_KnownBug.
		//
		// The branch above asks for a sound rate only when d.NativeAudio,
		// which is Kling alone. Seedance sets SupportsGenerateAudio instead,
		// and AUDIO_ENABLED is "1" in production, so every seedance render
		// goes out with generate_audio true — asking rateFor a question the
		// table had no answer for. Four consecutive production renders were
		// submitted with estimated_cost_usd=unknown before anyone looked.
		//
		// DefaultResolution, not every AllowedResolution: 720p and 1080p have
		// no sound receipt, and inventing one to satisfy a test is the exact
		// trade this file refuses everywhere else.
		if d.SupportsGenerateAudio {
			if _, ok := rateFor(d.ID, d.DefaultResolution, true); !ok {
				t.Errorf(
					"%s renders with generate_audio true but has no SOUND rate at its DefaultResolution %q — "+
						"every render of it is submitted unpriced",
					d.ID, d.DefaultResolution,
				)
			}
		}
	}
}

// TestSeedanceHasNoSoundRate_KnownBug lived here until 2026-09-04.
//
// It asserted that seedance had no Sound table, named that a bug, and its own
// comment had the diagnosis exactly right two days before the bug was seen in
// production: "the operator is quoted one price and billed another", because
// SupportsGenerateAudio and NativeAudio are different flags and only the
// latter was covered by the sweep above.
//
// It also said what to do when the rate was finally measured — delete it, and
// require a sound rate for every SupportsGenerateAudio descriptor — which is
// what TestRatesCoverAllowedResolutions now does. That is the trade worth
// naming: a test that fails when a rate is MISSING replaces one that failed
// when the rate arrived. The first is a guard; the second is a bookmark, and
// bookmarks do not stop the four unpriced renders that went out on 09-04
// while this test sat green.

func TestRateFor_Values(t *testing.T) {
	cases := []struct {
		name            string
		modelID         string
		resolution      string
		withSound       bool
		wantCreditsPerS float64
		wantProvenance  Provenance
	}{
		{"kling silent", "kling-3.0-pro", "1080p", false, 18, ProvenanceReceipt},
		{"kling sound", "kling-3.0-pro", "1080p", true, 27, ProvenanceReceipt},
		{"hailuo silent", "hailuo-2.3-pro", "768P", false, 9, ProvenanceReceipt},
		// Both tiers carry 28, for different reasons, and the pair is here
		// so the distinction cannot quietly collapse: SOUND is the six
		// receipts (4s through 10s, all with generate_audio true), SILENT is
		// the inference drawn from them. The sound row is the one production
		// asks for.
		{"seedance 480p silent", "seedance-2.5", "480p", false, 28, ProvenanceReceipt},
		{"seedance 480p sound", "seedance-2.5", "480p", true, 28, ProvenanceReceipt},
		{"seedance 720p", "seedance-2.5", "720p", false, 63, ProvenanceReceipt},
		{"seedance 1080p", "seedance-2.5", "1080p", false, 158, ProvenancePublished},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rp, ok := rateFor(c.modelID, c.resolution, c.withSound)
			if !ok {
				t.Fatalf("rateFor(%q, %q, %v) ok = false, want true", c.modelID, c.resolution, c.withSound)
			}
			if rp.CreditsPerSecond != c.wantCreditsPerS {
				t.Errorf("CreditsPerSecond = %v, want %v", rp.CreditsPerSecond, c.wantCreditsPerS)
			}
			if rp.Provenance != c.wantProvenance {
				t.Errorf("Provenance = %v, want %v", rp.Provenance, c.wantProvenance)
			}
		})
	}
}

func TestRateFor_KlingSilent_NoFallbackToSound(t *testing.T) {
	// Hailuo has no sound table at all — asking for its sound rate must
	// refuse, not silently answer with the silent rate. See rateFor's own
	// doc comment: a caller asking for sound on a silent-only model has a
	// bug, and a fallback would hide it.
	if _, ok := rateFor("hailuo-2.3-pro", "768P", true); ok {
		t.Error("rateFor(hailuo, withSound=true) ok = true, want false — Hailuo has no sound table")
	}
}

func TestRateFor_UnknownModel_Refuses(t *testing.T) {
	if _, ok := rateFor("not-a-model", "1080p", false); ok {
		t.Error("rateFor(unknown model) ok = true, want false")
	}
}

func TestRateFor_UnknownResolution_Refuses(t *testing.T) {
	if _, ok := rateFor("seedance-2.5", "4K", false); ok {
		t.Error("rateFor(seedance, unknown resolution) ok = true, want false")
	}
}

// ---------------------------------------------------------------------------
// PickModel
// ---------------------------------------------------------------------------

func TestPickModel_DefaultsToSeedance(t *testing.T) {
	m := mustPickModel(t, false, false, DefaultRenderSettings())
	if m.ID != "seedance-2.5" {
		t.Errorf("PickModel default ID = %q, want seedance-2.5", m.ID)
	}
	if m.KieModelID != "bytedance/seedance-2-5" {
		t.Errorf("PickModel default KieModelID = %q, want bytedance/seedance-2-5", m.KieModelID)
	}
}

// A Kling-selecting project must NOT reach the native-audio route just
// because a scene is talking-head — AUDIO_ENABLED must also be on. See
// PickModel's own doc comment.
func TestPickModel_Kling_RequiresBothTalkingHeadAndAudioEnabled(t *testing.T) {
	settings := RenderSettings{Model: "kling-3.0-pro", Resolution: "1080p", FPS: 24}

	cases := []struct {
		name          string
		isTalkingHead bool
		audioEnabled  bool
		wantHasAudio  bool
	}{
		{"neither", false, false, false},
		{"talking head only", true, false, false},
		{"audio enabled only", false, true, false},
		{"both", true, true, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := mustPickModel(t, c.isTalkingHead, c.audioEnabled, settings)
			if m.ID != "kling-3.0-pro" {
				t.Fatalf("PickModel ID = %q, want kling-3.0-pro (settings.Model is authoritative)", m.ID)
			}
			if m.HasAudio != c.wantHasAudio {
				t.Errorf("HasAudio = %v, want %v", m.HasAudio, c.wantHasAudio)
			}
		})
	}
}

// A project that never selected Kling must render every scene on its own
// silent default, even a talking-head scene with AUDIO_ENABLED=1 —
// is_talking_head has no power to override settings.Model. See PickModel's
// own doc comment.
func TestPickModel_NonKlingProject_NeverRoutesToKlingAutomatically(t *testing.T) {
	m := mustPickModel(t, true, true, DefaultRenderSettings())
	if m.ID == "kling-3.0-pro" {
		t.Fatal("PickModel routed a Seedance-default project to Kling on is_talking_head+AUDIO_ENABLED alone")
	}
}

func TestPickModel_Seedance_GenerateAudioFollowsFlag(t *testing.T) {
	settings := DefaultRenderSettings() // seedance-2.5

	on := mustPickModel(t, false, true, settings)
	if on.GenerateAudio == nil || !*on.GenerateAudio {
		t.Error("AUDIO_ENABLED=1: GenerateAudio should be a non-nil true")
	}
	if !on.HasAudio {
		t.Error("AUDIO_ENABLED=1: HasAudio should be true")
	}

	off := mustPickModel(t, false, false, settings)
	if off.GenerateAudio == nil || *off.GenerateAudio {
		t.Error("AUDIO_ENABLED=0: GenerateAudio should be a non-nil false (must be sent explicitly)")
	}
	if off.HasAudio {
		t.Error("AUDIO_ENABLED=0: HasAudio should be false")
	}
}

func TestPickModel_Hailuo_NoGenerateAudioField(t *testing.T) {
	settings := RenderSettings{Model: "hailuo-2.3-pro", Resolution: "768P", FPS: 24}
	m := mustPickModel(t, false, true, settings)
	if m.GenerateAudio != nil {
		t.Errorf("Hailuo GenerateAudio = %v, want nil — this model has no audio input at all", m.GenerateAudio)
	}
}

func TestPickModel_UnknownResolution_FallsBackToDefault(t *testing.T) {
	settings := RenderSettings{Model: "seedance-2.5", Resolution: "9999p", FPS: 24}
	m := mustPickModel(t, false, false, settings)
	if m.Resolution != "480p" {
		t.Errorf("Resolution = %q, want the descriptor default %q", m.Resolution, "480p")
	}
}

// TestPickModel_Kling_HonoursItsOwnStoredResolution pins the fix this
// comment used to invite: nativeAudioModel used to return d.DefaultResolution
// UNCONDITIONALLY, ignoring settings.Resolution outright. That was invisible
// while Kling had exactly one resolution tier (pro/1080p) — whatever was
// stored, forcing it to the default landed on the only value that could ever
// be there. It stopped being safe the moment kie's std mode (720p, 20 cr/s)
// became a second, cheaper, real tier: a /ugc project saved at std/720p
// would have silently rendered, and billed, at pro/1080p.
func TestPickModel_Kling_HonoursItsOwnStoredResolution(t *testing.T) {
	settings := RenderSettings{Model: "kling-3.0-pro", Resolution: "720p", FPS: 24}
	m := mustPickModel(t, true, true, settings)
	if m.Resolution != "720p" {
		t.Errorf("Resolution = %q, want the stored %q — nativeAudioModel must not force pro/1080p when std/720p is a legal Kling tier", m.Resolution, "720p")
	}
	usd, ok := EstimateCost(m, 1)
	if !ok {
		t.Fatal("EstimateCost ok = false, want true — kling-3.0-pro/720p sound has a receipt")
	}
	// 20 cr/s / 200 credits-per-$ = $0.10/s.
	if usd != 0.10 {
		t.Errorf("EstimateCost(1s) = %v, want 0.10 (20 cr/s)", usd)
	}
}

// The containsString fallback, still. A resolution Kling does not list —
// "480p" is a real Seedance tier, never a Kling one; "" is what a project
// that has never touched resolution carries — must still resolve to pro/
// 1080p exactly as every Kling render did before std existed. Never
// +Infinity, never a silent guess at std's cheaper rate.
func TestPickModel_Kling_UnknownOrEmptyResolution_FallsBackToPro(t *testing.T) {
	for _, resolution := range []string{"480p", ""} {
		t.Run(resolution, func(t *testing.T) {
			settings := RenderSettings{Model: "kling-3.0-pro", Resolution: resolution, FPS: 24}
			m := mustPickModel(t, true, true, settings)
			if m.Resolution != "1080p" {
				t.Errorf("Resolution = %q, want the descriptor default %q", m.Resolution, "1080p")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// EstimateCost
// ---------------------------------------------------------------------------

func TestEstimateCost_Seedance720P_4Seconds(t *testing.T) {
	m := mustPickModel(t, false, false, RenderSettings{Model: "seedance-2.5", Resolution: "720p", FPS: 24})
	usd, ok := EstimateCost(m, 4)
	if !ok {
		t.Fatal("EstimateCost ok = false, want true")
	}
	// 63 cr/s * 4s = 252 credits / 200 credits-per-$ = $1.26.
	if want := 1.26; usd != want {
		t.Errorf("EstimateCost = %v, want %v", usd, want)
	}
}

func TestEstimateCost_KlingSilentVsSound(t *testing.T) {
	silent := Model{ID: "kling-3.0-pro", Resolution: "1080p", HasAudio: false}
	sound := Model{ID: "kling-3.0-pro", Resolution: "1080p", HasAudio: true}

	silentUSD, ok := EstimateCost(silent, 10)
	if !ok {
		t.Fatal("silent EstimateCost ok = false")
	}
	soundUSD, ok := EstimateCost(sound, 10)
	if !ok {
		t.Fatal("sound EstimateCost ok = false")
	}
	if soundUSD <= silentUSD {
		t.Errorf("sound cost %v should exceed silent cost %v — kie surcharges audio", soundUSD, silentUSD)
	}
	// 18 cr/s * 10s / 200 = $0.90; 27 cr/s * 10s / 200 = $1.35.
	if want := 0.90; silentUSD != want {
		t.Errorf("silent EstimateCost = %v, want %v", silentUSD, want)
	}
	if want := 1.35; soundUSD != want {
		t.Errorf("sound EstimateCost = %v, want %v", soundUSD, want)
	}
}

func TestEstimateCost_UnknownPair_Refuses(t *testing.T) {
	m := Model{ID: "hailuo-2.3-pro", Resolution: "1080p"} // never priced
	if _, ok := EstimateCost(m, 10); ok {
		t.Error("EstimateCost ok = true for an unpriced resolution, want false")
	}
}

// ---------------------------------------------------------------------------
// ParseRenderSettings / DefaultRenderSettings / ClampFPSForDuration
// ---------------------------------------------------------------------------

func TestDefaultRenderSettings(t *testing.T) {
	s := DefaultRenderSettings()
	if s.Model != "seedance-2.5" || s.Resolution != "480p" || s.FPS != 24 {
		t.Errorf("DefaultRenderSettings() = %+v, want {seedance-2.5 480p 24}", s)
	}
}

func TestParseRenderSettings_EmptyRawUsesDefault(t *testing.T) {
	s := mustParseRenderSettings(t, nil)
	if s != DefaultRenderSettings() {
		t.Errorf("mustParseRenderSettings(t, nil) = %+v, want defaults", s)
	}
}

func TestParseRenderSettings_InvalidRefuses(t *testing.T) {
	for _, raw := range []string{`not json`, `{"model":"typo"}`, `{"model":""}`, `{"model":42}`} {
		if _, err := ParseRenderSettings([]byte(raw)); err == nil {
			t.Errorf("accepted invalid settings %s", raw)
		}
	}
}

func mustParseRenderSettings(t *testing.T, raw []byte) RenderSettings {
	t.Helper()
	s, err := ParseRenderSettings(raw)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func mustPickModel(t *testing.T, talking, audio bool, settings RenderSettings) Model {
	t.Helper()
	m, err := PickModel(talking, audio, settings)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestParseRenderSettings_RoundTrips(t *testing.T) {
	raw, err := json.Marshal(RenderSettings{Model: "kling-3.0-pro", Resolution: "1080p", FPS: 24})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := mustParseRenderSettings(t, raw)
	if s.Model != "kling-3.0-pro" || s.Resolution != "1080p" || s.FPS != 24 {
		t.Errorf("mustParseRenderSettings(t, ) = %+v, want the written values", s)
	}
}

func TestParseRenderSettings_InvalidResolution_FallsBackToModelDefault(t *testing.T) {
	raw := []byte(`{"model":"seedance-2.5","resolution":"9999p"}`)
	s := mustParseRenderSettings(t, raw)
	if s.Resolution != "480p" {
		t.Errorf("Resolution = %q, want the descriptor default %q", s.Resolution, "480p")
	}
}

// TestParseRenderSettings_LegacyUppercaseResolution_ResolvesToCanonicalSpelling
// pins canonicalResolution's case-insensitive match, EqualFold, against the
// legacy rows it exists for: Seedance's resolutions were stored uppercase
// ("480P"/"720P") until commit 4ac10aa lowercased them, and Kling's
// AllowedResolutions gained "720p" alongside "1080p" on 2026-09-10. Either
// row must still resolve to the descriptor's OWN spelling — never fall back
// to the model's default just because a byte-for-byte compare stopped
// matching, and never echo the caller's casing back onto the wire.
func TestParseRenderSettings_LegacyUppercaseResolution_ResolvesToCanonicalSpelling(t *testing.T) {
	tests := []struct {
		model string
		want  string
	}{
		{"kling-3.0-pro", "720p"},
		{"seedance-2.5", "720p"},
	}
	for _, tt := range tests {
		raw := []byte(`{"model":"` + tt.model + `","resolution":"720P"}`)
		s := mustParseRenderSettings(t, raw)
		if s.Resolution != tt.want {
			t.Errorf("%s: Resolution = %q, want the canonical %q for stored \"720P\"", tt.model, s.Resolution, tt.want)
		}
	}
}

func TestClampFPSForDuration_NoOpForEveryDescriptor(t *testing.T) {
	// Every kie descriptor today has an empty MaxDurationSByFPS — this rule
	// was LTX's (fal), and LTX is gone. Pinning the no-op explicitly means
	// a future model that DOES constrain fps by duration breaks this test
	// rather than silently changing behavior nobody wrote a case for.
	for _, d := range Descriptors {
		got := ClampFPSForDuration(d, d.DefaultFPS, 999)
		if got != d.DefaultFPS {
			t.Errorf("%s: ClampFPSForDuration(999s) = %d, want %d (no-op)", d.ID, got, d.DefaultFPS)
		}
	}
}
