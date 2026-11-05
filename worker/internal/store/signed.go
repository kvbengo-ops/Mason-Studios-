package store

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// signedURLTimeout bounds the call to Supabase Storage's sign endpoint —
// this sits on the dispatch hot path and must not hang the loop.
const signedURLTimeout = 15 * time.Second

// mediaBucket is the single fixed Supabase Storage bucket every asset lives
// in — see web/lib/storage.ts's MEDIA_BUCKET, which this must stay in sync
// with. scenes/assets.storage_key holds only the object's path within this
// bucket (shaped "projects/{projectId}/{kind}/{uuid}.{ext}"), not a
// "bucket/path" pair, so unlike a generic signer this needs no bucket
// parsing.
const mediaBucket = "media"

// SignedURL builds a time-limited, publicly-fetchable URL for an object in
// Supabase Storage, using the service-role key. kie fetches the reference
// frame image over this URL when a render is submitted (see
// internal/kie and internal/loop/dispatch.go), so the URL must remain valid
// for at least as long as kie takes to pick up the job — expiresIn is left
// to the caller to size generously for that.
//
// storageKey is the object's path within the media bucket (what
// RefFrameURL returns, e.g. "projects/{id}/ref_frame/{uuid}.png").
//
// POST {SUPABASE_URL}/storage/v1/object/sign/media/{path}
// Header: Authorization: Bearer {serviceRoleKey}
// Body:   {"expiresIn": N}
// Resp:   {"signedURL": "/object/sign/media/{path}?token=..."}
//
// The returned path is relative to the STORAGE API root, not to the project
// host — it does not carry the /storage/v1 prefix. Joining it to supabaseURL
// alone yields a 404, and the only symptom is fal reporting
//
//	input.image_url: Failed to download the file
//
// several minutes later, which is what happened on the first real render.
func SignedURL(ctx context.Context, httpClient *http.Client, supabaseURL, serviceRoleKey, storageKey string, expiresIn time.Duration) (string, error) {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: signedURLTimeout}
	}
	if storageKey == "" {
		return "", fmt.Errorf("store: signed url: storage key is empty")
	}

	reqCtx, cancel := context.WithTimeout(ctx, signedURLTimeout)
	defer cancel()

	base := strings.TrimRight(supabaseURL, "/")
	endpoint := fmt.Sprintf("%s/storage/v1/object/sign/%s/%s", base, mediaBucket, strings.TrimLeft(storageKey, "/"))

	body, err := json.Marshal(map[string]int{"expiresIn": int(expiresIn.Seconds())})
	if err != nil {
		return "", fmt.Errorf("store: signed url: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return "", fmt.Errorf("store: signed url: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+serviceRoleKey)
	req.Header.Set("apikey", serviceRoleKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("store: signed url for %s: %w", storageKey, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("store: signed url for %s: read response: %w", storageKey, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("store: signed url for %s: status %d: %s", storageKey, resp.StatusCode, string(respBody))
	}

	var out struct {
		SignedURL string `json:"signedURL"`
	}
	if err := json.Unmarshal(respBody, &out); err != nil {
		return "", fmt.Errorf("store: signed url for %s: decode response: %w", storageKey, err)
	}
	if out.SignedURL == "" {
		return "", fmt.Errorf("store: signed url for %s: response had no signedURL", storageKey)
	}

	if strings.HasPrefix(out.SignedURL, "http://") || strings.HasPrefix(out.SignedURL, "https://") {
		return out.SignedURL, nil
	}
	// Tolerate either shape: today Supabase returns the path without the
	// /storage/v1 prefix, but the object path itself never contains that
	// segment, so checking for it is unambiguous and survives a change.
	rel := strings.TrimLeft(out.SignedURL, "/")
	if !strings.HasPrefix(rel, "storage/v1/") {
		rel = "storage/v1/" + rel
	}
	return base + "/" + rel, nil
}
