package loop

import (
	"testing"

	"ugc-pipeline/worker/internal/store"
)

// A MODEL THAT CANNOT READ "@imageN" MUST NOT BE SENT ONE.
//
// Kling treats any "@xxx" in the prompt as a ROLE reference and refuses the
// whole submission unless a kling_elements array comes with it, which this
// product does not send:
//
//	code=422 "kling_elements is required when prompt contains role
//	references like @element_dog."
//
// Production, 2026-09-11, scene 9a32f34b, three times — the operator kept
// pressing Try again, and a retry re-runs the scene unchanged, so it failed
// identically each time. The prompt was "make the @dog dance" and the
// "@image1" kie objected to was written by bindUITags, not by the operator:
// @dog's element had no description, so nothing substituted it away, and
// binding it to its ordinal is exactly right for Seedance.
//
// Nothing was billed — 422 is a refusal before the render — so this cost
// time rather than money, three times over.
func TestBindUITagsLeavesNoAtForAModelWithoutRoleReferences(t *testing.T) {
	refs := []store.SceneReference{imageRef(1, "dog", "", "")}

	got := bindUITags("make the @dog dance", ordinalByTag(refs), deletedTagSet(refs), false)

	if want := "make the dog dance"; got != want {
		t.Errorf("bindUITags = %q, want %q", got, want)
	}
	for _, r := range got {
		if r == '@' {
			t.Fatalf("an '@' survived into a Kling prompt: %q — kie refuses the whole submission", got)
		}
	}
}

// THE OTHER HALF, and it is the branch that must not move. Seedance reads
// "@image1" as reference_image_urls[0]; stripping it there would break the
// positional binding this function exists to provide, for every render this
// product currently makes.
func TestBindUITagsStillBindsForAModelThatReadsThem(t *testing.T) {
	refs := []store.SceneReference{imageRef(1, "dog", "", "")}

	got := bindUITags("make the @dog dance", ordinalByTag(refs), deletedTagSet(refs), true)

	if want := "make the @image1 dance"; got != want {
		t.Errorf("bindUITags = %q, want %q", got, want)
	}
}

// A voice tag is DELETED whichever model is asked, because the file is the
// reference and the word is not. The role-reference flag has no business
// changing that, and a fix that stripped every '@' by hand rather than
// falling through to the existing bare-name branch would quietly leave the
// voice's name in the prompt.
func TestVoiceTagsAreDeletedForBothKinds(t *testing.T) {
	tag := func(v string) *string { return &v }
	refs := []store.SceneReference{{Kind: "audio", Tag: tag("Audio_5"), Ordinal: 1}}

	for _, roleReferences := range []bool{true, false} {
		got := bindUITags("driven by @Audio_5 alone", ordinalByTag(refs), deletedTagSet(refs), roleReferences)
		if want := "driven by alone"; got != want {
			t.Errorf("roleReferences=%v: bindUITags = %q, want %q", roleReferences, got, want)
		}
	}
}
