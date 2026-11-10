package store

import (
	"context"
	"strings"
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

	claimed, err := s.ClaimQueuedScenes(ctx, 1000, limit, 0)
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
	again, err := s.ClaimQueuedScenes(ctx, 1000, limit, 0)
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
	third, err := s.ClaimQueuedScenes(ctx, 1000, limit, 0)
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
	if _, err := s.ClaimQueuedScenes(ctx, 1000, 0, 0); err != nil {
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
	if _, err := s.ClaimQueuedScenes(ctx, 1000, 0, 0); err != nil {
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

// Two workers claiming at once must never take more BytePlus scenes than
// byteplusCap between them. The interleaving that used to break it, forced
// deterministically: worker A snapshots the queue {s1, s2} and stalls on a
// row lock; an OLDER scene s0 is re-queued in place (created_at is when a
// scene was made, not queued); worker B snapshots {s0, s1, s2} with nothing
// in flight yet and picks {s0, s1}. A then takes s1 and s2, B takes s0 — three
// against a cap of two. The advisory lock makes B wait for A's commit before
// it takes its snapshot, so B sees two in flight and claims none.
func TestConcurrentClaimsNeverOverClaimBytePlusAfterARequeue(t *testing.T) {
	dsn := requireTestDB(t)
	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(s.Close)

	ids := seedQueuedScenesForNewUser(ctx, t, s, 3) // oldest first
	s0, s1, s2 := ids[0], ids[1], ids[2]
	if _, err := s.pool.Exec(ctx, `
UPDATE scenes SET render_settings_override = jsonb_build_object('model', $1::text)
WHERE id = ANY($2)`, kie.BytePlusSeedance25ID, ids); err != nil {
		t.Fatalf("mark BytePlus scenes: %v", err)
	}
	// s0 starts out of the queue: a finished scene about to be re-rendered.
	if _, err := s.pool.Exec(ctx, `UPDATE scenes SET status = 'failed' WHERE id = $1`, s0); err != nil {
		t.Fatalf("park s0: %v", err)
	}
	limit := inflight(ctx, t, s) + 2

	// Each worker gets its own pool under its own application_name, so the
	// waits below are this test's backends and nobody else's: a global
	// pg_locks count on a shared database lets another session's waiter
	// release the test before its workers are in position.
	worker := func(name string) (*Store, string) {
		app := "claimrace-" + name + "-" + s0[:8]
		sep := "?"
		if strings.Contains(dsn, "?") {
			sep = "&"
		}
		w, err := New(ctx, dsn+sep+"application_name="+app, false)
		if err != nil {
			t.Fatalf("New %s: %v", name, err)
		}
		t.Cleanup(w.Close)
		return w, app
	}
	workerA, appA := worker("a")
	workerB, appB := worker("b")

	waitFor := func(app, what string) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for {
			var n int
			if err := s.pool.QueryRow(ctx, `
SELECT count(*) FROM pg_stat_activity
WHERE application_name = $1 AND wait_event_type = 'Lock'`, app).Scan(&n); err != nil {
				t.Fatalf("read pg_stat_activity: %v", err)
			}
			if n > 0 {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s", what)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}

	// Hold s1 so A stalls after taking its snapshot.
	hold, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin hold: %v", err)
	}
	// Released on every path: a failure that left s1 locked would hang the
	// seed cleanup's DELETE forever instead of reporting.
	defer func() { _ = hold.Rollback(context.Background()) }()
	if _, err := hold.Exec(ctx, `SELECT 1 FROM scenes WHERE id = $1 FOR UPDATE`, s1); err != nil {
		t.Fatalf("lock s1: %v", err)
	}

	type result struct {
		scenes []Scene
		err    error
	}
	claim := func(w *Store, out chan<- result) {
		sc, err := w.ClaimQueuedScenes(ctx, 1000, limit, 0)
		out <- result{sc, err}
	}
	aDone, bDone := make(chan result, 1), make(chan result, 1)

	go claim(workerA, aDone)
	waitFor(appA, "worker A to stall on s1")
	if _, err := s.pool.Exec(ctx, `UPDATE scenes SET status = 'queued' WHERE id = $1`, s0); err != nil {
		t.Fatalf("re-queue s0: %v", err)
	}
	go claim(workerB, bDone)
	waitFor(appB, "worker B to block")
	if err := hold.Rollback(ctx); err != nil {
		t.Fatalf("release s1: %v", err)
	}

	a, b := <-aDone, <-bDone
	if a.err != nil || b.err != nil {
		t.Fatalf("claims: A %v, B %v", a.err, b.err)
	}
	got := claimedAmong(append(a.scenes, b.scenes...), ids)
	if len(got) > 2 {
		t.Fatalf("two concurrent claims took %d BytePlus scenes %v against a cap of 2", len(got), got)
	}
	if !got[s1] || !got[s2] || got[s0] {
		t.Errorf("claimed %v; want A's s1 and s2, and the re-queued s0 left for a later tick", got)
	}
	if st := statusOf(ctx, t, s, s0); st != "queued" {
		t.Errorf("s0 is %q, want queued", st)
	}
}

func renderingCount(ctx context.Context, t *testing.T, s *Store) int {
	t.Helper()
	var n int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM scenes WHERE status = 'rendering' AND dev = false`).Scan(&n); err != nil {
		t.Fatalf("count rendering: %v", err)
	}
	return n
}

// The BytePlus slots follow the same per-user round-robin as the batch: one
// editor queueing many Seedance scenes cannot take every slot ahead of
// another editor's single one, even though all of theirs are older.
func TestClaimRoundRobinsBytePlusSlotsAcrossUsers(t *testing.T) {
	dsn := requireTestDB(t)
	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(s.Close)

	busy := seedQueuedScenesForNewUser(ctx, t, s, 5) // seeded first: all older
	quiet := seedQueuedScenesForNewUser(ctx, t, s, 1)
	all := append(append([]string{}, busy...), quiet...)
	if _, err := s.pool.Exec(ctx, `
UPDATE scenes SET render_settings_override = jsonb_build_object('model', $1::text)
WHERE id = ANY($2)`, kie.BytePlusSeedance25ID, all); err != nil {
		t.Fatalf("mark BytePlus scenes: %v", err)
	}

	claimed, err := s.ClaimQueuedScenes(ctx, 1000, inflight(ctx, t, s)+2, 0)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	got := claimedAmong(claimed, all)
	if len(got) != 2 || !got[busy[0]] || !got[quiet[0]] {
		t.Errorf("claimed %v; want the busy editor's oldest and the quiet editor's one", got)
	}
}

// RENDER_CONCURRENCY and the BytePlus cap are separate limits on one batch;
// whichever is tighter wins, and the BytePlus slice never grows past its own.
func TestClaimCeilingTighterThanTheBytePlusCap(t *testing.T) {
	dsn := requireTestDB(t)
	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(s.Close)

	bp, kieIDs := seedBytePlusAndKieQueue(ctx, t, s)
	mine := append(append([]string{}, bp...), kieIDs...)

	// One free slot under the ceiling, five under the BytePlus cap: the
	// ceiling wins and the single slot goes to the oldest scene.
	first, err := s.ClaimQueuedScenes(ctx, renderingCount(ctx, t, s)+1, inflight(ctx, t, s)+5, 0)
	if err != nil {
		t.Fatalf("first claim: %v", err)
	}
	if got := claimedAmong(first, mine); len(got) != 1 || !got[bp[0]] {
		t.Errorf("first claim took %v; want only %s — the ceiling is the tighter limit", got, bp[0])
	}

	// Both bind: two free slots, one BytePlus slot. bp[2] and bp[3] are over
	// the BytePlus cap, so the second slot falls to the oldest kie scene.
	second, err := s.ClaimQueuedScenes(ctx, renderingCount(ctx, t, s)+2, inflight(ctx, t, s)+1, 0)
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if got := claimedAmong(second, mine); len(got) != 2 || !got[bp[1]] || !got[kieIDs[0]] {
		t.Errorf("second claim took %v; want %s (the one BytePlus slot) and %s", got, bp[1], kieIDs[0])
	}
}

// ReleaseUnsubmittedClaim may only ever un-claim a scene nothing was
// submitted for: a task id means a vendor may have started (and billed) it.
func TestReleaseUnsubmittedClaimOnlyTouchesTaskLessClaims(t *testing.T) {
	dsn := requireTestDB(t)
	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(s.Close)

	ids := seedQueuedScenesForNewUser(ctx, t, s, 3)
	free, submitted, queued := ids[0], ids[1], ids[2]
	if _, err := s.pool.Exec(ctx, `
UPDATE scenes SET status = 'rendering', submitted_at = now() WHERE id = ANY($1)`,
		[]string{free, submitted}); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := s.MarkRendering(ctx, submitted, kie.BytePlusTaskPrefix+"task-1"); err != nil {
		t.Fatalf("MarkRendering: %v", err)
	}

	if err := s.ReleaseUnsubmittedClaim(ctx, free); err != nil {
		t.Fatalf("release task-less claim: %v", err)
	}
	var st string
	var submittedAt *time.Time
	if err := s.pool.QueryRow(ctx, `SELECT status, submitted_at FROM scenes WHERE id = $1`, free).
		Scan(&st, &submittedAt); err != nil {
		t.Fatalf("read released scene: %v", err)
	}
	if st != "queued" || submittedAt != nil {
		t.Errorf("released scene is %q with submitted_at %v; want queued with none", st, submittedAt)
	}

	for name, id := range map[string]string{"submitted": submitted, "never claimed": queued} {
		before := statusOf(ctx, t, s, id)
		if err := s.ReleaseUnsubmittedClaim(ctx, id); err == nil {
			t.Errorf("%s scene: release succeeded, want ErrNotFound", name)
		}
		if after := statusOf(ctx, t, s, id); after != before {
			t.Errorf("%s scene: status %q -> %q, want unchanged", name, before, after)
		}
	}
}
