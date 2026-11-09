import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { openSceneVersion } from "@/actions/enqueue";
import { requireApiToken } from "@/lib/api-auth";
import { attachApiSceneReferences, ensurePersonalClipProjectForUser } from "@/lib/api-references";
import { apiClipQuote, parseApiClipInput, prepareApiClip, teamModelRefusal } from "@/lib/api-clip";
import {
  apiGenerateRequestHash,
  discardOwnedPreparation,
  isPrepareLeaseStale,
  loadApiSceneStatus,
  sweepAbandonedApiScenes,
} from "@/lib/api-generation";
import { apiError, readJsonObject } from "@/lib/api-v1";
import { isDev } from "@/lib/mode";
import { mergeRenderSettings } from "@/lib/models";
import { queueScenesIfWithinCaps } from "@/lib/spend";
import { removeStorageObjects } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function jobResponse(
  scene: { id: string; status: string; estimated_cost_usd: number | null },
  deduplicated: boolean,
): NextResponse {
  return NextResponse.json(
    {
      job_id: scene.id,
      status: scene.status === "frame_ready" ? "preparing" : scene.status,
      deduplicated,
      estimated_cost_usd: scene.estimated_cost_usd,
    },
    { status: scene.status === "frame_ready" ? 202 : 200 },
  );
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireApiToken(request, "generate");
  if (!auth.ok) return auth.response;

  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 128 || /[\r\n\0]/.test(idempotencyKey)) {
    return apiError(
      "A 1-128 character Idempotency-Key header is required.",
      "invalid_idempotency_key",
      400,
    );
  }

  const parsedBody = await readJsonObject(request);
  if (parsedBody.response) return parsedBody.response;
  const parsedInput = parseApiClipInput(parsedBody.value);
  if ("ok" in parsedInput) {
    return apiError(parsedInput.error, parsedInput.code, parsedInput.status);
  }
  const teamRefusal = teamModelRefusal(auth.profile.team, parsedInput.modelId);
  if (teamRefusal) return apiError(teamRefusal.error, teamRefusal.code, teamRefusal.status);

  const admin = createAdminClient();
  let projectId: string;
  try {
    projectId = await ensurePersonalClipProjectForUser(admin, auth.userId);
  } catch (error) {
    console.error("POST /api/v1/generate project setup failed", error);
    return apiError("Could not prepare the API project.", "project_setup_failed", 500);
  }

  try {
    await sweepAbandonedApiScenes(admin);
  } catch (error) {
    console.error("POST /api/v1/generate stale-scene sweep failed", error);
  }

  const requestHash = apiGenerateRequestHash(parsedInput);
  const { data: priorScene, error: priorError } = await admin
    .from("scenes")
    .select("id, status, idempotency_hash, prepare_token, prepare_started_at, estimated_cost_usd")
    .eq("project_id", projectId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (priorError) {
    console.error("POST /api/v1/generate idempotency lookup failed", priorError);
    return apiError("Could not check the idempotency key.", "idempotency_lookup_failed", 500);
  }
  if (priorScene) {
    if (priorScene.idempotency_hash !== requestHash) {
      return apiError(
        "This Idempotency-Key was already used with a different request.",
        "idempotency_conflict",
        409,
      );
    }
    if (
      priorScene.status !== "frame_ready" ||
      !isPrepareLeaseStale(priorScene.prepare_started_at)
    ) {
      return jobResponse(
        {
          id: priorScene.id,
          status: priorScene.status,
          estimated_cost_usd:
            priorScene.estimated_cost_usd === null ? null : Number(priorScene.estimated_cost_usd),
        },
        true,
      );
    }
  }

  const prepared = await prepareApiClip(admin, auth.userId, parsedInput);
  if (!prepared.ok) return apiError(prepared.error, prepared.code, prepared.status);

  let sceneId: string | null = null;
  let prepareToken: string | null = null;
  let attachedStorageKeys: string[] = [];
  let ownsPreparation = false;

  try {
    if (priorScene) {
      sceneId = priorScene.id;
      prepareToken = randomUUID();
      const { data, error } = await admin.rpc("reclaim_stale_frame_ready_scene", {
        p_scene_id: sceneId,
        p_project_id: projectId,
        p_expected_prepare_token: priorScene.prepare_token,
        p_new_prepare_token: prepareToken,
      });
      if (error) throw new Error(`Failed to reclaim stale API scene: ${error.message}`);
      const reclaimed = Array.isArray(data) ? data[0] : data;
      if (!reclaimed?.claimed) {
        const current = await loadApiSceneStatus(admin, projectId, sceneId);
        return current
          ? jobResponse(current, true)
          : apiError("Job was not found.", "not_found", 404);
      }
      ownsPreparation = true;
      if (reclaimed.superseded_keys.length > 0) {
        attachedStorageKeys = reclaimed.superseded_keys;
        await removeStorageObjects(reclaimed.superseded_keys);
        attachedStorageKeys = [];
      }
    } else {
      prepareToken = randomUUID();
      const { data, error } = await admin.rpc("insert_frame_ready_scene", {
        p_project_id: projectId,
        p_expected_user_id: auth.userId,
        p_duration_s: prepared.input.durationS,
        p_is_talking_head: prepared.input.isTalkingHead,
        p_video_prompt: prepared.references.rewrittenPrompt,
        p_ai_generated_prompt:
          prepared.references.submittedPrompt === prepared.references.rewrittenPrompt
            ? null
            : prepared.references.submittedPrompt,
        p_render_settings_override: {
          model: prepared.input.modelId,
          resolution: prepared.input.resolution,
          aspect_ratio: prepared.input.aspectRatio,
          ...(prepared.input.modelId === "seedance-2.5-byteplus" ? { quality: "high" } : {}),
        },
        p_dev: isDev(),
        p_api_token_id: auth.tokenId,
        p_idempotency_key: idempotencyKey,
        p_idempotency_hash: requestHash,
        p_prepare_token: prepareToken,
      });
      if (error) throw new Error(`Failed to prepare API scene: ${error.message}`);
      const inserted = Array.isArray(data) ? data[0] : data;
      if (!inserted) throw new Error("insert_frame_ready_scene returned no row");
      sceneId = inserted.scene_id;
      if (inserted.idempotency_hash !== requestHash) {
        return apiError(
          "This Idempotency-Key was already used with a different request.",
          "idempotency_conflict",
          409,
        );
      }
      if (inserted.outcome === "existing") {
        if (
          inserted.scene_status !== "frame_ready" ||
          !isPrepareLeaseStale(inserted.prepare_started_at)
        ) {
          const current = await loadApiSceneStatus(admin, projectId, inserted.scene_id);
          return current
            ? jobResponse(current, true)
            : apiError("Job was not found.", "not_found", 404);
        }
        const oldPrepareToken = inserted.prepare_token;
        prepareToken = randomUUID();
        const { data: claimData, error: claimError } = await admin.rpc(
          "reclaim_stale_frame_ready_scene",
          {
            p_scene_id: inserted.scene_id,
            p_project_id: projectId,
            p_expected_prepare_token: oldPrepareToken,
            p_new_prepare_token: prepareToken,
          },
        );
        if (claimError) throw new Error(`Failed to reclaim stale API scene: ${claimError.message}`);
        const claim = Array.isArray(claimData) ? claimData[0] : claimData;
        if (!claim?.claimed) {
          const current = await loadApiSceneStatus(admin, projectId, inserted.scene_id);
          return current
            ? jobResponse(current, true)
            : apiError("Job was not found.", "not_found", 404);
        }
        ownsPreparation = true;
        if (claim.superseded_keys.length > 0) {
          attachedStorageKeys = claim.superseded_keys;
          await removeStorageObjects(claim.superseded_keys);
          attachedStorageKeys = [];
        }
      } else {
        ownsPreparation = true;
      }
    }

    const sceneIdForAttempt = sceneId;
    const tokenForAttempt = prepareToken;
    if (!sceneIdForAttempt || !tokenForAttempt)
      throw new Error("API scene preparation lost its lease.");

    const attached = await attachApiSceneReferences({
      admin,
      projectId,
      sceneId: sceneIdForAttempt,
      prepareToken: tokenForAttempt,
      orderedReferences: prepared.references.orderedReferences,
    });
    attachedStorageKeys = attached.attachedStorageKeys;
    if (attached.fenced) {
      if (attachedStorageKeys.length > 0) await removeStorageObjects(attachedStorageKeys);
      ownsPreparation = false;
      const current = await loadApiSceneStatus(admin, projectId, sceneIdForAttempt);
      return current
        ? jobResponse(current, true)
        : apiError("Job was not found.", "not_found", 404);
    }

    // Same as every browser queue path (ugc.ts generateClip): the worker links the
    // clip to scenes.active_version_id, and /create's wall reads takes from
    // scene_versions — without this the clip renders, bills, and never shows.
    const { data: versionScene } = await admin
      .from("scenes")
      .select(
        "id, video_prompt, ref_frame_asset_id, duration_s, render_settings_override, projects(render_settings)",
      )
      .eq("id", sceneIdForAttempt)
      .eq("project_id", projectId)
      .maybeSingle();
    if (versionScene) {
      await openSceneVersion(
        admin,
        versionScene,
        mergeRenderSettings(
          versionScene.projects?.render_settings,
          versionScene.render_settings_override,
        ),
      );
    }

    const queued = await queueScenesIfWithinCaps({
      admin,
      projectId,
      userId: auth.userId,
      profile: auth.profile,
      sceneIds: [sceneIdForAttempt],
      estimatesUsd: [prepared.estimatedCostUsd],
      apiTokenId: auth.tokenId,
      prepareToken: tokenForAttempt,
    });
    if (queued.outcome === "blocked") {
      await discardOwnedPreparation({
        admin,
        projectId,
        sceneId: sceneIdForAttempt,
        prepareToken: tokenForAttempt,
        storageKeys: attachedStorageKeys,
      });
      ownsPreparation = false;
      return apiError(queued.error, queued.code, 403);
    }
    if (queued.outcome === "fenced") {
      if (attachedStorageKeys.length > 0) await removeStorageObjects(attachedStorageKeys);
      ownsPreparation = false;
      const current = await loadApiSceneStatus(admin, projectId, sceneIdForAttempt);
      return current
        ? jobResponse(current, true)
        : apiError("Job was not found.", "not_found", 404);
    }

    ownsPreparation = false;
    return NextResponse.json(
      {
        job_id: sceneIdForAttempt,
        status: "queued",
        deduplicated: false,
        estimated_cost_usd: prepared.estimatedCostUsd,
        quote: apiClipQuote(prepared),
      },
      { status: 202 },
    );
  } catch (error) {
    if (ownsPreparation && sceneId && prepareToken) {
      try {
        await discardOwnedPreparation({
          admin,
          projectId,
          sceneId,
          prepareToken,
          storageKeys: attachedStorageKeys,
        });
      } catch (cleanupError) {
        console.error(`POST /api/v1/generate cleanup failed for ${sceneId}`, cleanupError);
      }
    }
    console.error("POST /api/v1/generate failed", error);
    return apiError("Could not prepare this clip.", "generate_failed", 500);
  }
}
