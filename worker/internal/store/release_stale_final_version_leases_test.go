package store

import (
	"context"
	"os"
	"testing"
	"time"
)

// These pin ReleaseStaleFinalVersionLeases against the real database — the
// sweep that closes 0060_final_versions.sql's hazard: a worker that dies
// mid-assemble leaves claimed_at set forever, and the row is then neither
// built, nor failed, nor claimable ever again.
//
// Gated on TEST_DATABASE_URL the same way markfailed_test.go's tests are:
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/store -run ReleaseStaleFinalVersionLeases
const testLeaseStaleAfter = 30 * time.Minute

// TestReleaseStaleFinalVersionLeases_FreshLeaseIsNotReleased is the
// false-positive guard, and it is the half that protects correctness rather
// than liveness: a build that is still running must keep its lease, or a
// second worker claims the same row and the cut is assembled twice.
func TestReleaseStaleFinalVersionLeases_FreshLeaseIsNotReleased(t *testing.T) {
	ctx, s := leaseTestStore(t)
	projectID, _ := seedRenderingScene(ctx, t, s)

	// One minute old: a wholly ordinary in-flight assemble.
	versionID := seedFinalVersion(ctx, t, s, projectID, finalVersionState{
		claimedAt: ptrTime(time.Now().Add(-time.Minute)),
	})

	// Measured BEFORE the sweep, because the sweep is table-wide and this test
	// owns exactly one row. See staleLeaseCount.
	alreadyStale := staleLeaseCount(ctx, t, s, testLeaseStaleAfter)

	released, err := s.ReleaseStaleFinalVersionLeases(ctx, testLeaseStaleAfter)
	if err != nil {
		t.Fatalf("ReleaseStaleFinalVersionLeases: %v", err)
	}
	if released != alreadyStale {
		t.Errorf("released = %d, want %d (the rows that were already stale, and not the one-minute-old lease this test seeded — a live build, not a dead worker)", released, alreadyStale)
	}
	if claimedAt := claimedAtOf(ctx, t, s, versionID); claimedAt == nil {
		t.Error("claimed_at was cleared on a fresh lease; a live build's row is now claimable by a second worker")
	}
}

// TestReleaseStaleFinalVersionLeases_OldLeaseIsReleased is the liveness
// half: past the threshold the holder is presumed dead and the lease goes.
func TestReleaseStaleFinalVersionLeases_OldLeaseIsReleased(t *testing.T) {
	ctx, s := leaseTestStore(t)
	projectID, _ := seedRenderingScene(ctx, t, s)

	versionID := seedFinalVersion(ctx, t, s, projectID, finalVersionState{
		claimedAt: ptrTime(time.Now().Add(-2 * time.Hour)),
	})

	released, err := s.ReleaseStaleFinalVersionLeases(ctx, testLeaseStaleAfter)
	if err != nil {
		t.Fatalf("ReleaseStaleFinalVersionLeases: %v", err)
	}
	// >= 1 rather than == 1: the count is over the whole table, and a
	// previous test run in this database could have left another stale
	// lease behind. The row-level assertions below are the strict ones.
	if released < 1 {
		t.Errorf("released = %d, want at least 1 (a two-hour-old lease on an unbuilt row is a dead worker)", released)
	}
	if claimedAt := claimedAtOf(ctx, t, s, versionID); claimedAt != nil {
		t.Errorf("claimed_at = %v, want nil (the lease must actually be cleared, not just counted)", claimedAt)
	}
	// The constraint from 0060's column comment, checked directly: the
	// sweep must never turn a released row into a failed one, or a
	// slow-but-alive worker's MarkFinalVersionBuilt bounces off `failed_at
	// IS NULL` and strands a final that exists in storage.
	if built, failed := builtFailedOf(ctx, t, s, versionID); built != nil || failed != nil {
		t.Errorf("built_at = %v, failed_at = %v, want both nil (releasing a lease must decide nothing about the row's outcome)", built, failed)
	}
}

// TestReleaseStaleFinalVersionLeases_BuiltRowIsNeverTouched: a built row
// deliberately KEEPS its claimed_at (see MarkFinalVersionBuilt), so without
// the built_at IS NULL guard this sweep would rewrite finished history
// every pass and report a nonzero count forever.
func TestReleaseStaleFinalVersionLeases_BuiltRowIsNeverTouched(t *testing.T) {
	ctx, s := leaseTestStore(t)
	projectID, _ := seedRenderingScene(ctx, t, s)

	claimed := time.Now().Add(-2 * time.Hour)
	versionID := seedFinalVersion(ctx, t, s, projectID, finalVersionState{
		claimedAt: ptrTime(claimed),
		builtAt:   ptrTime(time.Now().Add(-90 * time.Minute)),
	})

	alreadyStale := staleLeaseCount(ctx, t, s, testLeaseStaleAfter)

	released, err := s.ReleaseStaleFinalVersionLeases(ctx, testLeaseStaleAfter)
	if err != nil {
		t.Fatalf("ReleaseStaleFinalVersionLeases: %v", err)
	}
	if released != alreadyStale {
		t.Errorf("released = %d, want %d (the already-stale rows, and not this built one — finished history is not a stuck lease)", released, alreadyStale)
	}
	if claimedAt := claimedAtOf(ctx, t, s, versionID); claimedAt == nil {
		t.Error("claimed_at was cleared on a built row; the sweep is rewriting completed versions")
	}
}

// TestReleaseStaleFinalVersionLeases_FailedRowIsNeverTouched: a failed row
// already has claimed_at cleared by MarkFinalVersionFailed, so the only way
// to see one leased is a hand-written row — the sweep must still leave it
// alone rather than counting it.
func TestReleaseStaleFinalVersionLeases_FailedRowIsNeverTouched(t *testing.T) {
	ctx, s := leaseTestStore(t)
	projectID, _ := seedRenderingScene(ctx, t, s)

	versionID := seedFinalVersion(ctx, t, s, projectID, finalVersionState{
		claimedAt: ptrTime(time.Now().Add(-2 * time.Hour)),
		failedAt:  ptrTime(time.Now().Add(-90 * time.Minute)),
	})

	alreadyStale := staleLeaseCount(ctx, t, s, testLeaseStaleAfter)

	released, err := s.ReleaseStaleFinalVersionLeases(ctx, testLeaseStaleAfter)
	if err != nil {
		t.Fatalf("ReleaseStaleFinalVersionLeases: %v", err)
	}
	if released != alreadyStale {
		t.Errorf("released = %d, want %d (the already-stale rows, and not this failed one — it has already reached a terminal state)", released, alreadyStale)
	}
	if claimedAt := claimedAtOf(ctx, t, s, versionID); claimedAt == nil {
		t.Error("claimed_at was cleared on a failed row; the sweep is touching terminal rows")
	}
}

// TestReleaseStaleFinalVersionLeases_ReleasedRowBecomesClaimableAgain is
// the point of the whole change: clearing claimed_at is only worth anything
// if ClaimPendingFinalVersions — which requires claimed_at IS NULL — can
// then pick the row up. Before the sweep the row must be unclaimable, and
// after it, claimable; both directions are asserted, so a test that passed
// because the row was claimable all along would not read as a pass.
func TestReleaseStaleFinalVersionLeases_ReleasedRowBecomesClaimableAgain(t *testing.T) {
	ctx, s := leaseTestStore(t)
	projectID, sceneID := seedRenderingScene(ctx, t, s)

	// ClaimPendingFinalVersions also demands a ready project: every scene
	// terminal, at least one 'done'.
	if _, err := s.pool.Exec(ctx, `UPDATE scenes SET status = 'done' WHERE id = $1`, sceneID); err != nil {
		t.Fatalf("seed done scene: %v", err)
	}
	seedClipAsset(ctx, t, s, projectID, sceneID)

	versionID := seedFinalVersion(ctx, t, s, projectID, finalVersionState{
		claimedAt: ptrTime(time.Now().Add(-2 * time.Hour)),
	})

	before, err := s.ClaimPendingFinalVersions(ctx, 10)
	if err != nil {
		t.Fatalf("ClaimPendingFinalVersions (before sweep): %v", err)
	}
	if containsVersion(before, versionID) {
		t.Fatal("the leased row was claimable before the sweep; this test cannot prove the sweep did anything")
	}

	if _, err := s.ReleaseStaleFinalVersionLeases(ctx, testLeaseStaleAfter); err != nil {
		t.Fatalf("ReleaseStaleFinalVersionLeases: %v", err)
	}

	after, err := s.ClaimPendingFinalVersions(ctx, 10)
	if err != nil {
		t.Fatalf("ClaimPendingFinalVersions (after sweep): %v", err)
	}
	if !containsVersion(after, versionID) {
		t.Errorf("version %s not claimable after its stale lease was released; the project still cannot assemble", versionID)
	}
}

// --------------------------------------------------------------- helpers

func leaseTestStore(t *testing.T) (context.Context, *Store) {
	t.Helper()

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
	if err := s.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	return ctx, s
}

// finalVersionState is the three timestamps that decide whether a row is
// pending, leased, built or failed. All nil is a fresh unclaimed request.
type finalVersionState struct {
	claimedAt *time.Time
	builtAt   *time.Time
	failedAt  *time.Time
}

// Every seeded row is deleted afterwards, and that is not tidiness: a
// claimed-but-unbuilt row left behind is picked up by the NEXT run's sweep,
// so the suite stops being repeatable. It passes on a fresh database and
// fails on the same code once enough runs have accumulated — which is the
// worst failure a test suite can have, because the first thing anyone does
// with it is disbelieve the failure.
//
// Found exactly that way: nine rows in the scratch database, eight of them
// from earlier runs on the same day, and TestReleaseStaleFinalVersionLeases_
// FreshLeaseIsNotReleased failing with "released = 8, want 0" against code
// that had not changed.
func seedFinalVersion(ctx context.Context, t *testing.T, s *Store, projectID string, st finalVersionState) string {
	t.Helper()

	var id string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO final_versions (project_id, recipe, claimed_at, built_at, failed_at)
VALUES ($1, '[]'::jsonb, $2, $3, $4)
RETURNING id`, projectID, st.claimedAt, st.builtAt, st.failedAt).Scan(&id); err != nil {
		t.Fatalf("seed final version: %v", err)
	}
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(),
			`DELETE FROM final_versions WHERE id = $1`, id); err != nil {
			t.Logf("cleanup final version %s: %v", id, err)
		}
	})
	return id
}

// staleLeaseCount is the number of rows ReleaseStaleFinalVersionLeases would
// legitimately release right now, for reasons that have nothing to do with
// the row a test just seeded.
//
// It exists because the sweep is table-wide and a test is not. Asserting
// "released == 0" asserts something about every row in the database, which a
// test that seeded one row has no standing to claim — and which fails on a
// database that merely has history. The baseline turns that into a claim the
// test can actually make: the sweep released exactly what was already stale,
// and did NOT reach the fresh lease under test.
func staleLeaseCount(ctx context.Context, t *testing.T, s *Store, staleAfter time.Duration) int64 {
	t.Helper()

	var n int64
	if err := s.pool.QueryRow(ctx, `
SELECT count(*) FROM final_versions
WHERE claimed_at IS NOT NULL
  AND built_at IS NULL
  AND failed_at IS NULL
  AND claimed_at < now() - $1::interval`, staleAfter.String()).Scan(&n); err != nil {
		t.Fatalf("count stale leases: %v", err)
	}
	return n
}

func claimedAtOf(ctx context.Context, t *testing.T, s *Store, versionID string) *time.Time {
	t.Helper()

	var claimedAt *time.Time
	if err := s.pool.QueryRow(ctx,
		`SELECT claimed_at FROM final_versions WHERE id = $1`, versionID).Scan(&claimedAt); err != nil {
		t.Fatalf("read claimed_at: %v", err)
	}
	return claimedAt
}

func builtFailedOf(ctx context.Context, t *testing.T, s *Store, versionID string) (*time.Time, *time.Time) {
	t.Helper()

	var builtAt, failedAt *time.Time
	if err := s.pool.QueryRow(ctx,
		`SELECT built_at, failed_at FROM final_versions WHERE id = $1`, versionID).Scan(&builtAt, &failedAt); err != nil {
		t.Fatalf("read built_at/failed_at: %v", err)
	}
	return builtAt, failedAt
}

func containsVersion(versions []PendingFinalVersion, versionID string) bool {
	for _, v := range versions {
		if v.ID == versionID {
			return true
		}
	}
	return false
}

func ptrTime(t time.Time) *time.Time { return &t }
