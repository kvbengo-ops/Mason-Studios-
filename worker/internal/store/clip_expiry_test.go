package store

import (
	"context"
	"os"
	"testing"
	"time"
)

// ExpireClips bins exactly the finished, unkept scenes of a personal Create
// project whose newest take is past the cutoff. Each of the other scenes below
// differs from the expired one in the single way that should save it.
//
// A development-mode store, so the pass cannot touch a shared database's
// production rows.
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/store -run ExpireClips
func TestExpireClipsBinsOnlyOldUnkeptFinishedScenes(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping database-backed test")
	}
	ctx := context.Background()
	s, err := New(ctx, dsn, true)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { s.Close() })

	projectID, _ := seedRenderingScene(ctx, t, s)
	// The seeded project is the owner's personal Create project; a second,
	// real project of the same owner holds a clip moved out of it.
	if _, err := s.pool.Exec(ctx, `UPDATE projects SET is_personal = true WHERE id = $1`, projectID); err != nil {
		t.Fatalf("mark personal: %v", err)
	}
	var realProjectID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO projects (user_id, title, kind)
SELECT user_id, 'Real project', 'clip' FROM projects WHERE id = $1 RETURNING id`,
		projectID).Scan(&realProjectID); err != nil {
		t.Fatalf("seed real project: %v", err)
	}
	seedIn := func(project string, idx int, status string, keep bool, age string) string {
		t.Helper()
		var id string
		if err := s.pool.QueryRow(ctx, `
INSERT INTO scenes (project_id, idx, status, keep, dev, created_at)
VALUES ($1, $2, $3, $4, true, now() - $5::interval) RETURNING id`,
			project, idx, status, keep, age).Scan(&id); err != nil {
			t.Fatalf("seed scene %d: %v", idx, err)
		}
		return id
	}
	seed := func(idx int, status string, keep bool, age string) string {
		t.Helper()
		return seedIn(projectID, idx, status, keep, age)
	}
	expired := seed(101, "done", false, "20 days")
	kept := seed(102, "done", true, "20 days")
	retaken := seed(103, "done", false, "20 days")
	recent := seed(104, "done", false, "2 days")
	failed := seed(105, "failed", false, "20 days")
	inProject := seedIn(realProjectID, 1, "done", false, "20 days")
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO scene_versions (scene_id, n, created_at) VALUES ($1, 1, now() - interval '1 day')`,
		retaken); err != nil {
		t.Fatalf("seed recent take: %v", err)
	}

	// A large limit: a shared database may hold other expired dev scenes.
	if _, err := s.ExpireClips(ctx, time.Now().Add(-14*24*time.Hour), 10000); err != nil {
		t.Fatalf("ExpireClips: %v", err)
	}

	exists := func(id string) bool {
		t.Helper()
		var ok bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM scenes WHERE id = $1)`, id).Scan(&ok); err != nil {
			t.Fatalf("read scene: %v", err)
		}
		return ok
	}
	if exists(expired) {
		t.Error("an old, unkept, finished scene was not moved to the bin")
	}
	var binned bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM deleted_scenes WHERE scene_id = $1)`, expired).Scan(&binned); err != nil {
		t.Fatalf("read bin: %v", err)
	}
	if !binned {
		t.Error("the expired scene is gone but has no bin entry to restore from")
	}
	for name, id := range map[string]string{
		"kept": kept, "with a recent take": retaken, "recent": recent, "failed": failed,
		"in a real project": inProject,
	} {
		if !exists(id) {
			t.Errorf("a scene that is %s was expired", name)
		}
	}
}
