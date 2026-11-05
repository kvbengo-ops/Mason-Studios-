package loop

import (
	"testing"

	"ugc-pipeline/worker/internal/store"
)

// THE BUG THIS PINS, seen on a real dispatch on 2026-09-04 rather than
// reasoned about: reference_audio_urls carried the voice clip correctly and
// the prompt arrived reading "@image1 speaking in voice1".
//
// Seedance has no positional syntax for audio — there is no @audio1 — so a
// voice tag cannot be bound to an index the way an image is, and it was
// falling through to the unbound branch that strips the '@' and keeps the
// word. That branch is right for a typo ("and backdrop" still reads) and
// wrong for this: "voice1" is not a phrase, it is a name for something
// already sent by another route, left sitting in the prose as scene
// direction.

func TestVoiceTagsLeaveThePromptEntirely(t *testing.T) {
	images := map[string]int{"jen": 1}
	audio := map[string]bool{"voice1": true}

	for _, tc := range []struct {
		name   string
		prompt string
		want   string
	}{
		{
			// The observed case.
			"mid-sentence",
			"@jen speaking in @voice1",
			"@image1 speaking in",
		},
		{
			// Leading, which is how the operator's own prompt was written.
			"leading",
			"@voice1 test this @jen",
			"test this @image1",
		},
		{
			// ONE space goes, not both — deleting a word must not weld the
			// words either side of it together.
			"between two words",
			"a woman @voice1 at a counter",
			"a woman at a counter",
		},
		{
			// An image tag still binds, and an unknown tag still degrades to a
			// bare word. A fix that deleted every tag would pass the rows
			// above and destroy the prompt.
			"the other two branches are untouched",
			"@jen and @backdrop",
			"@image1 and backdrop",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := bindUITags(tc.prompt, images, audio, true); got != tc.want {
				t.Errorf("bindUITags(%q) = %q, want %q", tc.prompt, got, tc.want)
			}
		})
	}
}

// A blank prompt is a worse thing to send than a stray word, and an operator
// whose entire prompt is one voice tag has asked for something this function
// cannot repair. So the deletion gives way rather than emptying the field.
func TestAVoiceOnlyPromptIsNotEmptied(t *testing.T) {
	audio := map[string]bool{"voice1": true}
	for _, prompt := range []string{"@voice1", "  @voice1  "} {
		if got := bindUITags(prompt, nil, audio, true); got != prompt {
			t.Errorf("bindUITags(%q) = %q, want it left alone rather than blanked", prompt, got)
		}
	}
}

// A VIDEO TAG THAT REACHES THIS FUNCTION gets deleted exactly like a voice
// tag — bindUITags's own doc comment explains why: kie's Seedance schema
// documents @image1..N as the only positional reference syntax, nothing
// equivalent exists for reference_video_urls, and this codebase's rule is to
// never invent a wire shape it cannot verify. In practice this rarely fires:
// actions/ugc.ts's resolveElementTags substitutes a video element's
// description over its tag before the prompt reaches the worker, same as it
// does for images, so a bare "@new_video1" only survives to here when that
// element has no description yet.
func TestVideoTagsLeaveThePromptEntirely(t *testing.T) {
	images := map[string]int{"jen": 1}
	deleted := map[string]bool{"new_video1": true}

	got := bindUITags("@jen holds a phone showing @new_video1", images, deleted, true)
	want := "@image1 holds a phone showing"
	if got != want {
		t.Errorf("bindUITags(...) = %q, want %q", got, want)
	}
}

// deletedTagSet answers a different question from ordinalByTag: not "which
// slot did this tag win" but "this tag has no slot to win and should leave".
// The two must not collect each other's references. Audio and video share
// the answer — neither has a positional slot in kie's prompt syntax — so
// both must be collected, and image must still be excluded.
func TestDeletedTagSetTakesAudioAndVideoButNotImageReferences(t *testing.T) {
	tag := func(s string) *string { return &s }
	got := deletedTagSet([]store.SceneReference{
		{Kind: "image", Tag: tag("jen"), Ordinal: 1},
		{Kind: "audio", Tag: tag("voice1"), Ordinal: 1},
		{Kind: "audio", Tag: nil, Ordinal: 2},
		{Kind: "audio", Tag: tag("  "), Ordinal: 3},
		{Kind: "video", Tag: tag("new_video1"), Ordinal: 1},
	})
	if !got["voice1"] {
		t.Error("the tagged audio reference is missing")
	}
	if !got["new_video1"] {
		t.Error("the tagged video reference is missing")
	}
	if got["jen"] {
		t.Error("an IMAGE tag was collected as deleted; its word would vanish from the prompt")
	}
	if len(got) != 2 {
		t.Errorf("collected %d tags, want 2 (voice1, new_video1) — an untagged or blank reference names nothing", len(got))
	}
}
