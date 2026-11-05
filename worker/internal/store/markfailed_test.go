package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

// TestMarkFailedTwiceInsertsOneRun pins the guard that keeps a doubly-observed
// failure from being billed twice. The webhook handler and the reconcile loop
// both reach MarkFailed for the same scene as a matter of routine — a webhook
// landing just after reconcile gave up on the render — and under the old
// `WHERE status != 'done'` guard the second caller passed straight through
// ('failed' is not 'done'), committing a second runs row carrying the same
// cost_usd. Two rows, one render, double the money on the spend caps.
//
// This has to hit a real Postgres: "the second call inserts nothing" is a
// statement about the transaction rolling back when the UPDATE matches no
// rows, which no fake reproduces — a stub that returns whatever it was told
// to return would only be testing itself.
//
// Gated on TEST_DATABASE_URL rather than DATABASE_URL on purpose: this test
// writes fixture rows, and reusing the ordinary connection variable would
// point it at a live dev database the first time someone runs `make check`
// with their normal env loaded. Point it at a scratch database (`supabase
// db reset` gives you one) to run it:
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/store -run MarkFailed
func TestMarkFailedTwiceInsertsOneRun(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping database-backed test")
	}

	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Not a defer: defers run before t.Cleanup funcs, and t.Cleanup funcs
	// run LIFO. seedRenderingScene below registers row-deleting cleanups;
	// registering the close here, before seeding, means it runs AFTER
	// those cleanups (LIFO) instead of before them, so the deletes hit a
	// live pool instead of a closed one.
	t.Cleanup(func() { s.Close() })
	if err := s.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}

	projectID, sceneID := seedRenderingScene(ctx, t, s)

	reason := "fal reported status ERROR"
	cost := 0.42
	requestID := "fal-markfailed-request-1"
	run := Run{
		ProjectID: projectID,
		KieTaskID: &requestID,
		Vendor:    "fal",
		Model:     "fal-ai/ltx-video-13b-distilled/image-to-video",
		CostUSD:   &cost,
		Error:     &reason,
	}

	// First caller — the reconcile loop, say — wins and records the cost.
	if err := s.MarkFailed(ctx, sceneID, run); err != nil {
		t.Fatalf("first MarkFailed: unexpected error: %v", err)
	}

	// Second caller — the late webhook — must find nothing left to fail.
	err = s.MarkFailed(ctx, sceneID, run)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("second MarkFailed: got %v, want ErrNotFound", err)
	}

	var runCount int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM runs WHERE scene_id = $1`, sceneID,
	).Scan(&runCount); err != nil {
		t.Fatalf("count runs: %v", err)
	}
	if runCount != 1 {
		t.Errorf("runs rows for scene = %d, want 1 (the second call's insert must roll back)", runCount)
	}

	var gotRequestID *string
	if err := s.pool.QueryRow(ctx,
		`SELECT kie_task_id FROM runs WHERE scene_id = $1`, sceneID,
	).Scan(&gotRequestID); err != nil {
		t.Fatalf("read run kie_task_id: %v", err)
	}
	if gotRequestID == nil || *gotRequestID != requestID {
		t.Errorf("runs.kie_task_id = %v, want %q", gotRequestID, requestID)
	}

	var status string
	if err := s.pool.QueryRow(ctx,
		`SELECT status FROM scenes WHERE id = $1`, sceneID,
	).Scan(&status); err != nil {
		t.Fatalf("read scene status: %v", err)
	}
	if status != "failed" {
		t.Errorf("scene status = %q, want %q", status, "failed")
	}
}

// seedRenderingScene creates the auth.users -> profiles -> projects -> scenes
// chain a scene needs to exist at all, and registers cleanup. Returns the
// project and scene ids.
func seedRenderingScene(ctx context.Context, t *testing.T, s *Store) (projectID, sceneID string) {
	t.Helper()

	// Each seeded user gets a unique email and an explicit
	// raw_user_meta_data.username so handle_new_user() (0015_profile_username.sql:137)
	// takes the meta_username branch instead of its email-derived fallback —
	// two different emails can still collapse to the same fallback username
	// (lowercase local-part, [^a-z0-9_] stripped, truncated to 20 chars), which
	// collides on profiles_username_lower_idx across repeated test runs.
	// The trigger (handle_new_user, 0004_profile_trigger.sql, extended by 0015)
	// already inserts the profiles row, so there is no separate insert here.
	var rawUUID string
	if err := s.pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&rawUUID); err != nil {
		t.Fatalf("seed unique id: %v", err)
	}
	rawID := strings.ReplaceAll(rawUUID, "-", "")
	username := ("t" + rawID)[:20]
	email := fmt.Sprintf("markfailed-test-%s@example.test", rawID)

	var userID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES (gen_random_uuid(), $1, jsonb_build_object('username', $2::text))
RETURNING id`, email, username).Scan(&userID); err != nil {
		t.Fatalf("seed auth user: %v", err)
	}

	// Approve the account the same instant it exists: handle_new_user leaves
	// it 'pending' (0052_account_approval.sql), and a pending owner is denied
	// every write policy that carries is_active() — see setProfileStatus in
	// rls_allowance_runs_assets_test.go.
	setProfileStatus(ctx, t, s, userID, "active")

	if err := s.pool.QueryRow(ctx, `
INSERT INTO projects (user_id, title) VALUES ($1, 'markfailed race test')
RETURNING id`, userID).Scan(&projectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}

	if err := s.pool.QueryRow(ctx, `
INSERT INTO scenes (project_id, idx, status) VALUES ($1, 0, 'rendering')
RETURNING id`, projectID).Scan(&sceneID); err != nil {
		t.Fatalf("seed scene: %v", err)
	}

	t.Cleanup(func() {
		// Order matters: projects.user_id has no ON DELETE CASCADE, so the
		// project goes first (taking scenes, runs and assets with it).
		for _, q := range []struct{ sql, arg string }{
			{`DELETE FROM projects WHERE id = $1`, projectID},
			{`DELETE FROM profiles WHERE id = $1`, userID},
			{`DELETE FROM auth.users WHERE id = $1`, userID},
		} {
			if _, err := s.pool.Exec(context.Background(), q.sql, q.arg); err != nil {
				t.Errorf("cleanup %q: %v", q.sql, err)
			}
		}
	})

	return projectID, sceneID
}
