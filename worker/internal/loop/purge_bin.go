package loop

import (
	"context"
	"log/slog"
	"time"

	"ugc-pipeline/worker/internal/config"
	"ugc-pipeline/worker/internal/store"
)

// BinRetention is how long a deleted scene, clip version or image stays in
// /bin. Keep equal to BIN_RETENTION_DAYS in web/lib/bin-thumbnails.ts: the web
// restore refuses an entry past it, this purge deletes it.
const BinRetention = 3 * 24 * time.Hour

// BinPurgeInterval is how often PurgeBin runs.
const BinPurgeInterval = time.Hour

type binPurger interface {
	PurgeExpiredBin(ctx context.Context, cutoff time.Time) ([]string, error)
}

// PurgeBin deletes expired bin rows, then their unreferenced Storage objects.
// It never touches scenes.status, so it stays clear of the web/worker contract.
//
// ponytail: if Storage fails after the rows are gone the keys are only logged,
// not retried; add an orphan sweep if that ever shows up.
func PurgeBin(ctx context.Context, p binPurger, cfg *config.Config, logger *slog.Logger) error {
	keys, err := p.PurgeExpiredBin(ctx, time.Now().Add(-BinRetention))
	if err != nil {
		return err
	}
	if len(keys) == 0 {
		return nil
	}
	if err := store.DeleteObjects(ctx, cfg, "media", keys); err != nil {
		logger.Error("bin purge: rows deleted but Storage removal failed; keys orphaned",
			slog.Int("keys", len(keys)), slog.Any("sample", keys[:min(len(keys), 5)]))
		return err
	}
	logger.Info("bin purge: removed expired bin objects", slog.Int("keys", len(keys)))
	return nil
}

// ClipRetention is how long a finished scene lives before ExpireClips moves it
// to the bin (owner, 2026-11-15). Keep equal to CLIP_RETENTION_DAYS in
// web/lib/clip-retention.ts: the web warns from it, this loop acts on it.
const ClipRetention = 14 * 24 * time.Hour

// clipExpiryBatch bounds one pass, so a backlog drains over a few hours
// instead of one long transaction.
const clipExpiryBatch = 500

type clipExpirer interface {
	ExpireClips(ctx context.Context, cutoff time.Time, limit int) (int, error)
}

// ExpireClips moves finished, unkept scenes of a personal Create project past
// ClipRetention to the bin; a clip in a real project never expires.
// They stay restorable there for BinRetention, then PurgeBin deletes them.
// It deletes rows and never writes scenes.status.
func ExpireClips(ctx context.Context, e clipExpirer, logger *slog.Logger) error {
	n, err := e.ExpireClips(ctx, time.Now().Add(-ClipRetention), clipExpiryBatch)
	if err != nil {
		return err
	}
	if n > 0 {
		logger.Info("clip expiry: moved expired scenes to the bin", slog.Int("scenes", n))
	}
	return nil
}
