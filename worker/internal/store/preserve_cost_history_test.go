package store

import (
	"context"
	"os"
	"testing"
)

// TestDeleteProjectPreservesCostHistory pins the archiving triggers added by
// 0038_preserve_cost_history_on_delete.sql. Deleting a project cascades all
// the way down to `runs` (0001_init.sql's scenes/assets cascades plus 0030's
// runs.project_id), which used to take the project's entire spend record with
// it — vendor, model, cost_usd, latency, error, timestamps — leaving every
// aggregate over `runs` reporting a smaller number with no trace that the
// rows had ever existed. The BEFORE DELETE trigger copies them into
// deleted_project_cost_history one step ahead of the cascade; this asserts the
// copy lands, carries the right dollar amount, and outlives the original.
//
// Like MarkFailed's test this has to hit a real Postgres, and for the same
// reason: what is under test is entirely server-side behaviour — trigger
// firing order against an ON DELETE CASCADE, inside one transaction — which
// no fake reproduces.
//
// Gated on TEST_DATABASE_URL, not DATABASE_URL, so running `make check` with
// an ordinary dev environment loaded cannot point a test that deletes rows at
// a live database. Point it at a scratch database (`supabase db reset` gives
// you one) to run it:
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/store -run PreservesCostHistory
func TestDeleteProjectPreservesCostHistory(t *testing.T) {
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

	projectID, sceneID := seedRenderingScene(ctx, t, s)

	// The archive deliberately has no FK back to projects, so nothing cleans
	// these rows up on the seed's own cascade — which is the entire point of
	// the table, and means this test has to sweep up after itself.
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(),
			`DELETE FROM deleted_project_cost_history WHERE project_id = $1`, projectID,
		); err != nil {
			t.Errorf("cleanup archive rows: %v", err)
		}
	})

	// Record a costed attempt through the ordinary writer rather than a raw
	// INSERT, so the archived row is shaped exactly like a real one.
	cost := 1.2345
	latency := 8765
	reason := "seeded paid failure, kept only to be deleted"
	// taskID is the load-bearing part of this fixture. The column it lands in
	// was renamed from fal_request_id to kie_task_id by
	// 0070_rename_fal_to_kie.sql, and the archive trigger that copies it
	// builds its INSERT as a DYNAMIC SQL STRING — which a column rename
	// cannot reach inside. Postgres would have accepted the rename and left
	// the trigger naming a column that no longer exists, failing not at
	// migration time but the next time a project was deleted, which is the
	// one moment the trigger exists to do its job.
	taskID := "mock-kie-preserve-cost-history-fixture"
	vendor := "kie"
	if err := s.MarkFailed(ctx, sceneID, Run{
		ProjectID: projectID,
		KieTaskID: &taskID,
		Vendor:    vendor,
		Model:     "bytedance/seedance-2-5",
		CostUSD:   &cost,
		LatencyMS: &latency,
		Error:     &reason,
	}); err != nil {
		t.Fatalf("seed run via MarkFailed: %v", err)
	}

	var runID, projectTitle string
	if err := s.pool.QueryRow(ctx,
		`SELECT id FROM runs WHERE scene_id = $1`, sceneID,
	).Scan(&runID); err != nil {
		t.Fatalf("read seeded run id: %v", err)
	}
	// Read the title now, while there is still a project to read it from —
	// the assertion below is that the trigger snapshotted this exact value.
	if err := s.pool.QueryRow(ctx,
		`SELECT title FROM projects WHERE id = $1`, projectID,
	).Scan(&projectTitle); err != nil {
		t.Fatalf("read project title: %v", err)
	}

	// The delete under test: exactly what web/actions/project.ts's
	// deleteProject issues, with no archiving knowledge of its own.
	if _, err := s.pool.Exec(ctx, `DELETE FROM projects WHERE id = $1`, projectID); err != nil {
		t.Fatalf("delete project: %v", err)
	}

	// The cascade must still have done its job — this is not a soft delete.
	var liveRuns int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM runs WHERE id = $1`, runID,
	).Scan(&liveRuns); err != nil {
		t.Fatalf("count live runs: %v", err)
	}
	if liveRuns != 0 {
		t.Errorf("runs rows for deleted project = %d, want 0 (the cascade must still delete)", liveRuns)
	}

	// ...and the cost must have survived it.
	var (
		archivedCost    float64
		archivedScene   string
		archivedProject string
		archivedVendor  string
		archivedTitle   string
		archivedEmail   string
		archivedLatency int
		archivedTaskID  string
	)
	// cost_usd is numeric(10,4); cast to float8 in SQL rather than relying on
	// the driver's numeric handling to land in a float64.
	if err := s.pool.QueryRow(ctx, `
SELECT cost_usd::float8, scene_id, project_id, vendor, project_title, owner_email, latency_ms, kie_task_id
FROM deleted_project_cost_history
WHERE run_id = $1`, runID,
	).Scan(&archivedCost, &archivedScene, &archivedProject, &archivedVendor,
		&archivedTitle, &archivedEmail, &archivedLatency, &archivedTaskID); err != nil {
		t.Fatalf("read archived run %s: %v (the run's cost history did not survive the delete)", runID, err)
	}

	if archivedCost != cost {
		t.Errorf("archived cost_usd = %v, want %v", archivedCost, cost)
	}
	// Naming kie_task_id in the SELECT above already proves the column
	// exists; this proves the TRIGGER writes it, which is the half that
	// lives inside the dynamic SQL string.
	if archivedTaskID != taskID {
		t.Errorf("archived kie_task_id = %q, want %q — the archive trigger builds its INSERT as a string, so a column rename that missed it fails here and nowhere earlier", archivedTaskID, taskID)
	}
	if archivedScene != sceneID {
		t.Errorf("archived scene_id = %q, want %q", archivedScene, sceneID)
	}
	if archivedProject != projectID {
		t.Errorf("archived project_id = %q, want %q", archivedProject, projectID)
	}
	if archivedVendor != vendor {
		t.Errorf("archived vendor = %q, want %q", archivedVendor, vendor)
	}
	if archivedLatency != latency {
		t.Errorf("archived latency_ms = %d, want %d", archivedLatency, latency)
	}
	// Snapshotted by the projects trigger while the project still existed.
	// The scenes trigger fires for the same run as the cascade tears the
	// scene down, but it runs after the projects row is already gone and so
	// can only see a NULL title — if that copy had won the ON CONFLICT race
	// instead, these two would be empty.
	if archivedTitle != projectTitle {
		t.Errorf("archived project_title = %q, want %q", archivedTitle, projectTitle)
	}
	if archivedEmail == "" {
		t.Error("archived owner_email is empty, want the owning profile's email")
	}

	// One row, not two: the projects trigger and the cascade-fired scenes
	// trigger both reach this run, and `on conflict (run_id) do nothing` is
	// what keeps the archive from double-counting the same dollar.
	var archivedRows int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM deleted_project_cost_history WHERE run_id = $1`, runID,
	).Scan(&archivedRows); err != nil {
		t.Fatalf("count archived rows: %v", err)
	}
	if archivedRows != 1 {
		t.Errorf("archived rows for run = %d, want 1", archivedRows)
	}
}

// TestDeleteSceneKeepsRunInProjectSpend covers the other half of the same
// bug, which 0054_runs_survive_scene_delete.sql closes from the opposite
// direction. A scene can be deleted on its own, without its project going
// anywhere, and until 0054 runs.scene_id's ON DELETE CASCADE destroyed that
// scene's whole render history — the expensive path, since a scene whose
// frame was regenerated a few times before anyone re-rendered it carries the
// most attempt rows in the schema.
//
// 0038 answered that by archiving the rows into deleted_project_cost_history
// on the way out. That kept the money visible to /spend and to the caps
// (both read through the service-role client, which sees the archive), but
// not to the two PER-PROJECT reads — project_cost_totals and
// web/lib/db-aggregates.ts's getProjectSpend, the Deliver page's "Spend to
// date" — which read `runs` through the owner's own session client and can't
// see an admin-only archive at all. 0054 makes the FK SET NULL instead, so
// the run never leaves `runs`: it keeps its project_id and its dollars, and
// gives up only the per-scene attribution that died with the scene.
//
// This asserts exactly that, and the last check is the Deliver page's figure
// itself — project_cost_totals sums the same live `runs` rows getProjectSpend
// does, so a regression in the FK shows up here as a project total that
// silently shrank.
//
// Same TEST_DATABASE_URL gate and same reasoning as above.
func TestDeleteSceneKeepsRunInProjectSpend(t *testing.T) {
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

	projectID, sceneID := seedRenderingScene(ctx, t, s)

	// Nothing archives during this test — that is what it asserts — but the
	// seed's own cleanup deletes the PROJECT at the end, and that trigger does
	// still archive. Same sweep the test above needs, same reason: the archive
	// has no FK to cascade it away.
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(),
			`DELETE FROM deleted_project_cost_history WHERE project_id = $1`, projectID,
		); err != nil {
			t.Errorf("cleanup archive rows: %v", err)
		}
	})

	cost := 0.9876
	reason := "seeded paid failure on a scene deleted by itself"
	if err := s.MarkFailed(ctx, sceneID, Run{
		ProjectID: projectID,
		Vendor:    "fal",
		Model:     "fal-ai/ltx-video-13b-distilled/image-to-video",
		CostUSD:   &cost,
		Error:     &reason,
	}); err != nil {
		t.Fatalf("seed run via MarkFailed: %v", err)
	}

	var runID string
	if err := s.pool.QueryRow(ctx,
		`SELECT id FROM runs WHERE scene_id = $1`, sceneID,
	).Scan(&runID); err != nil {
		t.Fatalf("read seeded run id: %v", err)
	}

	// Delete the scene only. The project stays — this is web/actions/brief.ts's
	// deleteScene, which issues exactly this and knows nothing about runs.
	if _, err := s.pool.Exec(ctx, `DELETE FROM scenes WHERE id = $1`, sceneID); err != nil {
		t.Fatalf("delete scene: %v", err)
	}

	// The run survives, still charged to the project, with the dead scene
	// reference nulled out rather than the whole row taken with it.
	var (
		liveCost      float64
		liveProjectID string
		liveSceneID   *string
	)
	if err := s.pool.QueryRow(ctx, `
SELECT cost_usd::float8, project_id, scene_id
FROM runs
WHERE id = $1`, runID,
	).Scan(&liveCost, &liveProjectID, &liveSceneID); err != nil {
		t.Fatalf("read run %s after scene delete: %v (the run did not survive — is runs_scene_id_fkey still ON DELETE CASCADE?)", runID, err)
	}
	if liveCost != cost {
		t.Errorf("run cost_usd after scene delete = %v, want %v", liveCost, cost)
	}
	if liveProjectID != projectID {
		t.Errorf("run project_id after scene delete = %q, want %q", liveProjectID, projectID)
	}
	if liveSceneID != nil {
		t.Errorf("run scene_id after scene delete = %q, want NULL", *liveSceneID)
	}

	// Nothing archived it: 0054 drops scenes_archive_cost_history precisely
	// because a live row copied into the archive would be counted twice by
	// every one of 0040's UNION ALL reads.
	var archivedRows int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM deleted_project_cost_history WHERE run_id = $1`, runID,
	).Scan(&archivedRows); err != nil {
		t.Fatalf("count archived rows: %v", err)
	}
	if archivedRows != 0 {
		t.Errorf("archived rows for a run whose scene was deleted = %d, want 0 (it is still live in runs — archiving it too double-counts it)", archivedRows)
	}

	// The figure an operator actually reads. project_cost_totals is the
	// /projects list's column and sums the same live rows the Deliver page's
	// getProjectSpend does.
	var projectTotal float64
	if err := s.pool.QueryRow(ctx,
		`SELECT total_cost_usd::float8 FROM project_cost_totals WHERE project_id = $1`, projectID,
	).Scan(&projectTotal); err != nil {
		t.Fatalf("read project_cost_totals for %s: %v", projectID, err)
	}
	if projectTotal != cost {
		t.Errorf("project total after deleting the scene = %v, want %v (the deleted scene's spend must stay on the project)", projectTotal, cost)
	}
}
