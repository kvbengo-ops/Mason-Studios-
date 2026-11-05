package store

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

// The seam that decides which model gets BILLED for a scene, and the one
// thing about it nothing tested.
//
// Scene.RenderSettings is documented as "the EFFECTIVE render settings":
// projects.render_settings merged with scenes.render_settings_override via
// `p.render_settings || coalesce(s.render_settings_override, '{}'::jsonb)`,
// done in SQL inside every query that populates the field. Both sides of
// that merge were read and reasoned about; neither was executed.
//
// It matters more now than when 0045 landed. The override used to be
// written only by the retry path, and only ever `{"model": …}`. As of
// 2026-08-29 the scene header lets an operator set model, resolution AND
// fps for one scene — the hybrid the product's cost model depends on
// (an expensive model on the scene carrying the ad, a cheap one elsewhere).
// If this merge is wrong, that scene renders on the project's model at the
// project's resolution and the operator is billed for a choice the
// interface told them they had made.
//
// jsonb `||` is a SHALLOW right-wins merge, which is exactly the semantic
// wanted here and exactly the semantic that is easy to assume without
// checking: the override wins per key, and any key it omits still inherits
// the project's live value rather than being blanked.
//
// DB-backed, and gated on TEST_DATABASE_URL like every other test in this
// package. Stated plainly because this repo has been bitten by the
// opposite: I could not run this locally (no Docker, no Postgres in this
// environment), so it has been executed only by CI, which supplies a real
// Postgres with migrations applied. It has NOT had the break-it-and-watch-
// it-fail treatment the rest of today's tests got.
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/store -run ClaimMerges
func TestClaimMergesSceneOverrideOverProjectSettings(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping database-backed test")
	}

	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { s.Close() })

	projectID, sceneID := seedRenderingScene(ctx, t, s)

	// A full project setting, and an override that changes two of its three
	// keys while omitting the third. The omission is the interesting half:
	// fps must still arrive as the project's 24, not disappear.
	if _, err := s.pool.Exec(ctx, `
UPDATE projects SET render_settings = $1::jsonb WHERE id = $2`,
		`{"model":"seedance-2.5","resolution":"720p","fps":24}`, projectID); err != nil {
		t.Fatalf("set project settings: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `
UPDATE scenes SET status = 'queued', render_settings_override = $1::jsonb WHERE id = $2`,
		`{"model":"kling-3.0-pro","resolution":"1080p"}`, sceneID); err != nil {
		t.Fatalf("set scene override: %v", err)
	}

	claimed, err := s.ClaimQueuedScenes(ctx, 10)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}

	var scene *Scene
	for i := range claimed {
		if claimed[i].ID == sceneID {
			scene = &claimed[i]
			break
		}
	}
	if scene == nil {
		t.Fatalf("claim did not return the seeded scene %s", sceneID)
	}

	var got map[string]any
	if err := json.Unmarshal(scene.RenderSettings, &got); err != nil {
		t.Fatalf("render settings were not decodable jsonb: %v (%s)", err, scene.RenderSettings)
	}

	// The override wins where it speaks...
	if got["model"] != "kling-3.0-pro" {
		t.Fatalf("model = %v, want the scene's override kling-3.0-pro", got["model"])
	}
	if got["resolution"] != "1080p" {
		t.Fatalf("resolution = %v, want the scene's override 1080p", got["resolution"])
	}
	// ...and the project still speaks where the override is silent. A merge
	// that replaced instead of merging would drop fps entirely, and
	// ParseRenderSettings would quietly substitute the model's default —
	// a wrong frame rate nobody chose and no error anywhere.
	if fps, ok := got["fps"].(float64); !ok || fps != 24 {
		t.Fatalf("fps = %v, want the project's 24 to survive an override that omits it", got["fps"])
	}
}

// The normal case, and the one 0045 promised would be untouched: a scene
// with no override at all must come back bit-for-bit as the project's own
// settings, exactly as it did before that column existed.
func TestClaimLeavesSettingsAloneWithoutAnOverride(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping database-backed test")
	}

	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { s.Close() })

	projectID, sceneID := seedRenderingScene(ctx, t, s)

	if _, err := s.pool.Exec(ctx, `
UPDATE projects SET render_settings = $1::jsonb WHERE id = $2`,
		`{"model":"seedance-2.5","resolution":"720p","fps":24}`, projectID); err != nil {
		t.Fatalf("set project settings: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `
UPDATE scenes SET status = 'queued', render_settings_override = NULL WHERE id = $1`,
		sceneID); err != nil {
		t.Fatalf("queue scene: %v", err)
	}

	claimed, err := s.ClaimQueuedScenes(ctx, 10)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}

	var scene *Scene
	for i := range claimed {
		if claimed[i].ID == sceneID {
			scene = &claimed[i]
			break
		}
	}
	if scene == nil {
		t.Fatalf("claim did not return the seeded scene %s", sceneID)
	}

	var got map[string]any
	if err := json.Unmarshal(scene.RenderSettings, &got); err != nil {
		t.Fatalf("render settings were not decodable jsonb: %v (%s)", err, scene.RenderSettings)
	}
	if got["model"] != "seedance-2.5" || got["resolution"] != "720p" {
		t.Fatalf("a scene with no override changed the project's settings: %v", got)
	}
}
