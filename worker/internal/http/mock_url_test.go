package http

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// The bug these pin, in full: MODE=development built the mock video URL from
// APP_BASE_URL. That variable is the address kie must reach from the OUTSIDE
// to deliver a webhook. Locally it points at the Next app, which has no such
// route and answers with a 307 to /login — so ingest downloaded six bytes of
// redirect body, saved them as clip.mp4, and every mock render died on
// ffprobe's "moov atom not found". A configuration error dressed as a corrupt
// video, on repeat, because the reconcile poll retries.
//
// Nothing in the type system was going to catch that: both are strings, both
// are URLs, and both are correct in production, where the worker's public
// address and its own address are the same host.

// The load-bearing assertion. MockClipURL must not be derivable from
// APP_BASE_URL, so this asserts the property that made the bug impossible:
// the URL names this process, on the port it is listening on.
func TestMockClipURL_IsLoopbackOnTheWorkersOwnPort(t *testing.T) {
	got := MockClipURL(8080)

	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("MockClipURL(8080) = %q, not a parseable URL: %v", got, err)
	}
	if u.Hostname() != "127.0.0.1" {
		t.Errorf("host = %q, want 127.0.0.1 — the worker downloads this clip from itself; any other host is a second service that may not serve it", u.Hostname())
	}
	if u.Port() != "8080" {
		t.Errorf("port = %q, want 8080 — the port passed in is the one this process listens on", u.Port())
	}
}

// A second port, because a constant returned regardless of the argument would
// pass the test above.
func TestMockClipURL_UsesThePortItIsGiven(t *testing.T) {
	got := MockClipURL(3999)
	if !strings.Contains(got, ":3999/") {
		t.Errorf("MockClipURL(3999) = %q, want the port in it", got)
	}
}

// The drift guard. The URL and the route are one constant, and this fails if
// they are ever split back apart: it takes the path out of the URL and asks
// the real mux to serve it.
func TestMockClipURL_PathIsServedByTheRegisteredRoute(t *testing.T) {
	u, err := url.Parse(MockClipURL(8080))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	srv := &Server{}
	mux := http.NewServeMux()
	srv.registerMockRoutes(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", u.Path, nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s (the path MockClipURL hands to ingest) = %d, want 200 — the URL and the route have drifted apart", u.Path, rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "video/mp4" {
		t.Errorf("Content-Type = %q, want video/mp4", ct)
	}
	// The failure mode was a tiny non-video body, so assert the response is
	// actually large enough to be the fixture rather than a redirect or an
	// error page that happened to return 200.
	if n := rec.Body.Len(); n < 1000 {
		t.Errorf("body = %d bytes, want the embedded clip — a body this small is what a redirect or error page looks like, which is exactly the bug", n)
	}
}
