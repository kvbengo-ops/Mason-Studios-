// Picks which archived asset becomes a /bin card's thumbnail — extracted
// from app/(app)/bin/page.tsx so this branching logic can carry its own
// test coverage. See that page's own header for the surrounding context
// (two-phase build, why signing happens in one Promise.all).

// IMAGE_ASSET_KINDS moved to lib/asset-kinds.ts when actions/ugc.ts began
// reading it too — see that file's header. It is re-exported here because
// this module's test names it, and because a reader arriving from a /bin
// card should not have to guess where the picture list went.
export { IMAGE_ASSET_KINDS } from "@/lib/asset-kinds";
import { IMAGE_ASSET_KINDS } from "@/lib/asset-kinds";
import type { AssetKind } from "@/types/db";

/** One element of an archived `assets` array, or an archived `clip_asset` —
 * both are jsonb snapshots of a full `assets` row (0088/0092's own header
 * comments), cast down to the two fields this page actually reads. */
// The cast is BORROWED safety: assets.storage_key is `not null`
// (0001_init.sql) and both archive triggers snapshot with to_jsonb, so the
// key cannot be missing today. `usable()` below does not trust that anyway,
// and the reason is sharper than "a future migration might loosen it": a row
// with no key does not merely fail to render, it SHADOWS a good fallback
// standing right behind it. A scene holding a keyless poster and a perfectly
// good ref_frame would show nothing, having had something to show all along.
export interface ArchivedAssetRow {
  kind: AssetKind;
  storage_key: string;
}

/** A row is only a candidate if it can actually name an object. Applied
 * inside every `find` predicate rather than after one, so an unusable row is
 * passed over instead of winning and hiding the next one. */
function usable(asset: ArchivedAssetRow): boolean {
  return typeof asset.storage_key === "string" && asset.storage_key.length > 0;
}

export interface ThumbnailSource {
  kind: "image" | "video";
  storageKey: string;
}

/**
 * Best available still for a deleted SCENE, in the order an editor would
 * actually recognise the shot by: the worker's own poster first (cheap,
 * already framed for exactly this purpose), then the reference frame an
 * operator approved at Gate 2, then any other image-kind asset this scene
 * happened to carry (a character/product/composite ref, or a standalone
 * generated image), and only then the clip itself — a video is a valid but
 * heavier source of "what does this look like," so it's the last resort,
 * not the first choice.
 */
export function pickSceneThumbnailSource(assetsJson: unknown): ThumbnailSource | null {
  const rows = Array.isArray(assetsJson) ? (assetsJson as ArchivedAssetRow[]) : [];
  const poster = rows.find((asset) => asset.kind === "poster" && usable(asset));
  if (poster) return { kind: "image", storageKey: poster.storage_key };
  const refFrame = rows.find((asset) => asset.kind === "ref_frame" && usable(asset));
  if (refFrame) return { kind: "image", storageKey: refFrame.storage_key };
  const otherImage = rows.find((asset) => IMAGE_ASSET_KINDS.has(asset.kind) && usable(asset));
  if (otherImage) return { kind: "image", storageKey: otherImage.storage_key };
  const clip = rows.find((asset) => asset.kind === "clip" && usable(asset));
  if (clip) return { kind: "video", storageKey: clip.storage_key };
  return null;
}

/** A deleted VERSION only ever snapshots one asset — its own clip
 * (deleted_scene_versions.clip_asset, null when the version never rendered
 * one) — so there's no priority order to apply, only "is there one at
 * all." */
export function versionClipThumbnailSource(clipAssetJson: unknown): ThumbnailSource | null {
  const asset = clipAssetJson as ArchivedAssetRow | null;
  return asset && usable(asset) ? { kind: "video", storageKey: asset.storage_key } : null;
}

export interface SceneClipSource {
  clipStorageKey: string;
  posterStorageKey: string | null;
}

/**
 * Extracts a playable video clip (and optional poster/frame still) for a
 * deleted scene when the scene had rendered a clip before deletion, so
 * admins and owners can preview the actual video in /bin rather than only
 * a static poster frame.
 */
export function pickSceneClipSource(assetsJson: unknown): SceneClipSource | null {
  const rows = Array.isArray(assetsJson) ? (assetsJson as ArchivedAssetRow[]) : [];
  const reversed = [...rows].reverse();
  const clip = reversed.find((asset) => asset.kind === "clip" && usable(asset));
  if (!clip) return null;
  const poster = reversed.find((asset) => asset.kind === "poster" && usable(asset));
  if (poster) {
    return { clipStorageKey: clip.storage_key, posterStorageKey: poster.storage_key };
  }
  const refFrame = reversed.find((asset) => asset.kind === "ref_frame" && usable(asset));
  if (refFrame) {
    return { clipStorageKey: clip.storage_key, posterStorageKey: refFrame.storage_key };
  }
  const otherImage = reversed.find((asset) => IMAGE_ASSET_KINDS.has(asset.kind) && usable(asset));
  return {
    clipStorageKey: clip.storage_key,
    posterStorageKey: otherImage ? otherImage.storage_key : null,
  };
}

/**
 * Collects every usable `storage_key` from an archived scene's `assets`
 * array and/or an archived version's `clip_asset` object for Storage cleanup
 * when an entry is permanently deleted by an admin or expires after 3 days.
 */
export function extractArchivedStorageKeys(
  assetsJson: unknown,
  clipAssetJson?: unknown,
): string[] {
  const keys = new Set<string>();
  if (Array.isArray(assetsJson)) {
    for (const item of assetsJson as ArchivedAssetRow[]) {
      if (item && usable(item)) {
        keys.add(item.storage_key);
      }
    }
  }
  const clipAsset = clipAssetJson as ArchivedAssetRow | null | undefined;
  if (clipAsset && usable(clipAsset)) {
    keys.add(clipAsset.storage_key);
  }
  return Array.from(keys);
}

/** Deleted scenes, clip versions and images stay in /bin for 3 days. worker/internal/loop/purge_bin.go must use the same window. */
export const BIN_RETENTION_DAYS = 3;
export const BIN_RETENTION_MS = BIN_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export function binRetentionCutoffIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - BIN_RETENTION_MS).toISOString();
}

export function isBinEntryExpired(deletedAt: string, nowMs: number = Date.now()): boolean {
  const deletedAtMs = new Date(deletedAt).getTime();
  if (Number.isNaN(deletedAtMs)) return false;
  return nowMs - deletedAtMs >= BIN_RETENTION_MS;
}

export function binExpiryLabel(deletedAt: string, nowMs: number = Date.now()): string | null {
  const deletedAtMs = new Date(deletedAt).getTime();
  if (Number.isNaN(deletedAtMs)) return null;
  const remainingMs = deletedAtMs + BIN_RETENTION_MS - nowMs;
  if (remainingMs <= 0) return "Expired";
  const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  return remainingDays === 1 ? "1d left in bin" : `${remainingDays}d left in bin`;
}
