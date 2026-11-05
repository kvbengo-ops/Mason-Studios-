package loop

import (
	"strings"
	"testing"
	"ugc-pipeline/worker/internal/kie"

	"ugc-pipeline/worker/internal/store"
)

func ptr(s string) *string { return &s }

// imageRef builds one scene_references row of kind "image".
func imageRef(ordinal int, tag, category, description string) store.SceneReference {
	r := store.SceneReference{StorageKey: "k", Kind: "image", Ordinal: ordinal}
	if tag != "" {
		r.Tag = ptr(tag)
	}
	if category != "" {
		r.Category = ptr(category)
	}
	if description != "" {
		r.Description = ptr(description)
	}
	return r
}

// Seedance binds assets from the prompt BY INDEX — "@image1" is the first
// entry of reference_image_urls — and has no custom names. The /ugc editor
// lets an operator type "@lena", a tag Seedance cannot resolve.
//
// WHICH tag earns which index is not a question the prompt text can answer,
// and an earlier version got it wrong by assuming it was. The web resolves
// the first tag that MATCHES A SAVED ELEMENT and lets an explicit picker
// choice beat every tag; a worker reading text order would pick differently,
// and the prompt would then assert that @imageN is a picture it is not.
// scene_references (0071) carries the answer instead: a tag and an ordinal
// per reference.
func TestBindUITags(t *testing.T) {
	tests := []struct {
		name   string
		prompt string
		refs   []store.SceneReference
		want   string
	}{
		{
			name:   "the winning tag becomes the index Seedance understands",
			prompt: "@jen at a counter",
			refs:   []store.SceneReference{imageRef(1, "jen", "character", "")},
			want:   "@image1 at a counter",
		},
		{
			// THE SHAPE THIS EXISTS FOR: a person, a location and a product
			// in one clip — and the ordinals, not the text order, decide.
			name:   "three references bind to their own ordinals",
			prompt: "@lena at the counter in @kitchen holding @kinoko",
			refs: []store.SceneReference{
				imageRef(1, "lena", "character", ""),
				imageRef(2, "kitchen", "location", ""),
				imageRef(3, "kinoko", "product", ""),
			},
			want: "@image1 at the counter in @image2 holding @image3",
		},
		{
			// Ordinals win over appearance order. The prompt names the product
			// first; it is still @image3, because that is the slot it holds.
			name:   "text order does not renumber the references",
			prompt: "@kinoko beside @lena",
			refs: []store.SceneReference{
				imageRef(1, "lena", "character", ""),
				imageRef(3, "kinoko", "product", ""),
			},
			want: "@image3 beside @image1",
		},
		{
			// THE BUG THIS SHAPE PREVENTS. The web attaches jen — "@backdrop"
			// resolves to no element and is skipped — so binding by text order
			// would point @image1 at the wrong picture.
			name:   "an unresolvable tag before the winner does not steal the slot",
			prompt: "@backdrop and @jen at a counter",
			refs:   []store.SceneReference{imageRef(1, "jen", "character", "")},
			want:   "backdrop and @image1 at a counter",
		},
		{
			// The other half: a picked photo beats every tag, so NO tag binds.
			name:   "a picker choice means no tag binds",
			prompt: "@jen at a counter",
			refs:   []store.SceneReference{imageRef(1, "", "character", "")},
			want:   "jen at a counter",
		},
		{
			name:   "the same reference named twice binds every occurrence",
			prompt: "@jen lifts a mug, @jen sets it down",
			refs:   []store.SceneReference{imageRef(1, "jen", "", "")},
			want:   "@image1 lifts a mug, @image1 sets it down",
		},
		{
			// findElementByTag resolves case-insensitively, so the worker must
			// too or "@Jen" silently loses its binding.
			name:   "case does not break the binding",
			prompt: "@Jen and @jen",
			refs:   []store.SceneReference{imageRef(1, "jen", "", "")},
			want:   "@image1 and @image1",
		},
		{
			name:   "the exact shape found in the database",
			prompt: "123123123fasd @wdd v3",
			refs:   []store.SceneReference{imageRef(1, "wdd", "", "")},
			want:   "123123123fasd @image1 v3",
		},
		{
			// THE SHAPE THE EDITOR ITSELF PRODUCES. activeTagQuery walks back
			// over [A-Za-z0-9_-] to decide the autocomplete is live, so typing
			// "wide-" then "@j" completes to "wide-@jen". An earlier pattern
			// consumed the character before the '@' and excluded '-' from it,
			// so this tag — the one that ACTUALLY attached the reference —
			// silently failed to bind.
			name:   "the winning tag binds even after a hyphen",
			prompt: "wide-@jen at a counter",
			refs:   []store.SceneReference{imageRef(1, "jen", "", "")},
			want:   "wide-@image1 at a counter",
		},
		{
			// Unicode, because the old guard was [^A-Za-z0-9_@-], which
			// matches any non-ASCII rune and so protected only ASCII emails.
			name:   "an email with a non-ASCII local part is left alone",
			prompt: "a sign reading josé@example.com",
			refs:   []store.SceneReference{imageRef(1, "jen", "", "")},
			want:   "a sign reading josé@example.com",
		},
		{
			name:   "an @ inside a word is left alone",
			prompt: "a sign reading hi@example.com",
			refs:   []store.SceneReference{imageRef(1, "jen", "", "")},
			want:   "a sign reading hi@example.com",
		},
		{
			// THE DELIBERATE EXCEPTION: identity beats the email guard. If the
			// attached element really is named "example", the tag that
			// attached it is the one in that address — the web resolves with
			// TAG_PATTERN, which has no lead constraint and reads "@example"
			// out of "hi@example.com" the same way. Refusing here would put
			// the two sides back out of step.
			name:   "an element actually named like the domain still binds",
			prompt: "a sign reading hi@example.com",
			refs:   []store.SceneReference{imageRef(1, "example", "", "")},
			want:   "a sign reading hi@image1.com",
		},
		{
			// NOT FIXED, recorded rather than hidden. "@bottle" is preceded by
			// 'n', the shape of an email local part, and nothing in the text
			// distinguishes "@jen@bottle" from "hi@example". Leaving it is the
			// smaller error: an unresolvable token was already reaching kie
			// unchanged before any of this, whereas mangling an address the
			// operator typed is damage this code would introduce.
			name:   "adjacent tags: the winner binds, the neighbour keeps its @",
			prompt: "@jen@bottle at a counter",
			refs:   []store.SceneReference{imageRef(1, "jen", "", "")},
			want:   "@image1@bottle at a counter",
		},
		{
			name:   "a bare @ is not a tag",
			prompt: "the @ symbol on a poster",
			refs:   []store.SceneReference{imageRef(1, "jen", "", "")},
			want:   "the @ symbol on a poster",
		},
		{
			name:   "a prompt with no tags is returned unchanged",
			prompt: "a woman at a kitchen counter, handheld",
			refs:   []store.SceneReference{imageRef(1, "jen", "", "")},
			want:   "a woman at a kitchen counter, handheld",
		},
		{
			name:   "no references binds nothing and leaves readable words",
			prompt: "@jen at a counter",
			refs:   nil,
			want:   "jen at a counter",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := bindUITags(tt.prompt, ordinalByTag(tt.refs), deletedTagSet(tt.refs), true); got != tt.want {
				t.Errorf("bindUITags(%q) = %q, want %q", tt.prompt, got, tt.want)
			}
		})
	}
}

// The same guard's false positive: prose containing "@image" as a substring.
func TestPromptForSceneIsNotConfusedByAnEmailThatLooksLikeATag(t *testing.T) {
	prompt := "she emails hello@imagen.co from the counter"
	scene := store.Scene{VideoPrompt: &prompt, ProjectKind: "clip"}

	got := promptForScene(scene, []store.SceneReference{imageRef(1, "jen", "", "")}, false, kie.Model{SupportsRoleReferences: true})
	if !strings.Contains(got, "hello@imagen.co") {
		t.Errorf("an email address was rewritten: %q", got)
	}
}

// The SCRIPTED pipeline shares promptForScene and must be left alone. Its
// prompts are compiled against a template that already handles composition,
// and prepending a reference declaration would rewrite every scene it
// produces — a change that pipeline never asked for. An earlier version did
// exactly that, and only the scripted route's own tests caught it.
func TestPromptForSceneLeavesTheScriptedPipelineAlone(t *testing.T) {
	prompt := "a woman speaks to camera in a sunlit kitchen"
	scene := store.Scene{VideoPrompt: &prompt, ProjectKind: "scripted"}

	got := promptForScene(scene, []store.SceneReference{imageRef(1, "", "", "")}, false, kie.Model{SupportsRoleReferences: true})
	if got != prompt {
		t.Errorf("a scripted scene's prompt was rewritten:\n got  %q\n want %q", got, prompt)
	}
}

// A scene with nothing to render gets no instructions about a picture. An
// earlier version turned "" into a submission whose entire prompt was
// instructions about a reference, with no scene described at all.
func TestPromptForSceneDeclaresNothingForAnEmptyPrompt(t *testing.T) {
	refs := []store.SceneReference{imageRef(1, "jen", "", "")}
	if got := promptForScene(store.Scene{ProjectKind: "clip"}, refs, false, kie.Model{SupportsRoleReferences: true}); got != "" {
		t.Errorf("an empty prompt produced %q, want empty", got)
	}
}

// Spoken dialogue is quoted verbatim into the prompt, and rewriting speech is
// a different act from binding a reference — so the rewrite runs on the base
// prompt only, before the append.
func TestPromptForSceneLeavesSpokenDialogueAlone(t *testing.T) {
	video := "@jen at a counter"
	line := "Email us at hi@example.com"
	scene := store.Scene{VideoPrompt: &video, ScriptLine: &line, ProjectKind: "clip"}
	refs := []store.SceneReference{imageRef(1, "jen", "character", "")}

	got := promptForScene(scene, refs, true, kie.Model{SupportsRoleReferences: true})
	// No declaration prefix: /ugc sends no reference images, so there is no
	// index to explain. Only the binding and the dialogue append remain.
	want := `@image1 at a counter Dialogue, spoken aloud on camera: "Email us at hi@example.com"`
	if got != want {
		t.Errorf("promptForScene() = %q, want %q", got, want)
	}
}

// 0072's whole point: once Refine has run, the vendor gets Claude's prose,
// not the operator's "@name" text — so if this loses, kie is sent a raw tag
// it cannot resolve and the render either fails or points at the wrong
// picture.
func TestPromptForSceneAIGeneratedPromptWinsOverVideoPrompt(t *testing.T) {
	video := "@jen at a counter"
	ai := "The woman with ash-blonde hair stands at a counter"
	scene := store.Scene{VideoPrompt: &video, AIGeneratedPrompt: &ai, ProjectKind: "clip"}

	got := promptForScene(scene, nil, false, kie.Model{SupportsRoleReferences: true})
	if got != ai {
		t.Errorf("promptForScene() = %q, want the ai_generated_prompt %q", got, ai)
	}
}

// Null ai_generated_prompt is the ordinary case — no operator has pressed
// Refine on this scene yet — and it must fall through to exactly the
// video_prompt path that ran before 0072 existed, tags and all. Losing this
// would mean every scene ever rendered without Refine silently renders
// differently the moment this column was added.
func TestPromptForSceneFallsBackToVideoPromptWhenAIPromptIsNil(t *testing.T) {
	video := "@jen at a counter"
	scene := store.Scene{VideoPrompt: &video, AIGeneratedPrompt: nil, ProjectKind: "clip"}
	refs := []store.SceneReference{imageRef(1, "jen", "character", "")}

	got := promptForScene(scene, refs, false, kie.Model{SupportsRoleReferences: true})
	want := "@image1 at a counter"
	if got != want {
		t.Errorf("promptForScene() = %q, want %q", got, want)
	}
}

// The spoken-dialogue append is keyed off scene.VideoPrompt/scene.ScriptLine,
// not off which text won as the base — so a refined scene must still get its
// line appended, or a talking-head clip refined once goes silent.
func TestPromptForSceneAppendsSpeechWithAIGeneratedPromptAsBase(t *testing.T) {
	video := "@jen at a counter"
	ai := "The woman with ash-blonde hair stands at a counter"
	line := "Try our new blend today"
	scene := store.Scene{VideoPrompt: &video, AIGeneratedPrompt: &ai, ScriptLine: &line, ProjectKind: "clip"}

	got := promptForScene(scene, nil, true, kie.Model{SupportsRoleReferences: true})
	want := ai + ` Dialogue, spoken aloud on camera: "Try our new blend today"`
	if got != want {
		t.Errorf("promptForScene() = %q, want %q", got, want)
	}
}
