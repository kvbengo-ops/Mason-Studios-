package store

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestPersonalImageBinAndNotifications(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	owner := seedUser(ctx, t, s)
	stranger := seedUser(ctx, t, s)
	var assetID, runID string
	if err := s.pool.QueryRow(ctx, `INSERT INTO assets (user_id, kind, storage_key)
VALUES ($1, 'generated_image', 'users/bin-fixture/image.png') RETURNING id`, owner).Scan(&assetID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM runs WHERE user_id = $1`, owner)
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM assets WHERE id = $1`, assetID)
	})
	if err := s.pool.QueryRow(ctx, `INSERT INTO runs (user_id, vendor, model, cost_usd, idempotency_key, settled_at)
VALUES ($1, 'kie', 'google/nano-banana', 0.1, 'image-bin-fixture', null) RETURNING id`, owner).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`UPDATE runs SET kie_task_id = 'image-bin-task' WHERE id = $1`,
		`UPDATE runs SET kie_task_id = 'image-bin-task' WHERE id = $1`,
		`UPDATE runs SET settled_at = now() WHERE id = $1`,
	} {
		if _, err := s.pool.Exec(ctx, query, runID); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE metadata->>'run_id' = $1`, runID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("before storage: got %d progress events, want none", count)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE runs SET asset_id = $2 WHERE id = $1`, runID, assetID); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE metadata->>'run_id' = $1 AND kind = 'image_completed'`, runID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("completion count=%d err=%v", count, err)
	}

	for _, operation := range []string{"trash", "restore", "purge"} {
		t.Run("stranger_cannot_"+operation, func(t *testing.T) {
			runAsUser(ctx, t, s, stranger, func(tx pgx.Tx) {
				if _, err := tx.Exec(ctx, `SELECT manage_personal_image($1, $2)`, assetID, operation); err == nil {
					t.Fatal("stranger changed owner's image")
				}
			})
		})
	}
	runAsUser(ctx, t, s, owner, func(tx pgx.Tx) {
		if _, err := tx.Exec(ctx, `SELECT manage_personal_image($1, 'purge')`, assetID); err == nil {
			t.Fatal("purge accepted image outside Bin")
		}
	})
	runAsUser(ctx, t, s, owner, func(tx pgx.Tx) {
		for _, operation := range []string{"trash", "restore", "trash"} {
			if _, err := tx.Exec(ctx, `SELECT manage_personal_image($1, $2)`, assetID, operation); err != nil {
				t.Fatal(err)
			}
			var deleted bool
			if err := tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM assets WHERE id = $1`, assetID).Scan(&deleted); err != nil || deleted != (operation == "trash") {
				t.Fatalf("%s deleted=%v err=%v", operation, deleted, err)
			}
		}
		var key string
		if err := tx.QueryRow(ctx, `SELECT manage_personal_image($1, 'purge')`, assetID).Scan(&key); err != nil || key != "users/bin-fixture/image.png" {
			t.Fatalf("purge key=%s err=%v", key, err)
		}
		var retained bool
		if err := tx.QueryRow(ctx, `SELECT asset_id IS NULL AND cost_usd = 0.1 FROM runs WHERE id = $1`, runID).Scan(&retained); err != nil || !retained {
			t.Fatalf("purge must retain billed attempt: retained=%v err=%v", retained, err)
		}
	})
}
