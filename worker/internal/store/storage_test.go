package store

import (
	"strings"
	"testing"
)

func TestStorageKeyForClip(t *testing.T) {
	got := StorageKeyForClip("proj-1", "scene-2", "task-3", "mp4")
	want := "projects/proj-1/clip/scene-2-task-3.mp4"
	if got != want {
		t.Errorf("StorageKeyForClip() = %q, want %q", got, want)
	}
}

func TestStorageKeyForFinal(t *testing.T) {
	got := StorageKeyForFinal("proj-1", "ver-3", "mp4")
	want := "projects/proj-1/final/ver-3.mp4"
	if got != want {
		t.Errorf("StorageKeyForFinal() = %q, want %q", got, want)
	}
}

func TestStorageKeyForPoster(t *testing.T) {
	got := StorageKeyForPoster("proj-1", "scene-2", "task-3", "jpg")
	want := "projects/proj-1/poster/scene-2-task-3.jpg"
	if got != want {
		t.Errorf("StorageKeyForPoster() = %q, want %q", got, want)
	}
}

func TestStorageKeyForFinalPoster(t *testing.T) {
	got := StorageKeyForFinalPoster("proj-1", "ver-3", "jpg")
	want := "projects/proj-1/final/poster-ver-3.jpg"
	if got != want {
		t.Errorf("StorageKeyForFinalPoster() = %q, want %q", got, want)
	}
}

// The test that would have caught it.
//
// 0058_scene_versions.sql keeps every render of a scene, and the version rail
// offers Download and "Make current" on each. With a key built from the scene
// id alone every one of those rows addressed the SAME object, so the third
// render overwrote the first two: v1's row survived, resolved, and played v3.
// Three renders billed, one kept.
//
// The project had already learned this exact lesson for assembled finals —
// StorageKeyForFinal's own comment describes it as "data loss wearing the
// shape of success" — and the fix did not reach one level down to scene
// clips. So the invariant is written as a test this time rather than as a
// comment on the function that happened to get it right.
func TestClipKeysAreUniquePerAttempt(t *testing.T) {
	first := StorageKeyForClip("proj-1", "scene-1", "kie-task-aaa", "mp4")
	second := StorageKeyForClip("proj-1", "scene-1", "kie-task-bbb", "mp4")

	if first == second {
		t.Errorf("two renders of one scene share the key %q — the second overwrites the first, and the version rail then offers three downloads of one file", first)
	}
}

func TestPosterKeysAreUniquePerAttempt(t *testing.T) {
	first := StorageKeyForPoster("proj-1", "scene-1", "kie-task-aaa", "jpg")
	second := StorageKeyForPoster("proj-1", "scene-1", "kie-task-bbb", "jpg")

	if first == second {
		t.Errorf("two renders of one scene share the poster key %q, so every version in the rail shows the newest frame — which reads as \"these takes are identical\" rather than \"we kept one\"", first)
	}
}

// A vendor id is THEIR string. A slash in one would move the object into a
// different folder, and for projects/{projectId}/… keys that is not cosmetic:
// 0005/0048's storage policies find the project id at
// (storage.foldername(name))[2], so an extra segment moves it out from under
// the policy that guards it.
func TestKeySegmentsCannotEscapeTheProjectFolder(t *testing.T) {
	key := StorageKeyForClip("proj-1", "scene-1", "../../etc/passwd", "mp4")

	if strings.Contains(strings.TrimPrefix(key, "projects/proj-1/clip/"), "/") {
		t.Errorf("a vendor id added a path segment: %q", key)
	}
	if !strings.HasPrefix(key, "projects/proj-1/clip/") {
		t.Errorf("key left the project folder: %q", key)
	}
}
