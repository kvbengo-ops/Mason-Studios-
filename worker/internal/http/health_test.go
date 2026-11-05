package http

import (
	"testing"

	"ugc-pipeline/worker/internal/config"
)

// The file is not the process.
//
// worker/.env carried MOCK_FAL_VIDEO=1 all day on 2026-08-31 while the
// running worker had it false: godotenv.Load() does not override a variable
// already set in the shell, so a stale export beat the file silently. The
// file was read three times, each time reported as proof that local renders
// were mocked, and a real $2.52 kie render proved otherwise.
//
// /health is now the answerable version of that question. These tests pin
// that it reports the CONFIG it was built with, in both directions — a
// health endpoint that always said "mocked" would be the same lie in a new
// place.
func TestHealthReportsMode(t *testing.T) {
	for _, mode := range []string{"development", "production"} {
		t.Run(mode, func(t *testing.T) {
			// healthPayload, not a hand-built map: the first version of this
			// test re-encoded the same literal the handler does and asserted
			// against itself, which would have passed with the field removed
			// from the handler entirely.
			got := healthPayload(&config.Config{Mode: mode})

			if got["mode"] != mode {
				t.Errorf("mode = %v, want %v", got["mode"], mode)
			}
			if got["status"] != "ok" {
				t.Errorf("status = %v, want ok", got["status"])
			}
		})
	}
}
