package store

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Supabase returns the signed path relative to the storage API root, without
// the /storage/v1 prefix. Joining it straight onto the project host produces a
// 404 that only surfaces minutes later as fal saying it could not download
// input.image_url — which is exactly how this broke on the first real render.
func TestSignedURL_AddsStorageV1Prefix(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"signedURL": "/object/sign/media/projects/p/ref_frame/f.png?token=abc",
		})
	}))
	defer srv.Close()

	got, err := SignedURL(context.Background(), srv.Client(), srv.URL, "key", "projects/p/ref_frame/f.png", time.Hour)
	if err != nil {
		t.Fatalf("SignedURL: %v", err)
	}
	want := srv.URL + "/storage/v1/object/sign/media/projects/p/ref_frame/f.png?token=abc"
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

// If Supabase ever starts including the prefix itself, we must not double it.
func TestSignedURL_DoesNotDoublePrefix(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"signedURL": "/storage/v1/object/sign/media/projects/p/ref_frame/f.png?token=abc",
		})
	}))
	defer srv.Close()

	got, err := SignedURL(context.Background(), srv.Client(), srv.URL, "key", "projects/p/ref_frame/f.png", time.Hour)
	if err != nil {
		t.Fatalf("SignedURL: %v", err)
	}
	want := srv.URL + "/storage/v1/object/sign/media/projects/p/ref_frame/f.png?token=abc"
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

// An absolute URL is passed through untouched.
func TestSignedURL_PassesThroughAbsolute(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"signedURL": "https://cdn.example/x.png?token=abc"})
	}))
	defer srv.Close()

	got, err := SignedURL(context.Background(), srv.Client(), srv.URL, "key", "projects/p/f.png", time.Hour)
	if err != nil {
		t.Fatalf("SignedURL: %v", err)
	}
	if got != "https://cdn.example/x.png?token=abc" {
		t.Errorf("got %s", got)
	}
}
