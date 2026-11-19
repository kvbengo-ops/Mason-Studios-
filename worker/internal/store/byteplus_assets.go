package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// BytePlusAsset is one byteplus_assets row (0147): the BytePlus Asset Library
// asset holding a reference source, and its last known status.
type BytePlusAsset struct {
	AssetID string
	// Status is BytePlus's own: "Processing", "Active" or "Failed".
	Status string
	Error  *string
}

// BytePlusAsset reads the cached upload for sourceKey (SceneReference.SourceKey).
// ok is false when the source has never been sent to BytePlus.
func (s *Store) BytePlusAsset(ctx context.Context, sourceKey string) (BytePlusAsset, bool, error) {
	var a BytePlusAsset
	err := s.pool.QueryRow(ctx, `
SELECT byteplus_asset_id, status, error FROM byteplus_assets WHERE source_key = $1`, sourceKey).
		Scan(&a.AssetID, &a.Status, &a.Error)
	if errors.Is(err, pgx.ErrNoRows) {
		return BytePlusAsset{}, false, nil
	}
	if err != nil {
		return BytePlusAsset{}, false, fmt.Errorf("store: byteplus asset for %s: %w", sourceKey, err)
	}
	return a, true, nil
}

// SaveBytePlusAsset records (or updates) the upload for sourceKey.
func (s *Store) SaveBytePlusAsset(ctx context.Context, sourceKey string, a BytePlusAsset) error {
	_, err := s.pool.Exec(ctx, `
INSERT INTO byteplus_assets (source_key, byteplus_asset_id, status, error)
VALUES ($1, $2, $3, $4)
ON CONFLICT (source_key) DO UPDATE
SET byteplus_asset_id = EXCLUDED.byteplus_asset_id,
    status = EXCLUDED.status,
    error = EXCLUDED.error,
    updated_at = now()`, sourceKey, a.AssetID, a.Status, a.Error)
	if err != nil {
		return fmt.Errorf("store: save byteplus asset for %s: %w", sourceKey, err)
	}
	return nil
}
