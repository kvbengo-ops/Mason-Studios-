package ingest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// TestDownloadToTemp_Success pins the "copy the file immediately" contract
// from downloadToTemp's own doc comment: the response body is written
// byte-for-byte to a temp file the caller owns (and must clean up).
func TestDownloadToTemp_Success(t *testing.T) {
	const body = "fake mp4 bytes"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	path, err := downloadToTemp(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("downloadToTemp: unexpected error: %v", err)
	}
	defer os.Remove(path)

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading downloaded file: %v", err)
	}
	if string(got) != body {
		t.Fatalf("downloaded content = %q, want %q", got, body)
	}
}

// TestDownloadToTemp_NonOKStatus pins that a non-2xx response is treated as
// a failure (fal's result URL returning e.g. a 403/404 must not be silently
// treated as an empty successful clip).
func TestDownloadToTemp_NonOKStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	path, err := downloadToTemp(context.Background(), srv.URL)
	if err == nil {
		os.Remove(path)
		t.Fatalf("downloadToTemp: expected error for 404, got none (path=%q)", path)
	}
	if !strings.Contains(err.Error(), "status 404") {
		t.Fatalf("downloadToTemp error = %q, want it to mention status 404", err.Error())
	}
}

// TestDownloadToTemp_EmptyURL pins the fast-fail path for an empty
// result.VideoURL: this must fail before ever attempting an HTTP call.
func TestDownloadToTemp_EmptyURL(t *testing.T) {
	path, err := downloadToTemp(context.Background(), "")
	if err == nil {
		os.Remove(path)
		t.Fatalf("downloadToTemp(\"\"): expected error, got none")
	}
	if !strings.Contains(err.Error(), "empty video url") {
		t.Fatalf("downloadToTemp(\"\") error = %q, want it to mention empty video url", err.Error())
	}
}

// TestDownloadToTemp_RespectsCallerContext pins that downloadToTemp's
// internal timeout is derived FROM the caller's ctx (context.WithTimeout(ctx,
// downloadTimeout)), not from a fresh background context — an
// already-expired parent context must short-circuit the request instead of
// letting it run for up to downloadTimeout. This is exercised without ever
// sleeping close to downloadTimeout: the parent context is already past its
// deadline before the call, so a correct implementation returns
// immediately, and the fake server (which would respond instantly) must
// never even see the request.
func TestDownloadToTemp_RespectsCallerContext(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Minute))
	defer cancel()

	path, err := downloadToTemp(ctx, srv.URL)
	if err == nil {
		os.Remove(path)
		t.Fatalf("downloadToTemp with expired parent context: expected error, got none")
	}
	if hit {
		t.Fatalf("downloadToTemp with expired parent context: server was still contacted")
	}
}

// TestDownloadTimeoutIs120Seconds pins the documented bound ("Clips are ~8s
// of 1080p video, a few MB — generous, not tight.") as a value, so a change
// to the constant is a deliberate, reviewed diff rather than a silent
// widening/narrowing of the download budget.
func TestDownloadTimeoutIs120Seconds(t *testing.T) {
	if downloadTimeout != 120*time.Second {
		t.Fatalf("downloadTimeout = %v, want 120s", downloadTimeout)
	}
}
