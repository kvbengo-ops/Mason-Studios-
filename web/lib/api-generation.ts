import "server-only";

import { createHash } from "node:crypto";
import { removeStorageObjects } from "@/lib/storage";
import type { ApiClipInput } from "@/lib/api-clip";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, SceneStatus } from "@/types/db";

export const STALE_PREPARE_LEASE_MS = 15_000;

export function apiGenerateRequestHash(input: ApiClipInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        prompt: input.prompt,
        model_id: input.modelId,
        resolution: input.resolution,
        duration_s: input.durationS,
        is_talking_head: input.isTalkingHead,
        image_refs: input.imageRefs,
        video_refs: input.videoRefs,
        audio_refs: input.audioRefs,
      }),
      "utf8",
    )
    .digest("hex");
}

export function isPrepareLeaseStale(prepareStartedAt: string | null, now = Date.now()): boolean {
  return prepareStartedAt !== null && Date.parse(prepareStartedAt) < now - STALE_PREPARE_LEASE_MS;
}

export async function sweepAbandonedApiScenes(
  admin: SupabaseClient<Database>,
  pageSize = 100,
): Promise<void> {
  const { data: candidates, error } = await admin
    .from("scenes")
    .select("id, prepare_token")
    .eq("status", "frame_ready")
    .not("api_token_id", "is", null)
    .not("prepare_token", "is", null)
    .lt("prepare_started_at", new Date(Date.now() - 5 * 60_000).toISOString())
    .order("prepare_started_at", { ascending: true })
    .limit(pageSize);
  if (error) throw new Error(`Failed to find abandoned API scenes: ${error.message}`);

  for (const candidate of candidates ?? []) {
    if (!candidate.prepare_token) continue;
    const { data, error: deleteError } = await admin.rpc("delete_abandoned_api_scene", {
      p_scene_id: candidate.id,
      p_prepare_token: candidate.prepare_token,
    });
    if (deleteError) {
      throw new Error(`Failed to sweep API scene ${candidate.id}: ${deleteError.message}`);
    }
    const row = Array.isArray(data) ? data[0] : data;
    // The SQL RPC re-checks its 5-minute lease with clock_timestamp() while
    // holding the scene row lock; only its DELETE result authorizes cleanup.
    if (row?.scene_id && row.storage_keys.length > 0) {
      await removeStorageObjects(row.storage_keys);
    }
  }
}

export async function discardOwnedPreparation(args: {
  admin: SupabaseClient<Database>;
  projectId: string;
  sceneId: string;
  prepareToken: string;
  storageKeys: readonly string[];
}): Promise<boolean> {
  const { admin, projectId, sceneId, prepareToken, storageKeys } = args;
  const { data: assets, error: assetReadError } = await admin
    .from("assets")
    .select("id")
    .eq("scene_id", sceneId);
  if (assetReadError) throw new Error(`Failed to read API scene assets: ${assetReadError.message}`);

  const { data: deleted, error: deleteError } = await admin
    .from("scenes")
    .delete()
    .eq("id", sceneId)
    .eq("project_id", projectId)
    .eq("status", "frame_ready")
    .eq("prepare_token", prepareToken)
    .select("id")
    .maybeSingle();
  if (deleteError) throw new Error(`Failed to clean API scene ${sceneId}: ${deleteError.message}`);
  if (!deleted) return false;

  const assetIds = (assets ?? []).map((asset) => asset.id);
  if (assetIds.length > 0) {
    const { error: deleteAssetsError } = await admin.from("assets").delete().in("id", assetIds);
    if (deleteAssetsError) {
      throw new Error(`Failed to clean API scene assets: ${deleteAssetsError.message}`);
    }
  }
  if (storageKeys.length > 0) await removeStorageObjects([...storageKeys]);
  return true;
}

export interface ApiSceneStatus {
  id: string;
  status: SceneStatus;
  estimated_cost_usd: number | null;
}

export async function loadApiSceneStatus(
  admin: SupabaseClient<Database>,
  projectId: string,
  sceneId: string,
): Promise<ApiSceneStatus | null> {
  const { data, error } = await admin
    .from("scenes")
    .select("id, status, estimated_cost_usd")
    .eq("id", sceneId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read API job ${sceneId}: ${error.message}`);
  return data
    ? {
        id: data.id,
        status: data.status,
        estimated_cost_usd:
          data.estimated_cost_usd === null ? null : Number(data.estimated_cost_usd),
      }
    : null;
}
