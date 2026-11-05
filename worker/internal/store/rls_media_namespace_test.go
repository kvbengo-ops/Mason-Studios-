package store

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Guards the namespace boundary that 0048_fix_media_policy_folder_index.sql
// pins with `(storage.foldername(name))[1] = 'projects'`.
//
// 0048 corrects the media_* policies to read the project id from element [2]
// instead of [1]. Correcting the index ALONE would have matched a project id
// in the second segment under any first segment — and because 0048 grants
// access that previously resolved to nobody, that was not academic. Before the
// literal was pinned, both of these inserts succeeded as an ordinary
// authenticated user:
//
//	library/{their own project id}/planted.png
//	avatars/{their own project id}/planted.png
//
// The second is the dangerous one. 0034_profile_avatar.sql restricts the
// avatars namespace to `avatars/{user_id}/...`, but Postgres ORs permissive
// policies together: the moment media_insert independently admits a row on a
// project-id match alone, avatar_insert's `[1] = 'avatars' and [2] =
// auth.uid()::text` restriction stops mattering. One policy's looseness
// silently undoes another policy's care.
//
// This test exists because that hole was introduced by a migration written in
// this repo and caught in review rather than by a test — the migration's own
// negative controls all passed, because every one of them asked "does the
// owner get their own object" and none asked "what ELSE does this now admit".
func TestRLSMediaPolicyCannotEscapeProjectsNamespace(t *testing.T) {
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

	projectID, _ := seedRenderingScene(ctx, t, s)
	userID := projectOwner(ctx, t, s, projectID)

	// Every one of these carries the user's OWN project id in segment [2], so
	// the only thing standing between them and a successful write is the
	// pinned `[1] = 'projects'` literal.
	foreignNamespaces := []struct {
		name string
		key  string
	}{
		{"library", fmt.Sprintf("library/%s/planted.png", projectID)},
		{"avatars", fmt.Sprintf("avatars/%s/planted.png", projectID)},
		{"characters", fmt.Sprintf("characters/%s/planted.png", projectID)},
		{"bare_project_id_at_root", fmt.Sprintf("%s/clip/planted.mp4", projectID)},
	}

	for _, ns := range foreignNamespaces {
		t.Run("insert_denied_under_"+ns.name, func(t *testing.T) {
			runAsUser(ctx, t, s, userID, func(tx pgx.Tx) {
				_, err := tx.Exec(ctx,
					`insert into storage.objects (bucket_id, name) values ('media', $1)`, ns.key)
				if err == nil {
					t.Errorf("insert at %q succeeded, want RLS denial — media_* must not admit "+
						"a row outside the projects/ namespace just because segment [2] happens "+
						"to be one of the caller's project ids", ns.key)
				}
			})
		})
	}

	// The other half of the boundary: pinning the literal must not have broken
	// the access 0048 set out to grant. Without this, every assertion above
	// would still pass if media_insert denied everything again — which is the
	// exact state 0048 was written to fix.
	t.Run("legitimate_write_under_projects_still_succeeds", func(t *testing.T) {
		runAsUser(ctx, t, s, userID, func(tx pgx.Tx) {
			key := fmt.Sprintf("projects/%s/clip/legitimate.mp4", projectID)
			if _, err := tx.Exec(ctx,
				`insert into storage.objects (bucket_id, name) values ('media', $1)`, key,
			); err != nil {
				t.Errorf("insert at %q denied: %v — 0048 is supposed to admit the owner here", key, err)
			}
		})
	})
}
