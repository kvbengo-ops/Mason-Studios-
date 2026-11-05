package http

import (
	"net/http/httptest"
	"testing"

	"ugc-pipeline/worker/internal/config"
)

// ---------------------------------------------------------------------------
// bug 1: the worker serves its own mock render fixture
// ---------------------------------------------------------------------------

func TestMockClipRoute_RegisteredInDevelopment(t *testing.T) {
	cfg := &config.Config{KieWebhookSecret: "shh", Mode: "development"}
	s := New(":0", nil, cfg, nil, nil, testLogger())

	req := httptest.NewRequest("GET", "/mock/clip.mp4", nil)
	rec := httptest.NewRecorder()
	s.httpServer.Handler.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("GET /mock/clip.mp4 with MODE=development: status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "video/mp4" {
		t.Errorf("Content-Type = %q, want %q", got, "video/mp4")
	}
	if len(rec.Body.Bytes()) != len(mockClipMP4) {
		t.Errorf("response body length = %d, want %d (the embedded fixture)", len(rec.Body.Bytes()), len(mockClipMP4))
	}
}

func TestMockClipRoute_NotRegisteredInProduction(t *testing.T) {
	// A production worker (MODE=production) must never expose this route —
	// it would hand out a synthetic "rendered" video to anyone who asks.
	cfg := &config.Config{KieWebhookSecret: "shh", Mode: "production"}
	s := New(":0", nil, cfg, nil, nil, testLogger())

	req := httptest.NewRequest("GET", "/mock/clip.mp4", nil)
	rec := httptest.NewRecorder()
	s.httpServer.Handler.ServeHTTP(rec, req)

	if rec.Code != 404 {
		t.Fatalf("GET /mock/clip.mp4 with MODE=production: status = %d, want 404 (route must not be registered)", rec.Code)
	}
}

func TestMockClipFixture_IsNonEmpty(t *testing.T) {
	// A sanity check that the embed actually picked up the fixture file,
	// not an empty placeholder.
	if len(mockClipMP4) == 0 {
		t.Fatal("mockClipMP4 is empty; testdata/clip.mp4 failed to embed")
	}
}
