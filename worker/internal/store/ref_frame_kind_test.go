package store

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// ReferencesForScene falls back to scenes.ref_frame_asset_id when a scene has
// no scene_references rows, and that fallback used to return a hardcoded
// Kind: "image".
//
// That was true of every asset which could reach that column before audio
// existed, and stopped being true the moment it did: /ugc writes the chosen
// reference's id there whatever it is, so picking a voice as the primary
// reference puts an audio asset in it. Calling that an image sends an MP3 in
// reference_image_urls, which kie refuses AFTER the submission — a round trip
// spent to learn something we already knew, reported as a vendor problem.
//
// Reachable only when a scene has no scene_references rows at all, since
// attachSceneReferences runs on every /ugc insert. So this is a latent trap,
// and a latent trap in a fallback is the worse kind: it fires on the day
// something else has already gone wrong.

// seedSceneWithRefFrameAsset makes one project owned by a fresh approved user
// with a single scene whose ref_frame_asset_id points at an asset of the given
// kind, and deliberately NO scene_references rows — the fallback path.
func seedSceneWithRefFrameAsset(
	ctx context.Context, t *testing.T, s *Store, assetKind string,
) (sceneID string) {
	t.Helper()

	// The same unique-user dance the other seeds document: handle_new_user
	// derives a username from the email when meta is absent, and two emails
	// can collapse to one username across repeated runs.
	var rawUUID string
	if err := s.pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&rawUUID); err != nil {
		t.Fatalf("seed unique id: %v", err)
	}
	rawID := strings.ReplaceAll(rawUUID, "-", "")
	username := ("r" + rawID)[:20]
	email := fmt.Sprintf("refframekind-test-%s@example.test", rawID)

	var userID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES (gen_random_uuid(), $1, jsonb_build_object('username', $2::text))
RETURNING id`, email, username).Scan(&userID); err != nil {
		t.Fatalf("seed auth user: %v", err)
	}
	setProfileStatus(ctx, t, s, userID, "active")

	var projectID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO projects (user_id, title) VALUES ($1, 'ref frame kind test')
RETURNING id`, userID).Scan(&projectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}

	var assetID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO assets (project_id, kind, storage_key, duration_s)
VALUES ($1, $2, $3, CASE WHEN $2 = 'video_ref' THEN 7.5 ELSE NULL END)
RETURNING id`, projectID, assetKind,
		fmt.Sprintf("projects/seed/%s/ref-frame-kind", assetKind),
	).Scan(&assetID); err != nil {
		t.Fatalf("seed %s asset: %v", assetKind, err)
	}

	// 'frame_ready', NOT 'queued', and the difference is not cosmetic. The
	// scratch database is shared across this whole package, ClaimQueuedScenes
	// claims across every user, and a fixture left sitting in 'queued' is
	// indistinguishable from real work: it got claimed by the fairness tests
	// running afterwards, which then reported dropped scenes and a batch two
	// short. ReferencesForScene does not read status at all, so the fixture
	// costs nothing by parking somewhere unclaimable.
	if err := s.pool.QueryRow(ctx, `
INSERT INTO scenes (project_id, idx, video_prompt, duration_s, status, ref_frame_asset_id)
VALUES ($1, 1, 'ref frame kind fixture', 4, 'frame_ready', $2)
RETURNING id`, projectID, assetID).Scan(&sceneID); err != nil {
		t.Fatalf("seed scene: %v", err)
	}
	return sceneID
}

func TestReferencesForSceneReadsTheRefFrameKindRatherThanAssumingImage(t *testing.T) {
	dsn := requireTestDB(t)
	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(s.Close)

	for _, tc := range []struct {
		assetKind string
		wantKind  string
	}{
		// The case that was wrong. An 0079 audio asset in ref_frame_asset_id.
		{"audio", "audio"},
		// The case that was right, and must stay right — a fix that returned
		// "audio" for everything would pass the first row and be worse than
		// the bug.
		{"ref_frame", "image"},
		// assets.kind carries members scene_references.kind does not. Anything
		// that is not audio is a picture as far as the vendor is concerned,
		// and defaulting rather than erroring keeps a strange reference from
		// becoming a dead scene.
		{"character_ref", "image"},
		// The legacy fallback must preserve a measured source duration too;
		// otherwise Gemini's video_list would be silently omitted.
		{"video_ref", "video"},
	} {
		t.Run(tc.assetKind, func(t *testing.T) {
			sceneID := seedSceneWithRefFrameAsset(ctx, t, s, tc.assetKind)

			refs, err := s.ReferencesForScene(ctx, sceneID)
			if err != nil {
				t.Fatalf("ReferencesForScene: %v", err)
			}
			if len(refs) != 1 {
				t.Fatalf("got %d references, want exactly the one fallback row", len(refs))
			}
			if refs[0].Kind != tc.wantKind {
				t.Errorf(
					"a %q asset in ref_frame_asset_id came back as Kind %q, want %q — "+
						"sending it under the wrong kind is a vendor refusal after submission",
					tc.assetKind, refs[0].Kind, tc.wantKind,
				)
			}
			if refs[0].Ordinal != 1 {
				t.Errorf("Ordinal = %d, want 1", refs[0].Ordinal)
			}
			if refs[0].StorageKey == "" {
				t.Error("StorageKey is empty; the fallback read no asset at all")
			}
			if tc.assetKind == "video_ref" {
				if refs[0].DurationS == nil || *refs[0].DurationS != 7.5 {
					t.Errorf("video fallback DurationS = %v, want 7.5", refs[0].DurationS)
				}
			}
		})
	}
}
