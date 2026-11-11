package store

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"ugc-pipeline/worker/internal/config"
)

// uploadTimeout bounds a single Supabase Storage upload. Clips are only a
// few MB after normalization, so this is generous headroom, not a tight
// budget.
const uploadTimeout = 60 * time.Second

// UploadObject uploads body to Supabase Storage at {bucket}/{path}, using
// the service-role key. It upserts (x-upsert: true) rather than failing on
// conflict: a retried webhook or a reconcile pass that re-ingests the same
// scene must be able to overwrite its own prior (possibly partial) upload
// rather than erroring, since callers rely on the store-level idempotency
// guard (scene.status == 'done'), not on storage 409s, to prevent
// duplicate work.
//
// POST {SUPABASE_URL}/storage/v1/object/{bucket}/{path}
// Header: Authorization: Bearer {serviceRoleKey}
func UploadObject(ctx context.Context, cfg *config.Config, bucket, path string, body io.Reader, contentType string) error {
	if bucket == "" {
		return fmt.Errorf("store: upload object: bucket is empty")
	}
	if path == "" {
		return fmt.Errorf("store: upload object: path is empty")
	}

	reqCtx, cancel := context.WithTimeout(ctx, uploadTimeout)
	defer cancel()

	base := strings.TrimRight(cfg.SupabaseURL, "/")
	endpoint := fmt.Sprintf("%s/storage/v1/object/%s/%s", base, bucket, strings.TrimLeft(path, "/"))

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, body)
	if err != nil {
		return fmt.Errorf("store: upload object %s: build request: %w", path, err)
	}
	req.Header.Set("Authorization", "Bearer "+cfg.SupabaseServiceRoleKey)
	req.Header.Set("apikey", cfg.SupabaseServiceRoleKey)
	req.Header.Set("x-upsert", "true")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}

	httpClient := &http.Client{Timeout: uploadTimeout}
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("store: upload object %s: %w", path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("store: upload object %s: status %d: %s", path, resp.StatusCode, string(respBody))
	}
	return nil
}

// deleteBatch is how many keys go in one Storage delete call.
const deleteBatch = 100

// DeleteObjects removes keys from a Supabase Storage bucket. A key that is
// already gone is not an error — Storage answers 200 with only the objects it
// actually removed.
//
// DELETE {SUPABASE_URL}/storage/v1/object/{bucket}  body {"prefixes":[...]}
func DeleteObjects(ctx context.Context, cfg *config.Config, bucket string, keys []string) error {
	if bucket == "" {
		return fmt.Errorf("store: delete objects: bucket is empty")
	}
	endpoint := fmt.Sprintf("%s/storage/v1/object/%s", strings.TrimRight(cfg.SupabaseURL, "/"), bucket)
	httpClient := &http.Client{Timeout: uploadTimeout}

	for start := 0; start < len(keys); start += deleteBatch {
		end := min(start+deleteBatch, len(keys))
		payload, err := json.Marshal(map[string][]string{"prefixes": keys[start:end]})
		if err != nil {
			return fmt.Errorf("store: delete objects: encode: %w", err)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, bytes.NewReader(payload))
		if err != nil {
			return fmt.Errorf("store: delete objects: build request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+cfg.SupabaseServiceRoleKey)
		req.Header.Set("apikey", cfg.SupabaseServiceRoleKey)
		req.Header.Set("Content-Type", "application/json")
		resp, err := httpClient.Do(req)
		if err != nil {
			return fmt.Errorf("store: delete objects: %w", err)
		}
		respBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("store: delete objects: status %d: %s", resp.StatusCode, string(respBody))
		}
	}
	return nil
}

// PER ATTEMPT, not per scene — and this is the same lesson
// StorageKeyForFinal's comment below records, arriving one level down.
//
// UploadObject upserts. This key used to be projects/{projectId}/clip/
// {sceneId}.{ext}, which was correct only while a scene could have exactly one
// clip. 0058_scene_versions.sql stopped that: every render adds a version and
// the old ones are KEPT, with the version rail offering Download and "Make
// current" on each. With a fixed key all of those rows pointed at one object,
// so the third render overwrote the first two and v1's row survived, resolved,
// and played v3 — three renders billed, one kept, and a version rail that
// looked like it was working.
//
// The attempt id is kie's task id: immutable per render, already on the scene
// row by the time ingest runs (both callers resolve the scene BY it), and the
// same value the run is recorded against.
//
// StorageKeyForClip builds the storage key for one render of a scene:
// projects/{projectId}/clip/{sceneId}.{ext}
func StorageKeyForClip(projectID, sceneID, attemptID, ext string) string {
	return fmt.Sprintf("projects/%s/clip/%s-%s.%s", projectID, sceneID, sanitizeKeySegment(attemptID), ext)
}

// sanitizeKeySegment keeps a vendor-supplied id safe to put in an object key.
//
// kie's task ids have only been alphanumerics and hyphens so far, but they are
// THEIR string, not ours, and a slash in one would silently move the object
// into a different folder — which for `projects/{projectId}/…` keys is not
// cosmetic: 0005/0048's storage policies find the project id at
// (storage.foldername(name))[2], so an extra segment moves the id out from
// under the policy that guards it.
func sanitizeKeySegment(raw string) string {
	var b strings.Builder
	for _, r := range raw {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	return b.String()
}

// StorageKeyForFinal builds the storage key for one FINAL VERSION's
// assembled video: projects/{projectId}/final/{finalVersionId}.{ext}.
//
// The version id is in the key because UploadObject upserts. This used to
// be the fixed name final.{ext}, which was correct only while a project
// could have exactly one final and re-assembling deleted the previous one
// first. 0060_final_versions.sql stopped that deletion — old versions are
// kept now — so a fixed key would mean every rebuild silently overwrote the
// object every older version's row still points at: v1's row would survive,
// resolve, and play v3. Data loss wearing the shape of success, which is
// how that migration's header puts it.
func StorageKeyForFinal(projectID, finalVersionID, ext string) string {
	return fmt.Sprintf("projects/%s/final/%s.%s", projectID, finalVersionID, ext)
}

// StorageKeyForPoster builds the storage key for a scene's clip poster
// frame: projects/{projectId}/poster/{sceneId}.{ext}. Mirrors
// StorageKeyForClip's shape — same projectId/sceneId pair, just a
// different subfolder and extension.
func StorageKeyForPoster(projectID, sceneID, attemptID, ext string) string {
	return fmt.Sprintf("projects/%s/poster/%s-%s.%s", projectID, sceneID, sanitizeKeySegment(attemptID), ext)
}

// StorageKeyForFinalPoster builds the storage key for one final version's
// poster frame. Per-version for exactly the same reason as
// StorageKeyForFinal — the "poster." prefix keeps it from colliding with
// that key, since both live under final/ and are keyed by the same id.
func StorageKeyForFinalPoster(projectID, finalVersionID, ext string) string {
	return fmt.Sprintf("projects/%s/final/poster-%s.%s", projectID, finalVersionID, ext)
}
