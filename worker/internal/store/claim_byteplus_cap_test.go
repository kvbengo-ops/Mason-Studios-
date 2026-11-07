package store

import (
	"context"
	"testing"
	"time"

	"ugc-pipeline/worker/internal/kie"
)

// BytePlus congestion is backpressure, not failure: over byteplusCap a
// BytePlus scene is simply not claimed, so it stays 'queued' (the worker can
// never move a claimed scene back), while kie scenes keep every free slot.
//
// DB-backed, gated on TEST_DATABASE_URL like every other test here. The cap
// is global to this MODE and a shared CI database may hold other BytePlus
// rows in flight, so each test measures BytePlusInflight first and sets the
// cap relative to it.
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/store -run BytePlus
func seedBytePlusAndKieQueue(ctx context.Context, t *testing.T, s *Store) (bp, kieIDs []string) {
	t.Helper()
	// Oldest first: four BytePlus scenes, then two kie scenes.
	ids := seedQueuedScenesForNewUser(ctx, t, s, 6)
	bp, kieIDs = ids[:4], ids[4:]
	if _, err := s.pool.Exec(ctx, `
UPDATE scenes SET render_settings_override = jsonb_build_object('model', $1::text)
WHERE id = ANY($2)`, kie.BytePlusSeedance25ID, bp); err != nil {
		t.Fatalf("mark BytePlus scenes: %v", err)
	}
	return bp, kieIDs
}

func inflight(ctx context.Context, t *testing.T, s *Store) int {
	t.Helper()
	n, err := s.BytePlusInflight(ctx)
	if err != nil {
		t.Fatalf("BytePlusInflight: %v", err)
	}
	return n
}

func claimedAmong(claimed []Scene, ids []string) map[string]bool {
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	got := map[string]bool{}
	for _, sc := range claimed {
		if want[sc.ID] {
			got[sc.ID] = true
		}
	}
	return got
}

func statusOf(ctx context.Context, t *testing.T, s *Store, id string) string {
	t.Helper()
	var st string
	if err := s.pool.QueryRow(ctx, `SELECT status FROM scenes WHERE id = $1`, id).Scan(&st); err != nil {
		t.Fatalf("read status %s: %v", id, err)
	}
	return st
}

func TestClaimKeepsOverCapBytePlusQueuedAndStillFillsKie(t *testing.T) {
	dsn := requireTestDB(t)
	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(s.Close)

	bp, kieIDs := seedBytePlusAndKieQueue(ctx, t, s)
	base := inflight(ctx, t, s)
	limit := base + 2

	claimed, err := s.ClaimQueuedScenes(ctx, 1000, limit)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	got := claimedAmong(claimed, append(append([]string{}, bp...), kieIDs...))
	// The two OLDEST BytePlus scenes, and both kie scenes despite BytePlus
	// being full.
	for _, id := range []string{bp[0], bp[1], kieIDs[0], kieIDs[1]} {
		if !got[id] {
			t.Errorf("scene %s was not claimed; want the two oldest BytePlus and every kie scene", id)
		}
	}
	for _, id := range bp[2:] {
		if got[id] {
			t.Errorf("BytePlus scene %s was claimed over the cap", id)
		}
		if st := statusOf(ctx, t, s, id); st != "queued" {
			t.Errorf("over-cap BytePlus scene %s is %q; want it left queued", id, st)
		}
	}

	// The two just claimed have no task id yet and still hold their slots —
	// across workers, since the count is the database's.
	if n := inflight(ctx, t, s); n != limit {
		t.Errorf("BytePlusInflight = %d after claiming two, want %d", n, limit)
	}
	again, err := s.ClaimQueuedScenes(ctx, 1000, limit)
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if g := claimedAmong(again, bp); len(g) != 0 {
		t.Errorf("second claim at the cap took BytePlus scenes %v; want none", g)
	}

	// One finishes: the freed slot goes to the OLDEST waiting scene, never
	// a newer one.
	if _, err := s.pool.Exec(ctx, `UPDATE scenes SET status = 'failed' WHERE id = $1`, bp[0]); err != nil {
		t.Fatalf("finish %s: %v", bp[0], err)
	}
	third, err := s.ClaimQueuedScenes(ctx, 1000, limit)
	if err != nil {
		t.Fatalf("third claim: %v", err)
	}
	g := claimedAmong(third, bp)
	if !g[bp[2]] || g[bp[3]] {
		t.Errorf("after a slot freed, claimed %v; want only the older %s", g, bp[2])
	}
}

func TestBytePlusInflightCountsSubmittedAndClaimedButNotKie(t *testing.T) {
	dsn := requireTestDB(t)
	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(s.Close)

	bp, kieIDs := seedBytePlusAndKieQueue(ctx, t, s)
	base := inflight(ctx, t, s)
	if _, err := s.ClaimQueuedScenes(ctx, 1000, 0); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if n := inflight(ctx, t, s); n != base+4 {
		t.Fatalf("BytePlusInflight = %d after claiming four BytePlus scenes, want %d", n, base+4)
	}

	// Submitting attaches a byteplus: id — still the same one slot, not two.
	if err := s.MarkRendering(ctx, bp[0], kie.BytePlusTaskPrefix+"task-1"); err != nil {
		t.Fatalf("MarkRendering: %v", err)
	}
	// A kie task is never a BytePlus slot.
	if err := s.MarkRendering(ctx, kieIDs[0], "kie-task-1"); err != nil {
		t.Fatalf("MarkRendering kie: %v", err)
	}
	if n := inflight(ctx, t, s); n != base+4 {
		t.Errorf("BytePlusInflight = %d after submitting, want %d", n, base+4)
	}
}

// A worker that dies between claim and submit leaves a BytePlus scene in
// 'rendering' with no task id, holding a slot. It must not hold it forever:
// submitted_at is stamped at claim time, so reconcile's StaleRendering finds
// it (and reconcileScene fails a task-less scene outright).
func TestAClaimedButUnsubmittedBytePlusSceneGoesStale(t *testing.T) {
	dsn := requireTestDB(t)
	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(s.Close)

	bp, _ := seedBytePlusAndKieQueue(ctx, t, s)
	if _, err := s.ClaimQueuedScenes(ctx, 1000, 0); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE scenes SET submitted_at = now() - interval '1 hour' WHERE id = $1`, bp[0]); err != nil {
		t.Fatalf("backdate claim: %v", err)
	}

	stale, err := s.StaleRendering(ctx, 45*time.Second)
	if err != nil {
		t.Fatalf("StaleRendering: %v", err)
	}
	for _, sc := range stale {
		if sc.ID == bp[0] {
			if sc.KieTaskID != nil && *sc.KieTaskID != "" {
				t.Fatalf("stale scene has task id %q, want none", *sc.KieTaskID)
			}
			return
		}
	}
	t.Fatalf("claimed-but-unsubmitted BytePlus scene %s is not in StaleRendering", bp[0])
}
