package loop

import (
	"testing"
	"time"
)

// finalAssetFor is the plumbing that closes the "reorder lands while
// assembly is running" race (0042_final_built_from_cut_order.sql): the
// cut_order_updated_at value SceneClipsForProject reads alongside the
// clips must be exactly what lands on the final asset's
// BuiltFromCutOrderAt, unmodified.
func TestFinalAssetFor_CarriesTheStampReadAlongsideTheClips(t *testing.T) {
	stamp := time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC)
	bytesOut := int64(12345)

	got := finalAssetFor("project-1", "projects/project-1/final/abc.mp4", &bytesOut, &stamp)

	if got.BuiltFromCutOrderAt == nil || !got.BuiltFromCutOrderAt.Equal(stamp) {
		t.Errorf("finalAssetFor().BuiltFromCutOrderAt = %v, want %v", got.BuiltFromCutOrderAt, stamp)
	}
	if got.ProjectID != "project-1" {
		t.Errorf("finalAssetFor().ProjectID = %q, want %q", got.ProjectID, "project-1")
	}
	if got.Kind != "final" {
		t.Errorf("finalAssetFor().Kind = %q, want %q", got.Kind, "final")
	}
	if got.StorageKey != "projects/project-1/final/abc.mp4" {
		t.Errorf("finalAssetFor().StorageKey = %q, want %q", got.StorageKey, "projects/project-1/final/abc.mp4")
	}
	if got.Bytes == nil || *got.Bytes != bytesOut {
		t.Errorf("finalAssetFor().Bytes = %v, want %v", got.Bytes, bytesOut)
	}
}

// finalAssetFor itself is a pure passthrough and does not decide what nil
// means — SceneClipsForProject (worker/internal/store/store.go) no longer
// ever returns nil for a project with clips (it's
// COALESCE(cut_order_updated_at, now()) as of
// 0043_built_from_cut_order_at_no_null_on_write.sql), so this pins only
// that finalAssetFor does not itself inject a value when handed nil —
// e.g. if a future caller has a legitimate reason to pass one through.
func TestFinalAssetFor_NilStampWhenGivenNil(t *testing.T) {
	bytesOut := int64(999)

	got := finalAssetFor("project-2", "projects/project-2/final/xyz.mp4", &bytesOut, nil)

	if got.BuiltFromCutOrderAt != nil {
		t.Errorf("finalAssetFor().BuiltFromCutOrderAt = %v, want nil", got.BuiltFromCutOrderAt)
	}
}
