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
	var rendering int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM scenes WHERE status = 'rendering' AND dev = false`).Scan(&rendering); err != nil {
		t.Fatalf("count rendering: %v", err)
	}

	claimed, err := s.ClaimQueuedScenes(ctx, rendering+2)
	if err != nil {
		t.Fatalf("ClaimQueuedScenes: %v", err)
	}
	if len(claimed) != 2 {
		t.Fatalf("ClaimQueuedScenes(ceiling=%d) claimed %d scenes, want 2 — the ceiling was read as free slots, not as the limit", rendering+2, len(claimed))
	}

	// Now full. A second dispatch tick — or a second instance — gets nothing,
	// even though three scenes are still queued.
	again, err := s.ClaimQueuedScenes(ctx, rendering+2)
	if err != nil {
		t.Fatalf("ClaimQueuedScenes (second): %v", err)
	}
	if len(again) != 0 {
		t.Errorf("second ClaimQueuedScenes at the ceiling claimed %d scenes, want 0", len(again))
	}
}
