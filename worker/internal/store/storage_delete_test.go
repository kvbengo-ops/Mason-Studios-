package store

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"ugc-pipeline/worker/internal/config"
)

func TestDeleteObjectsBatchesAndSendsPrefixes(t *testing.T) {
	var calls, total int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/storage/v1/object/media" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body struct {
			Prefixes []string `json:"prefixes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode: %v", err)
		}
		calls++
		total += len(body.Prefixes)
		w.Write([]byte("[]"))
	}))
	defer srv.Close()

	keys := make([]string, 250)
	for i := range keys {
		keys[i] = "projects/p/clip/" + strconv.Itoa(i) + ".mp4"
	}
	cfg := &config.Config{SupabaseURL: srv.URL, SupabaseServiceRoleKey: "k"}
	if err := DeleteObjects(context.Background(), cfg, "media", keys); err != nil {
		t.Fatal(err)
	}
	if calls != 3 || total != 250 {
		t.Fatalf("calls=%d total=%d, want 3 and 250", calls, total)
	}
}
