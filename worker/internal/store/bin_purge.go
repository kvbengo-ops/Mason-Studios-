package store

import (
	"context"
	"fmt"
	"time"
)

// PurgeExpiredBin deletes the bin rows that have outlived the retention
// window — deleted scenes, deleted clip versions (also any an editor already
// marked hard_deleted_at) and binned personal images — and returns the Storage
// keys that nothing live still uses. The caller removes those objects AFTER
// this commits: a failed Storage call leaves an orphaned file, never a row
// that points at nothing.
//
// An archived key is dropped from the result if a live assets row has it (a
// scene restored in the meantime re-inserts its rows). A binned image that a
// scene_references row still points at is skipped, not purged: that FK is
// ON DELETE RESTRICT and would fail the whole statement every hour.
//
// Not filtered by dev: the bin tables carry no dev flag, so the caller runs
// this in production mode only.
func (s *Store) PurgeExpiredBin(ctx context.Context, cutoff time.Time) ([]string, error) {
	const q = `
WITH s AS (
  DELETE FROM deleted_scenes
  WHERE deleted_at < $1 OR hard_deleted_at IS NOT NULL
  RETURNING assets AS j
), v AS (
  DELETE FROM deleted_scene_versions
  WHERE deleted_at < $1 OR hard_deleted_at IS NOT NULL
  RETURNING clip_asset AS j
), i AS (
  DELETE FROM assets a
  WHERE a.kind = 'generated_image' AND a.project_id IS NULL AND a.deleted_at < $1
    AND NOT EXISTS (SELECT 1 FROM scene_references r WHERE r.asset_id = a.id)
  RETURNING a.storage_key
), archived AS (
  SELECT e->>'storage_key' AS k
  FROM s, jsonb_array_elements(CASE WHEN jsonb_typeof(s.j) = 'array' THEN s.j ELSE '[]'::jsonb END) e
  UNION
  SELECT v.j->>'storage_key' FROM v WHERE jsonb_typeof(v.j) = 'object'
)
SELECT k FROM archived
WHERE k IS NOT NULL AND k <> '' AND NOT EXISTS (SELECT 1 FROM assets WHERE storage_key = k)
UNION
SELECT storage_key FROM i WHERE storage_key <> ''`

	rows, err := s.pool.Query(ctx, q, cutoff)
	if err != nil {
		return nil, fmt.Errorf("store: purge expired bin: %w", err)
	}
	defer rows.Close()
	var keys []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, fmt.Errorf("store: purge expired bin: scan: %w", err)
		}
		keys = append(keys, k)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: purge expired bin: %w", err)
	}
	return keys, nil
}
