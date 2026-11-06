package loop

import (
	"testing"

	"ugc-pipeline/worker/internal/store"
)

func strp(s string) *string { return &s }

// BytePlus documents "@Image N", "@Video N" and "@Audio N", numbered per kind.
// referencePrompt binds the operator's own words to exactly that, with no
// saved descriptions pasted in — the fix for a Blender blockout's description
// ("grey mannequin in a grey hallway") contradicting the scene it drives.
func TestReferencePromptBindsEveryKind(t *testing.T) {
	scene := store.Scene{VideoPrompt: strp("@walking down a neon street with @Jen, voiced by @voice, near @backdrop, mail me at a@b.co")}
	refs := []store.SceneReference{
		{Kind: "image", Ordinal: 1, Tag: strp("jen")},
		{Kind: "video", Ordinal: 1, Tag: strp("walking")},
		{Kind: "audio", Ordinal: 1, Tag: strp("voice")},
		{Kind: "image", Ordinal: 2}, // an upload: no tag to bind
	}

	got := referencePrompt(scene, refs, false)
	want := "@Video 1 down a neon street with @Image 1, voiced by @Audio 1, near backdrop, mail me at a@b.co"
	if got != want {
		t.Errorf("referencePrompt =\n  %q\nwant\n  %q", got, want)
	}
}

func TestReferencePromptAppendsDialogue(t *testing.T) {
	scene := store.Scene{VideoPrompt: strp("@jen at a counter"), ScriptLine: strp("try this")}
	refs := []store.SceneReference{{Kind: "image", Ordinal: 1, Tag: strp("jen")}}

	got := referencePrompt(scene, refs, true)
	want := `@Image 1 at a counter Dialogue, spoken aloud on camera: "try this"`
	if got != want {
		t.Errorf("referencePrompt = %q, want %q", got, want)
	}
}

func TestReferencePromptIsEmptyWithoutAVideoPrompt(t *testing.T) {
	if got := referencePrompt(store.Scene{ScriptLine: strp("a line")}, nil, false); got != "" {
		t.Errorf("referencePrompt = %q, want empty so the vendor falls back to Prompt", got)
	}
}
