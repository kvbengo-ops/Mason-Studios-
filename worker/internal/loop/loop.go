// Package loop provides the worker's recurring background loops (dispatch,
// reconcile, assemble) plus the Every scheduling helper they run under.
package loop

import (
	"context"
	"log/slog"
	"time"
)

// Every calls fn every interval until ctx is cancelled. It:
//   - recovers from panics inside fn, logging them instead of crashing the
//     process — one bad iteration must never kill the loop;
//   - logs (but does not otherwise act on) errors returned by fn;
//   - exits cleanly, without calling fn again, once ctx is cancelled.
//
// fn is not called immediately; the first invocation happens after the
// first tick. Callers wanting an immediate first run should call fn once
// before starting Every.
func Every(ctx context.Context, interval time.Duration, name string, fn func(context.Context) error) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	logger := slog.Default().With(slog.String("loop", name))

	for {
		select {
		case <-ctx.Done():
			logger.Info("loop stopped")
			return
		case <-ticker.C:
			runOnce(ctx, logger, fn)
		}
	}
}

// runOnce executes a single loop iteration, isolating panics and errors so
// they cannot propagate out of Every.
func runOnce(ctx context.Context, logger *slog.Logger, fn func(context.Context) error) {
	defer func() {
		if r := recover(); r != nil {
			logger.Error("loop iteration panicked", slog.Any("panic", r))
		}
	}()

	if err := fn(ctx); err != nil {
		logger.Error("loop iteration failed", slog.String("error", err.Error()))
	}
}
