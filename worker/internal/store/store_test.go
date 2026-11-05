package store

import "testing"

// sceneStatusesReadyToAssemble pins ProjectsReadyToAssemble's WHERE clause
// (see its doc comment for why this can't just be an integration test
// against a real query). The [frame_ready, done, done] case is the one
// that was silently wrong: the old SQL only excluded 'queued'/'rendering',
// so a scene reopened for correction via unfreezeScene (or one that was
// simply never queued, e.g. "test scene 1 only") did not block assembly,
// and the project's 'final' got built without it.
func TestSceneStatusesReadyToAssemble(t *testing.T) {
	cases := []struct {
		name     string
		statuses []string
		want     bool
	}{
		{
			name:     "one scene mid-correction alongside done siblings — the bug this fix closes",
			statuses: []string{"frame_ready", "done", "done"},
			want:     false,
		},
		{
			name:     "one scene never queued alongside a done sibling ('test scene 1 only')",
			statuses: []string{"draft", "done"},
			want:     false,
		},
		{
			name:     "a scene still queued",
			statuses: []string{"queued", "done"},
			want:     false,
		},
		{
			name:     "a scene still rendering",
			statuses: []string{"rendering", "done"},
			want:     false,
		},
		{
			name:     "every scene done",
			statuses: []string{"done", "done"},
			want:     true,
		},
		{
			name:     "partial delivery: done alongside a permanently failed sibling stays ready",
			statuses: []string{"done", "failed"},
			want:     true,
		},
		{
			name:     "every scene failed: terminal, but nothing to assemble",
			statuses: []string{"failed", "failed"},
			want:     false,
		},
		{
			name:     "no scenes at all",
			statuses: []string{},
			want:     false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sceneStatusesReadyToAssemble(tc.statuses); got != tc.want {
				t.Errorf("sceneStatusesReadyToAssemble(%v) = %v, want %v", tc.statuses, got, tc.want)
			}
		})
	}
}
