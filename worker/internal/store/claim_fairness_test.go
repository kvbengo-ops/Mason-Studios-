package store

// The two properties that decide whether this queue survives twenty editors,
// neither of which had a test.
//
// Both live in one SQL statement (ClaimQueuedScenes) and neither is visible to
// any other test in this repo:
//
//  1. FAIRNESS. Scenes are ranked WITHIN each owner by age and taken in rank
//     order, so a batch interleaves users. Without that partition, one editor
//     queueing thirty clips takes every slot and everybody else waits behind
//     them. dev_partition_test.go and claim_render_settings_merge_test.go both
//     exercise this statement, and both seed exactly one user — the shape that
//     cannot tell a fair queue from a first-come one.
//
//  2. NO DOUBLE CLAIM. The UPDATE re-checks `status = 'queued'` under lock, so
//     of two workers reaching the same candidate only the first claims it. This
//     is latent today because one worker instance runs; it stops being latent
//     the moment a second is added to serve more editors, and what it protects
//     is money — a double claim is the same render submitted and billed twice.
//
// Both need a real Postgres for the same reason MarkFailed's test does: what is
// under test is a WHERE clause and a lock. A fake would be testing itself.
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/store -run Claim

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
)

// seedQueuedScenesForNewUser makes one project owned by a fresh active user
// with `count` queued scenes, oldest first, and returns their ids in that
// order. Cleanup follows seedQueuedSceneWithDev's dependency order for the
// reason documented there.
func seedQueuedScenesForNewUser(ctx context.Context, t *testing.T, s *Store, count int) []string {
	t.Helper()

	var rawUUID string
	if err := s.pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&rawUUID); err != nil {
		t.Fatalf("seed unique id: %v", err)
	}
	rawID := strings.ReplaceAll(rawUUID, "-", "")
	username := ("f" + rawID)[:20]
	email := fmt.Sprintf("claimfair-test-%s@example.test", rawID)

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
INSERT INTO projects (user_id, title) VALUES ($1, 'claim fairness test')
RETURNING id`, userID).Scan(&projectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}

	var assetID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO assets (project_id, kind, storage_key)
VALUES ($1, 'ref_frame', 'projects/seed/ref_frame/claim-fairness.png')
RETURNING id`, projectID).Scan(&assetID); err != nil {
		t.Fatalf("seed asset: %v", err)
	}

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

	ids := make([]string, 0, count)
	for i := 1; i <= count; i++ {
		var sceneID string
		// created_at is stepped explicitly rather than left to now(): the
		// ranking orders by it, and rows inserted in one loop can share a
		// timestamp to the microsecond, which would make "oldest first"
		// untestable.
		if err := s.pool.QueryRow(ctx, `
INSERT INTO scenes (project_id, idx, video_prompt, duration_s, status, ref_frame_asset_id, dev, created_at)
VALUES ($1, $2, 'claim fairness fixture', 4, 'queued', $3, false, now() - make_interval(secs => $4::int))
RETURNING id`, projectID, i, assetID, count-i).Scan(&sceneID); err != nil {
			t.Fatalf("seed scene %d: %v", i, err)
		}
		ids = append(ids, sceneID)
	}
	return ids
}

// TestClaimInterleavesUsersRatherThanDrainingOne is the fairness property, and
// the failure it guards against is silent: nothing errors, the busy editor's
// work goes through, and the quiet one simply waits. With a 30s dispatch tick
// and a 10-slot batch, being three batches back is a minute and a half of
// staring at a spinner for a clip that was queued first.
func TestClaimInterleavesUsersRatherThanDrainingOne(t *testing.T) {
	dsn := requireTestDB(t)
	ctx := context.Background()

	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(s.Close)

	// The busy editor is seeded FIRST, so every one of their scenes is older
	// than the quiet editor's. Under a plain oldest-first queue the quiet
	// editor's single clip cannot make a batch of 10 — which is exactly the
	// arrangement that tells the two orderings apart.
	busy := seedQueuedScenesForNewUser(ctx, t, s, 30)
	quiet := seedQueuedScenesForNewUser(ctx, t, s, 1)

	claimed, err := s.ClaimQueuedScenes(ctx, 10)
	if err != nil {
		t.Fatalf("ClaimQueuedScenes: %v", err)
	}

	if !containsScene(claimed, quiet[0]) {
		t.Errorf("the quiet editor's only clip was not in a batch of %d: one editor queueing %d clips can starve everyone else", len(claimed), len(busy))
	}

	// And the batch is still FULL. A queue that is fair by handing out one
	// scene per user per tick would pass the assertion above while dripping
	// work out at one clip every 30 seconds.
	if len(claimed) != 10 {
		t.Errorf("claimed %d scenes, want a full batch of 10: fairness must not cost throughput", len(claimed))
	}
}

// TestConcurrentClaimsNeverHandOutTheSameScene is the money property. Two
// workers racing on the same row must not both come away holding it: each
// claim is a kie submission, and a scene claimed twice is a render paid for
// twice.
func TestConcurrentClaimsNeverHandOutTheSameScene(t *testing.T) {
	dsn := requireTestDB(t)
	ctx := context.Background()

	seeder, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("New(seeder): %v", err)
	}
	t.Cleanup(seeder.Close)

	const scenes = 12
	seeded := seedQueuedScenesForNewUser(ctx, t, seeder, scenes)
	wanted := make(map[string]bool, scenes)
	for _, id := range seeded {
		wanted[id] = true
	}

	// Eight independent stores, each with its own pool, all asking for more
	// scenes than exist — the shape of eight worker instances whose dispatch
	// ticks land together. One store with one pool would prove far less: the
	// pool could serialise the statements on a single connection.
	const workers = 8
	claims := make([][]Scene, workers)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var claimErr error

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			w, err := New(ctx, dsn, false)
			if err != nil {
				mu.Lock()
				claimErr = err
				mu.Unlock()
				return
			}
			defer w.Close()

			got, err := w.ClaimQueuedScenes(ctx, scenes)
			if err != nil {
				mu.Lock()
				claimErr = err
				mu.Unlock()
				return
			}
			claims[i] = got
		}(i)
	}
	wg.Wait()

	if claimErr != nil {
		t.Fatalf("concurrent ClaimQueuedScenes: %v", claimErr)
	}

	claimedBy := make(map[string]int)
	total := 0
	for _, batch := range claims {
		for _, scene := range batch {
			if !wanted[scene.ID] {
				// Another test's row, or a leftover. Not this test's business.
				continue
			}
			claimedBy[scene.ID]++
			total++
		}
	}

	for id, times := range claimedBy {
		if times > 1 {
			t.Errorf("scene %s was claimed %d times: that is %d kie submissions and %d charges for one clip", id, times, times, times)
		}
	}

	// Every scene went to exactly one worker. The complement of the check
	// above: a lock that hands out nothing is not a fix.
	if total != scenes {
		t.Errorf("claimed %d of %d seeded scenes across %d workers; work was dropped, not just protected", total, scenes, workers)
	}

	// And each claimed row really is 'rendering' — the claim is the status
	// write, not a read that a follow-up might forget to make.
	var stillQueued int
	if err := seeder.pool.QueryRow(ctx, `
SELECT count(*) FROM scenes WHERE id = ANY($1) AND status <> 'rendering'`, seeded).Scan(&stillQueued); err != nil {
		t.Fatalf("verify status: %v", err)
	}
	if stillQueued != 0 {
		t.Errorf("%d claimed scenes are not 'rendering'; the claim did not stick", stillQueued)
	}
}
