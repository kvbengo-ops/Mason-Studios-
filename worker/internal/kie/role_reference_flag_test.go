package kie

import "testing"

// WHICH MODELS READ "@imageN", pinned per model rather than per mechanism.
//
// loop's own tests prove bindUITags honours the flag. They say nothing about
// whether any descriptor sets it correctly, and flipping Kling's to true
// left every one of them green — the mechanism was covered and the wiring
// was not. That is the same shape as a guard whose caller forgets to call
// it: each half passes, the pair does nothing.
//
// Kling is false because kie refuses the whole submission over a single
// '@' without a kling_elements array (code=422, production 2026-09-11).
// Seedance is true because "@imageN" is how a prompt names
// reference_image_urls[N-1], which is the entire reason bindUITags exists.
func TestSupportsRoleReferencesPerModel(t *testing.T) {
	for _, tc := range []struct {
		id   string
		want bool
		why  string
	}{
		{"kling-3.0-pro", false, "kie 422s on any '@' without kling_elements"},
		{"seedance-2.5", true, "@imageN indexes reference_image_urls"},
		{"seedance-2", true, "@imageN indexes reference_image_urls"},
		{"seedance-2-fast", true, "@imageN indexes reference_image_urls"},
	} {
		t.Run(tc.id, func(t *testing.T) {
			d, ok := DescriptorByID(tc.id)
			if !ok {
				t.Fatalf("unknown model %q", tc.id)
			}
			if d.ID != tc.id {
				t.Fatalf("DescriptorByID(%q) returned %q — the id moved and this test is now blind", tc.id, d.ID)
			}
			if d.SupportsRoleReferences != tc.want {
				t.Errorf("SupportsRoleReferences = %v, want %v: %s", d.SupportsRoleReferences, tc.want, tc.why)
			}
		})
	}
}

// The flag has to survive the descriptor-to-Model step, because that is what
// loop.promptForScene actually reads. A field set correctly on the
// descriptor and dropped here would be false at submit time for every model
// — silently sending Seedance bare names instead of @imageN.
func TestSupportsRoleReferencesReachesSubmitTime(t *testing.T) {
	settings := RenderSettings{Resolution: "480p", FPS: 24}

	seedance := mustPickModel(t, false, true, RenderSettings{Model: "seedance-2.5", Resolution: "480p", FPS: 24})
	if !seedance.SupportsRoleReferences {
		t.Error("Seedance lost the flag between descriptor and Model — @imageN binding would stop")
	}

	// Kling resolves through nativeAudioModel, a different constructor, and
	// a flag added to only one of the two would be wrong for exactly one
	// model family.
	kling := mustPickModel(t, true, true, RenderSettings{Model: "kling-3.0-pro", Resolution: "720p", FPS: 24})
	if kling.ID == "kling-3.0-pro" && kling.SupportsRoleReferences {
		t.Error("Kling reached submit time claiming role references — kie will 422 the render")
	}
	_ = settings
}
