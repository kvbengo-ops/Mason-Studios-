package http

import (
	"bytes"
	_ "embed"
	"fmt"
	"net/http"
	"time"
)

// mockClipMP4 is a tiny (~20KB), real H.264+AAC 1080x1920 clip, embedded
// into the binary so MODE=development never depends on a third-party host. It
// used to point at https://placehold.co/1080x1920.mp4, which 404s —
// placehold.co only serves images — so ingest.FromResult's downloadToTemp
// failed on every single mock render and no scene ever reached 'done' in
// mock mode. Serving the fixture from the worker itself removes that
// dependency entirely. Regenerate with:
//
//	ffmpeg -f lavfi -i testsrc=size=1080x1920:rate=24:duration=1 \
//	       -f lavfi -i sine=frequency=440:duration=1 \
//	       -c:v libx264 -preset veryslow -crf 40 -pix_fmt yuv420p \
//	       -c:a aac -ar 48000 -shortest testdata/clip.mp4
//
//go:embed testdata/clip.mp4
var mockClipMP4 []byte

// mockClipPath is the route the fixture is served on, and the path
// MockClipURL builds. They are the same constant on purpose: the worker
// downloads this clip back from itself during ingest, so a route and a URL
// that drift apart surface as a corrupt video, never as a missing endpoint.
const mockClipPath = "/mock/clip.mp4"

// MockClipURL is the URL a development worker hands to ingest as the
// "rendered" video. It is loopback and this process's own port, NOT
// APP_BASE_URL.
//
// APP_BASE_URL answers a different question — the address kie must reach
// from the OUTSIDE to deliver a webhook — and the two only coincide in
// production. Locally APP_BASE_URL is usually the Next app, which has no
// such route and, sitting behind auth middleware, answers the download with
// a 307 to /login. ingest saves those six bytes as clip.mp4 and ffprobe
// fails with "moov atom not found": a misconfigured URL wearing the costume
// of a corrupt render.
//
// Found by running it, not by reading it. Every mock render failed this way,
// and kept failing, because the reconcile poll retries.
func MockClipURL(port int) string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", port, mockClipPath)
}

// registerMockRoutes wires up the /mock/clip.mp4 fixture route. Callers
// MUST only call this when cfg.IsDev() is true — New() enforces that, so
// this stays a no-op in production rather than exposing a synthetic video
// endpoint on a real worker.
func (s *Server) registerMockRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET "+mockClipPath, s.handleMockClip)
}

// handleMockClip serves the embedded fixture clip. http.ServeContent (not a
// bare w.Write) handles Content-Length, Content-Type sniffing fallback, and
// Range requests correctly; the explicit Content-Type set below wins over
// ServeContent's sniff since it only sniffs when the header is unset.
func (s *Server) handleMockClip(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "video/mp4")
	http.ServeContent(w, r, "clip.mp4", time.Time{}, bytes.NewReader(mockClipMP4))
}
