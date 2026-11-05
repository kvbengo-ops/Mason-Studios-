// Package logging provides the worker's structured logger: JSON output via
// log/slog, level configurable from the environment.
package logging

import (
	"context"
	"log/slog"
	"os"
	"strings"
)

// New builds a JSON slog.Logger writing to stderr. Level is read from the
// LOG_LEVEL environment variable (debug|info|warn|error), defaulting to
// info when unset or unrecognized.
func New() *slog.Logger {
	handler := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
		Level: levelFromEnv(os.Getenv("LOG_LEVEL")),
	})
	return slog.New(handler)
}

func levelFromEnv(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// WithScene returns a logger with scene_id (and, when non-empty,
// project_id) attached, so every log line about a scene carries consistent
// identifiers for cross-referencing.
func WithScene(logger *slog.Logger, sceneID, projectID string) *slog.Logger {
	l := logger.With(slog.String("scene_id", sceneID))
	if projectID != "" {
		l = l.With(slog.String("project_id", projectID))
	}
	return l
}

// WithProject returns a logger with project_id attached.
func WithProject(logger *slog.Logger, projectID string) *slog.Logger {
	return logger.With(slog.String("project_id", projectID))
}

// FromContext is a placeholder extension point: if a logger is ever
// threaded through context.Context (e.g. per-request), callers can extract
// it here. Currently unused — loggers are passed explicitly via Deps.
func FromContext(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(ctxKey{}).(*slog.Logger); ok {
		return l
	}
	return slog.Default()
}

type ctxKey struct{}

// IntoContext attaches a logger to ctx for retrieval via FromContext.
func IntoContext(ctx context.Context, logger *slog.Logger) context.Context {
	return context.WithValue(ctx, ctxKey{}, logger)
}
