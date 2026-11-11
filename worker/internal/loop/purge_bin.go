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
