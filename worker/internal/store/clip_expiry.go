package store

import (
	"context"
	"fmt"
	"time"
)

// ExpireClips moves finished scenes whose newest take is older than cutoff to
// the bin, at most limit per call, and returns how many went. A scene marked
// keep is never taken. "To the bin" is a plain DELETE: 0088's BEFORE DELETE
// trigger archives the scene, its assets and its versions into deleted_scenes,
// exactly as the web's deleteClipScene does, so the owner can still restore it
// until the bin purge (PurgeExpiredBin) removes it for good.
//
// Only scenes in the owner's personal Create project (projects.is_personal,
// 0117): a clip moved into a real project with Add to project, or made in
// one, is never expired (owner, 2026-11-17).
//
// Only status 'done' — a queued or rendering scene is the worker's own work in
// flight, and a failed or draft scene holds no clip worth reclaiming. Filtered
// by dev like every claim, so a development worker never expires production's.
//
// The prompt is copied onto the scene's runs first, as deleteClipScene does:
// runs.scene_id is ON DELETE SET NULL, and the run would otherwise lose it.
func (s *Store) ExpireClips(ctx context.Context, cutoff time.Time, limit int) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("store: expire clips: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after Commit

	const pick = `
SELECT s.id
FROM scenes s
WHERE s.dev = $1
  AND s.status = 'done'
  AND NOT s.keep
  AND EXISTS (SELECT 1 FROM projects p WHERE p.id = s.project_id AND p.is_personal)
  AND s.created_at < $2
  AND NOT EXISTS (
    SELECT 1 FROM scene_versions v WHERE v.scene_id = s.id AND v.created_at >= $2
  )
ORDER BY s.created_at
LIMIT $3
FOR UPDATE OF s SKIP LOCKED`
	rows, err := tx.Query(ctx, pick, s.dev, cutoff, limit)
	if err != nil {
		return 0, fmt.Errorf("store: expire clips: pick: %w", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, fmt.Errorf("store: expire clips: scan: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("store: expire clips: pick: %w", err)
	}
	if len(ids) == 0 {
		return 0, nil
	}

	if _, err := tx.Exec(ctx, `
UPDATE runs r SET prompt = s.video_prompt
FROM scenes s
WHERE r.scene_id = s.id AND s.id = ANY($1) AND r.prompt IS NULL AND s.video_prompt IS NOT NULL`, ids); err != nil {
		return 0, fmt.Errorf("store: expire clips: keep prompts: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM scenes WHERE id = ANY($1)`, ids); err != nil {
		return 0, fmt.Errorf("store: expire clips: delete: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("store: expire clips: commit: %w", err)
	}
	return len(ids), nil
}
