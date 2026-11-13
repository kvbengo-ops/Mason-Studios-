package store

import (
	"context"
	"os"
	"testing"
)

// C4: the render ceiling is now the claim's own argument, subtracted inside
// the claiming statement, so `ceiling` means the global limit and not the
// caller's already-computed free slots. Getting that swap wrong in either
// direction is expensive — reading it as slots double-counts what is already
// in flight and stalls the queue; ignoring it submits an unbounded batch to
// a paid vendor.
//
// What this can prove: the arithmetic. Given R scenes already rendering and
// a ceiling of R+2, exactly 2 are claimed, and a second call claims none.
// What no test in this package can prove: that two worker *instances*
// racing cannot both claim a full batch. That is structural — the count and
// the candidate set now share one statement's snapshot — and the old
// two-statement shape passed this exact assertion too.
//
// DB-backed, gated on TEST_DATABASE_URL like every other test here.
// TestDevPartition_ClaimCeilingIgnoresProductionRenders covers the other
// half of the same LIMIT: that the count is scoped to one mode.
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/store -run ClaimStops
func TestClaimStopsAtTheRenderCeiling(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping database-backed test")
	}

	ctx := context.Background()
	// MODE=production: seedRenderingScene and the raw inserts below leave
	// scenes.dev at its false default (0063), and the ceiling counts only
	// this worker's own mode.
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { s.Close() })

	projectID, _ := seedRenderingScene(ctx, t, s)

	for idx := 1; idx <= 5; idx++ {
		if _, err := s.pool.Exec(ctx, `
INSERT INTO scenes (project_id, idx, status) VALUES ($1, $2, 'queued')`, projectID, idx); err != nil {
			t.Fatalf("seed queued scene %d: %v", idx, err)
		}
	}

	// The ceiling is global to this MODE, and a shared CI database may carry
	// other rows in 'rendering'. Measure rather than assume, so the assertion
	// is exact without owning the whole table. The dev filter mirrors the
	// one inside the claim's own LIMIT — counting both modes here would
	// make this test disagree with the statement it is testing.
	//
	// Only renders inside the 45-minute window hold a slot, and the claim
	// also stops at twice the ceiling in total, so measure both the way the
	// claim's LIMIT does. A clean database makes both terms agree on 2.
	var rendering, total int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FILTER (WHERE coalesce(submitted_at, now()) > now() - interval '45 minutes'), count(*)
		 FROM scenes WHERE status = 'rendering' AND dev = false`).Scan(&rendering, &total); err != nil {
		t.Fatalf("count rendering: %v", err)
	}
	if 2*(rendering+2)-total < 2 {
		t.Skipf("shared database holds %d stale renders, past the claim's hard cap; this test needs a cleaner one", total-rendering)
	}

	claimed, err := s.ClaimQueuedScenes(ctx, rendering+2, 0, 0)
	if err != nil {
		t.Fatalf("ClaimQueuedScenes: %v", err)
	}
	if len(claimed) != 2 {
		t.Fatalf("ClaimQueuedScenes(ceiling=%d) claimed %d scenes, want 2 — the ceiling was read as free slots, not as the limit", rendering+2, len(claimed))
	}

	// Now full. A second dispatch tick — or a second instance — gets nothing,
	// even though three scenes are still queued.
	again, err := s.ClaimQueuedScenes(ctx, rendering+2, 0, 0)
	if err != nil {
		t.Fatalf("ClaimQueuedScenes (second): %v", err)
	}
	if len(again) != 0 {
		t.Errorf("second ClaimQueuedScenes at the ceiling claimed %d scenes, want 0", len(again))
	}
}

// KIE_MAX_SUBMITS_PER_TICK: perTick caps one claim, and the ceiling still wins
// when it is the smaller. Same shape and gating as the test above.
func TestClaimPerTickCap(t *testing.T) {
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
	for idx := 1; idx <= 50; idx++ {
		if _, err := s.pool.Exec(ctx, `
INSERT INTO scenes (project_id, idx, status) VALUES ($1, $2, 'queued')`, projectID, idx); err != nil {
			t.Fatalf("seed queued scene %d: %v", idx, err)
		}
	}
	rendering := func() int {
		var n int
		if err := s.pool.QueryRow(ctx,
			`SELECT count(*) FROM scenes WHERE status = 'rendering' AND dev = false`).Scan(&n); err != nil {
			t.Fatalf("count rendering: %v", err)
		}
		return n
	}

	// 50 queued, room for far more than 30: the per-tick cap decides.
	claimed, err := s.ClaimQueuedScenes(ctx, rendering()+100, 0, 30)
	if err != nil {
		t.Fatalf("ClaimQueuedScenes: %v", err)
	}
	if len(claimed) != 30 {
		t.Fatalf("perTick=30 claimed %d scenes, want exactly 30", len(claimed))
	}

	// 20 still queued; only 3 free slots under the ceiling, perTick 30: the ceiling decides.
	claimed, err = s.ClaimQueuedScenes(ctx, rendering()+3, 0, 30)
	if err != nil {
		t.Fatalf("ClaimQueuedScenes (ceiling): %v", err)
	}
	if len(claimed) != 3 {
		t.Fatalf("ceiling with 3 free slots claimed %d scenes, want 3 — perTick must not widen the ceiling", len(claimed))
	}
}

// A render that has waited past the 45-minute window no longer holds a slot,
// so a kie queue stall cannot block every new render behind it; and the claim
// still never puts more than twice the ceiling in flight.
func TestClaimStaleRendersFreeTheirSlotUpToTwiceTheCeiling(t *testing.T) {
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
	for idx := 1; idx <= 6; idx++ {
		if _, err := s.pool.Exec(ctx, `
INSERT INTO scenes (project_id, idx, status) VALUES ($1, $2, 'queued')`, projectID, idx); err != nil {
			t.Fatalf("seed queued scene %d: %v", idx, err)
		}
	}

	var fresh, total int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FILTER (WHERE coalesce(submitted_at, now()) > now() - interval '45 minutes'), count(*)
		 FROM scenes WHERE status = 'rendering' AND dev = false`).Scan(&fresh, &total); err != nil {
		t.Fatalf("count rendering: %v", err)
	}
	if fresh != total {
		t.Skip("shared database already holds stale renders; this test needs to own the window")
	}
	ceiling := total // full: nothing is claimable while every render is fresh

	if claimed, err := s.ClaimQueuedScenes(ctx, ceiling, 0, 0); err != nil || len(claimed) != 0 {
		t.Fatalf("claim at a full ceiling = %d scenes (err %v), want 0", len(claimed), err)
	}

	// The seeded render has now waited an hour in kie's queue.
	if _, err := s.pool.Exec(ctx,
		`UPDATE scenes SET submitted_at = now() - interval '1 hour' WHERE id = $1`, sceneID); err != nil {
		t.Fatalf("age the seeded render: %v", err)
	}
	claimed, err := s.ClaimQueuedScenes(ctx, ceiling, 0, 0)
	if err != nil {
		t.Fatalf("ClaimQueuedScenes: %v", err)
	}
	if len(claimed) != 1 {
		t.Fatalf("after one render went stale, claim = %d scenes, want 1 (its freed slot)", len(claimed))
	}

	// Age everything: fresh slots are all free again, but the hard cap of
	// twice the ceiling in flight still bounds the claim.
	if _, err := s.pool.Exec(ctx,
		`UPDATE scenes SET submitted_at = now() - interval '1 hour' WHERE status = 'rendering' AND dev = false AND project_id = $1`, projectID); err != nil {
		t.Fatalf("age the project's renders: %v", err)
	}
	var inFlight int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM scenes WHERE status = 'rendering' AND dev = false`).Scan(&inFlight); err != nil {
		t.Fatalf("count in flight: %v", err)
	}
	claimed, err = s.ClaimQueuedScenes(ctx, ceiling, 0, 0)
	if err != nil {
		t.Fatalf("ClaimQueuedScenes (capped): %v", err)
	}
	want := min(5, ceiling, max(0, 2*ceiling-inFlight)) // 5 still queued
	if len(claimed) != want {
		t.Errorf("claim with all renders stale = %d scenes, want %d (twice-the-ceiling cap)", len(claimed), want)
	}
}
