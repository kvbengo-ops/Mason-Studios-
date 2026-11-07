package store

// A NOTE ON POOL LIFETIME, because this file got it wrong once.
//
// The stores below close with t.Cleanup, never `defer store.Close()`. Go runs
// deferred calls BEFORE registered cleanups, so a `defer` close means any
// t.Cleanup that deletes a seeded row runs against a pool that is already
// gone — silently, since a cleanup can only t.Logf its failure. The row
// survives, the test still passes, and the litter breaks a different test in
// another file several runs later.
//
// That is not hypothetical: this file's own final_versions cleanup logged
// "closed pool" on every run from the day it was written, and the rows it was
// meant to delete accumulated until
// TestReleaseStaleFinalVersionLeases_FreshLeaseIsNotReleased failed on code
// that had not changed. The repo had already learned this once (commit
// bb67c7e, "defer s.Close() beats t.Cleanup to the pool"); this file
// reintroduced it.

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// The MODE partition, tested against the predicate rather than the prose.
//
// This is the mechanism that exists because of a real incident: web/.env.local
// points at the production Supabase project, the deployed worker polls the
// same `scenes` table a local one does, and a locally "mocked" render was
// claimed and billed for real. The lesson was that a mock flag decides what a
// worker does AFTER it claims a job and has no say in who claims it, so the
// gate had to move into the row — scenes.dev (0063) and final_versions.dev
// (0069).
//
// Until this file, nothing proved the gate actually holds. web/lib/dev-seam.test.ts
// sweeps the SOURCE for writers that forget to stamp the flag, which is a
// different question: it can tell you the column is being written, never that
// the queries honour it. Four SQL predicates carry the whole contract, and a
// missing `AND dev = $n` in any one of them is invisible to every other test
// in this repo — including, before this file, to the two that specifically
// exercise ClaimQueuedScenes.
//
// Needs a real Postgres for the same reason MarkFailed's own test does: what
// is under test is a WHERE clause. A fake would be testing itself.
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/store -run DevPartition
func requireTestDB(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping database-backed test")
	}
	return dsn
}

// seedQueuedSceneWithDev makes one project owned by a fresh approved user with
// a single scene at 'queued', stamped with the given mode.
func seedQueuedSceneWithDev(ctx context.Context, t *testing.T, s *Store, dev bool) (projectID, sceneID string) {
	t.Helper()

	// Same unique-user dance seedRenderingScene documents: handle_new_user
	// derives a username from the email when meta is absent, and two emails
	// can collapse to one username across repeated runs.
	var rawUUID string
	if err := s.pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&rawUUID); err != nil {
		t.Fatalf("seed unique id: %v", err)
	}
	rawID := strings.ReplaceAll(rawUUID, "-", "")
	username := ("d" + rawID)[:20]
	email := fmt.Sprintf("devpartition-test-%s@example.test", rawID)

	var userID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES (gen_random_uuid(), $1, jsonb_build_object('username', $2::text))
RETURNING id`, email, username).Scan(&userID); err != nil {
		t.Fatalf("seed auth user: %v", err)
	}
	setProfileStatus(ctx, t, s, userID, "active")

	if err := s.pool.QueryRow(ctx, `
INSERT INTO projects (user_id, title) VALUES ($1, 'dev partition test')
RETURNING id`, userID).Scan(&projectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}

	// A queued scene needs a reference frame to be a realistic claim
	// candidate — ClaimQueuedScenes does not filter on it, but dispatch fails
	// a frameless scene immediately, so seeding one keeps this fixture
	// honest about what it represents.
	var assetID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO assets (project_id, kind, storage_key)
VALUES ($1, 'ref_frame', 'projects/seed/ref_frame/dev-partition.png')
RETURNING id`, projectID).Scan(&assetID); err != nil {
		t.Fatalf("seed asset: %v", err)
	}

	if err := s.pool.QueryRow(ctx, `
INSERT INTO scenes (project_id, idx, video_prompt, duration_s, status, ref_frame_asset_id, dev)
VALUES ($1, 1, 'dev partition fixture', 4, 'queued', $2, $3)
RETURNING id`, projectID, assetID, dev).Scan(&sceneID); err != nil {
		t.Fatalf("seed scene: %v", err)
	}

	// Everything above is deleted afterwards, in dependency order.
	//
	// This helper originally cleaned up nothing at all, and every run left a
	// user, a project, an asset and a scene behind: 136 projects and 137
	// profiles had accumulated in the scratch database before anyone counted.
	// None of it broke a test — every assertion here is scoped to an id — but
	// that is exactly why it grew. seedUser in rls_allowance_runs_assets_test.go
	// has always torn its rows down; this file simply did not copy that part.
	//
	// deleted_project_cost_history is included because deleting a project
	// FIRES archive_project_cost_history, which writes a row there by design.
	// A cleanup that forgets it trades four leaked tables for one.
	//
	// t.Errorf rather than t.Logf, deliberately: a cleanup that fails silently
	// is how this got to 136 in the first place.
	t.Cleanup(func() {
		bg := context.Background()
		for _, q := range []struct {
			sql string
			arg string
		}{
			{`DELETE FROM scenes WHERE project_id = $1`, projectID},
			{`DELETE FROM assets WHERE project_id = $1`, projectID},
			{`DELETE FROM final_versions WHERE project_id = $1`, projectID},
			{`DELETE FROM projects WHERE id = $1`, projectID},
			{`DELETE FROM deleted_project_cost_history WHERE project_id = $1`, projectID},
			{`DELETE FROM profiles WHERE id = $1`, userID},
			{`DELETE FROM auth.users WHERE id = $1`, userID},
		} {
			if _, err := s.pool.Exec(bg, q.sql, q.arg); err != nil {
				t.Errorf("cleanup %q: %v", q.sql, err)
			}
		}
	})

	return projectID, sceneID
}

func containsScene(scenes []Scene, id string) bool {
	for _, scene := range scenes {
		if scene.ID == id {
			return true
		}
	}
	return false
}

// TestDevPartition_ClaimQueuedScenes is the whole contract in one test: each
// worker sees its own rows and cannot see the other's.
//
// Both directions are asserted, and the second is the one that matters. A
// production worker claiming a dev row wastes a mock. A DEV worker claiming a
// production row bills a real vendor for a render nobody asked for, which is
// the incident this column exists to prevent.
func TestDevPartition_ClaimQueuedScenes(t *testing.T) {
	dsn := requireTestDB(t)
	ctx := context.Background()

	prodStore, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("New(prod): %v", err)
	}
	t.Cleanup(prodStore.Close)

	devStore, err := New(ctx, dsn, true)
	if err != nil {
		t.Fatalf("New(dev): %v", err)
	}
	t.Cleanup(devStore.Close)

	_, prodScene := seedQueuedSceneWithDev(ctx, t, prodStore, false)
	_, devScene := seedQueuedSceneWithDev(ctx, t, prodStore, true)

	// A large limit on purpose: this must fail because of the predicate, not
	// because the row happened to fall outside a small page.
	devClaimed, err := devStore.ClaimQueuedScenes(ctx, 100, 0)
	if err != nil {
		t.Fatalf("dev ClaimQueuedScenes: %v", err)
	}
	if containsScene(devClaimed, prodScene) {
		t.Error("a MODE=development worker claimed a production scene — this is the render that gets billed for real")
	}
	if !containsScene(devClaimed, devScene) {
		t.Error("a MODE=development worker did not claim its own scene; the partition is filtering too much, not too little")
	}

	prodClaimed, err := prodStore.ClaimQueuedScenes(ctx, 100, 0)
	if err != nil {
		t.Fatalf("prod ClaimQueuedScenes: %v", err)
	}
	if containsScene(prodClaimed, devScene) {
		t.Error("a MODE=production worker claimed a development scene")
	}
	if !containsScene(prodClaimed, prodScene) {
		t.Error("a MODE=production worker did not claim its own scene")
	}
}

// TestDevPartition_StaleRendering is the dangerous one.
//
// StaleRendering feeds Reconcile, which after ReconcileGiveUpAfter calls
// MarkFailed. Without the filter, a dev worker reconciling against the shared
// database looks up a PRODUCTION scene's vendor request id, does not recognise
// it, and eventually fails a paying customer's render that was progressing
// perfectly well. That is worse than the incident the column was written for:
// the original cost money, this destroys work.
func TestDevPartition_StaleRendering(t *testing.T) {
	dsn := requireTestDB(t)
	ctx := context.Background()

	prodStore, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("New(prod): %v", err)
	}
	t.Cleanup(prodStore.Close)

	devStore, err := New(ctx, dsn, true)
	if err != nil {
		t.Fatalf("New(dev): %v", err)
	}
	t.Cleanup(devStore.Close)

	_, prodScene := seedQueuedSceneWithDev(ctx, t, prodStore, false)

	// Move it to 'rendering' and backdate the submission so it is stale by
	// any threshold this test asks about.
	if _, err := prodStore.pool.Exec(ctx, `
UPDATE scenes
SET status = 'rendering', submitted_at = now() - interval '2 hours'
WHERE id = $1`, prodScene); err != nil {
		t.Fatalf("age the production scene: %v", err)
	}

	stale, err := devStore.StaleRendering(ctx, time.Minute)
	if err != nil {
		t.Fatalf("dev StaleRendering: %v", err)
	}
	if containsScene(stale, prodScene) {
		t.Error("a MODE=development worker saw a production scene as stale — Reconcile would eventually MarkFailed a real customer's render")
	}

	prodStale, err := prodStore.StaleRendering(ctx, time.Minute)
	if err != nil {
		t.Fatalf("prod StaleRendering: %v", err)
	}
	if !containsScene(prodStale, prodScene) {
		t.Error("a MODE=production worker did not see its own stale scene; reconcile would never recover it")
	}
}

// TestDevPartition_ClaimCeilingIgnoresProductionRenders pins the third
// predicate. It was CountRendering's own test until the ceiling moved inside
// ClaimQueuedScenes' LIMIT — one statement, so the cap holds across worker
// instances instead of only within one — and the invariant moved with it: a
// `dev = $2` on the candidate CTE but not on the count would be invisible to
// every other test here, including the one directly above.
//
// This one governs concurrency rather than correctness — a dev worker
// counting production renders throttles itself for no reason, and a
// production worker counting dev renders under-uses the vendor it is paying
// for.
func TestDevPartition_ClaimCeilingIgnoresProductionRenders(t *testing.T) {
	dsn := requireTestDB(t)
	ctx := context.Background()

	devStore, err := New(ctx, dsn, true)
	if err != nil {
		t.Fatalf("New(dev): %v", err)
	}
	t.Cleanup(devStore.Close)

	// The scratch database carries whatever is mid-flight from elsewhere, so
	// the ceiling is derived from this mode's real in-flight count rather
	// than assumed to be zero: devRendering+1 leaves exactly one free slot,
	// whatever else is running.
	var devRendering int
	if err := devStore.pool.QueryRow(ctx,
		`SELECT count(*) FROM scenes WHERE status = 'rendering' AND dev = true`,
	).Scan(&devRendering); err != nil {
		t.Fatalf("count dev rendering: %v", err)
	}

	// A production render in flight. Uncounted, it is invisible to a dev
	// worker; counted, it eats the single free slot below.
	_, prodScene := seedQueuedSceneWithDev(ctx, t, devStore, false)
	if _, err := devStore.pool.Exec(ctx,
		`UPDATE scenes SET status = 'rendering' WHERE id = $1`, prodScene); err != nil {
		t.Fatalf("set production scene rendering: %v", err)
	}

	seedQueuedSceneWithDev(ctx, t, devStore, true)

	claimed, err := devStore.ClaimQueuedScenes(ctx, devRendering+1, 0)
	if err != nil {
		t.Fatalf("ClaimQueuedScenes: %v", err)
	}
	// Not containsScene: with one slot and a shared database, an older dev
	// scene queued by another test may legitimately win the round-robin. That
	// the slot was filled AT ALL is the assertion — an unscoped count fills
	// none.
	if len(claimed) == 0 {
		t.Errorf("a MODE=development worker with a free slot (ceiling %d, %d dev renders in flight) claimed nothing: the ceiling counted a production render",
			devRendering+1, devRendering)
	}
}

// TestDevPartition_ClaimPendingFinalVersions covers the assemble queue, added
// in 0069 after an audit found the render queue partitioned and this one wide
// open. A dev worker claiming a production build runs ffmpeg over real clips
// and writes a real delivered artifact — no vendor is billed, which is exactly
// why it was missed, and the cost is a wrong file handed to a customer.
func TestDevPartition_ClaimPendingFinalVersions(t *testing.T) {
	dsn := requireTestDB(t)
	ctx := context.Background()

	prodStore, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("New(prod): %v", err)
	}
	t.Cleanup(prodStore.Close)

	devStore, err := New(ctx, dsn, true)
	if err != nil {
		t.Fatalf("New(dev): %v", err)
	}
	t.Cleanup(devStore.Close)

	projectID, sceneID := seedQueuedSceneWithDev(ctx, t, prodStore, false)
	// ClaimPendingFinalVersions only considers a project whose scenes are all
	// terminal and at least one is 'done'.
	if _, err := prodStore.pool.Exec(ctx,
		`UPDATE scenes SET status = 'done' WHERE id = $1`, sceneID); err != nil {
		t.Fatalf("finish the scene: %v", err)
	}

	var finalID string
	if err := prodStore.pool.QueryRow(ctx, `
INSERT INTO final_versions (project_id, recipe, dev)
VALUES ($1, '[]'::jsonb, false)
RETURNING id`, projectID).Scan(&finalID); err != nil {
		t.Fatalf("seed final version: %v", err)
	}

	// Delete it afterwards. A claimed-but-unbuilt row left behind is not inert
	// fixture litter: ReleaseStaleFinalVersionLeases counts every one it finds,
	// so the next run of that test sees leases it did not create and fails on a
	// count. Learned the hard way — an earlier version of this test left one
	// row behind and broke two unrelated tests in another file.
	t.Cleanup(func() {
		if _, err := prodStore.pool.Exec(context.Background(),
			`DELETE FROM final_versions WHERE id = $1`, finalID); err != nil {
			t.Logf("cleanup final version: %v", err)
		}
	})

	devClaimed, err := devStore.ClaimPendingFinalVersions(ctx, 100)
	if err != nil {
		t.Fatalf("dev ClaimPendingFinalVersions: %v", err)
	}
	for _, pending := range devClaimed {
		if pending.ID == finalID {
			t.Error("a MODE=development worker claimed a production build — it would write a real delivered artifact")
		}
	}

	prodClaimed, err := prodStore.ClaimPendingFinalVersions(ctx, 100)
	if err != nil {
		t.Fatalf("prod ClaimPendingFinalVersions: %v", err)
	}
	found := false
	for _, pending := range prodClaimed {
		if pending.ID == finalID {
			found = true
		}
	}
	if !found {
		t.Error("a MODE=production worker did not claim its own build; the partition is filtering too much")
	}
}
