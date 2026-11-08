import { z } from "zod";
import type { BinCardThumbnail } from "@/components/bin-card";
import type { ImageHistoryCursor } from "@/components/image-generator-history";
import type { VideoRun } from "@/components/video-runs-panel";
import {
  pickSceneThumbnailSource,
  versionClipThumbnailSource,
  type ThumbnailSource,
} from "@/lib/bin-thumbnails";
import { estimateUsdForScenes } from "@/lib/estimate";
import {
  imageAttemptReason,
  imageAttemptStatus,
  type ImageAttemptStatus,
} from "@/lib/image-attempt";
import { KIE_MODELS } from "@/lib/kie/models";
import { getModel, IMAGE_MODELS, isAudioEnabled, mergeRenderSettings } from "@/lib/models";
import { signedUrl } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";

const HISTORY_PAGE_SIZE = 20;
const ATTEMPT_HISTORY_LIMIT = 8;
// An admin reviewing an account wants all of it, not a recent slice.
const RECENT_SCENES = 200;
const WALL_TAKES = 120;
const RECENT_RUNS = 100;
const SIGNED_URL_TTL_SECONDS = 3600;

const ATTEMPT_COLUMNS =
  "id, idempotency_key, created_at, model, error, settled_at, kie_task_id, asset_id, cost_usd";

const historyCursorSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    assetId: z.string().uuid(),
  })
  .nullable();

export interface EditorImageItem {
  assetId: string;
  createdAt: string;
  url: string;
  prompt: string | null;
  modelLabel: string | null;
  costUsd: number | null;
}

export interface EditorImagePage {
  images: EditorImageItem[];
  nextCursor: ImageHistoryCursor | null;
}

export interface EditorImageRun {
  runId: string;
  idempotencyKey: string | null;
  createdAt: string;
  status: ImageAttemptStatus;
  model: string;
  modelLabel: string;
  kieTaskId: string | null;
  reason: string | null;
  assetId: string | null;
  costUsd: number | null;
}

export interface EditorVideoClip {
  key: string;
  sceneId: string;
  versionId: string;
  n: number;
  projectId: string;
  projectTitle: string;
  personal: boolean;
  prompt: string;
  modelLabel: string;
  durationS: number | null;
  createdAt: string;
  url: string;
  costUsd: number | null;
}

export interface EditorVideosData {
  clips: EditorVideoClip[];
  runs: VideoRun[];
}

export interface EditorDeletedScene {
  sceneId: string;
  projectId: string | null;
  idx: number | null;
  prompt: string;
  modelLabel: string | null;
  deletedAt: string;
  purged: boolean;
  versionCount: number;
  thumbnail: BinCardThumbnail;
}

export interface EditorDeletedVersion {
  versionId: string;
  sceneId: string | null;
  projectId: string | null;
  n: number | null;
  prompt: string;
  modelLabel: string | null;
  deletedAt: string;
  purged: boolean;
  thumbnail: BinCardThumbnail;
}

export interface EditorDeletedImage {
  assetId: string;
  createdAt: string;
  deletedAt: string;
  prompt: string | null;
  modelLabel: string | null;
  costUsd: number | null;
  thumbnail: BinCardThumbnail;
}

export interface EditorDeletedData {
  scenes: EditorDeletedScene[];
  versions: EditorDeletedVersion[];
  images: EditorDeletedImage[];
}

function resolveImageModelLabel(model: string): string {
  const known = IMAGE_MODELS.find((m) => m.textToImageId === model || m.editId === model);
  return known?.label ?? model;
}

function snapshotModel(raw: unknown): { id: string | null; resolution: string | null } {
  if (typeof raw !== "object" || raw === null) return { id: null, resolution: null };
  const { model, resolution } = raw as { model?: unknown; resolution?: unknown };
  return {
    id: typeof model === "string" ? model : null,
    resolution: typeof resolution === "string" ? resolution : null,
  };
}

function returnedEstimate(
  scene: { is_talking_head: boolean; duration_s: number; render_settings_override: unknown },
  projectRenderSettings: unknown,
  audioEnabled: boolean,
): number | null {
  try {
    const usd = estimateUsdForScenes([scene], audioEnabled, projectRenderSettings);
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch {
    return null;
  }
}

function firstLine(text: string | null | undefined): string {
  const line = text?.split("\n")[0]?.trim();
  return line ? line : "(no prompt)";
}

/**
 * Loads one page of a target editor's personal generated images (read-only).
 * Must be called by a page that has already run `requireAdmin()`.
 */
export async function loadEditorImages(
  userId: string,
  cursor: ImageHistoryCursor | null = null,
): Promise<EditorImagePage> {
  const parsedCursor = historyCursorSchema.safeParse(cursor);
  if (!parsedCursor.success) throw new Error("Invalid image history cursor.");

  const supabase = await createClient();
  let query = supabase
    .from("assets")
    .select("id, created_at, storage_key")
    .eq("user_id", userId)
    .is("project_id", null)
    .eq("kind", "generated_image")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(HISTORY_PAGE_SIZE + 1);

  if (parsedCursor.data) {
    const { createdAt, assetId } = parsedCursor.data;
    query = query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${assetId})`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load editor images: ${error.message}`);

  const rows = data ?? [];
  const pageRows = rows.slice(0, HISTORY_PAGE_SIZE);
  const lastRow = pageRows.at(-1);

  const runByAssetId = new Map<
    string,
    { prompt: string | null; model: string; cost_usd: number | null }
  >();
  if (pageRows.length > 0) {
    const { data: runRows } = await supabase
      .from("runs")
      .select("asset_id, prompt, model, cost_usd")
      .eq("user_id", userId)
      .is("project_id", null)
      .in(
        "asset_id",
        pageRows.map((a) => a.id),
      );
    for (const run of runRows ?? []) {
      if (run.asset_id && !runByAssetId.has(run.asset_id)) {
        runByAssetId.set(run.asset_id, run);
      }
    }
  }

  const images: EditorImageItem[] = await Promise.all(
    pageRows.map(async (asset) => {
      const run = runByAssetId.get(asset.id);
      return {
        assetId: asset.id,
        createdAt: asset.created_at,
        url: await signedUrl(asset.storage_key),
        prompt: run?.prompt ?? null,
        modelLabel: run ? resolveImageModelLabel(run.model) : null,
        costUsd: run?.cost_usd ?? null,
      };
    }),
  );

  return {
    images,
    nextCursor:
      rows.length > HISTORY_PAGE_SIZE && lastRow
        ? { createdAt: lastRow.created_at, assetId: lastRow.id }
        : null,
  };
}

/**
 * Loads a target editor's recent personal image attempts (runs).
 * Must be called by a page that has already run `requireAdmin()`.
 */
export async function loadEditorImageRuns(userId: string): Promise<EditorImageRun[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("runs")
    .select(ATTEMPT_COLUMNS)
    .eq("user_id", userId)
    .is("project_id", null)
    .not("idempotency_key", "is", null)
    .order("created_at", { ascending: false })
    .limit(ATTEMPT_HISTORY_LIMIT);

  if (error) throw new Error(`Failed to load editor image runs: ${error.message}`);

  return (data ?? []).map((row) => ({
    runId: row.id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    status: imageAttemptStatus({
      settledAt: row.settled_at,
      kieTaskId: row.kie_task_id,
      error: row.error,
    }),
    model: row.model,
    modelLabel: resolveImageModelLabel(row.model),
    kieTaskId: row.kie_task_id,
    reason: imageAttemptReason(row.error),
    assetId: row.asset_id,
    costUsd: row.cost_usd,
  }));
}

/**
 * Loads EVERY video a target editor generated: takes and runs across all their
 * projects — the Create tab's hidden personal project, clip projects, and the
 * older scripted-pipeline projects made from the Projects page.
 * Must be called by a page that has already run `requireAdmin()`.
 */
export async function loadEditorVideos(userId: string): Promise<EditorVideosData> {
  const supabase = await createClient();

  const { data: projectRows, error: projectsError } = await supabase
    .from("projects")
    .select("id, title, is_personal, render_settings, kind")
    .eq("user_id", userId);
  if (projectsError) {
    throw new Error(`Failed to load editor clip projects: ${projectsError.message}`);
  }

  // Every kind that holds scenes. An image project has none, and the old
  // filter to "clip" alone is what hid everything made from the Projects page.
  const projects = (projectRows ?? []).filter((p) => p.kind !== "image");
  if (projects.length === 0) {
    return { clips: [], runs: [] };
  }

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const projectIds = projects.map((p) => p.id);
  const videoModels = [...new Set(KIE_MODELS.map((m) => m.kieModelName))];
  const withSound = isAudioEnabled();

  const [{ data: sceneRows, error: scenesError }, { data: runRows, error: runsError }] =
    await Promise.all([
      supabase
        .from("scenes")
        .select(
          "id, project_id, status, video_prompt, duration_s, active_version_id, created_at, is_talking_head, render_settings_override",
        )
        .in("project_id", projectIds)
        .order("created_at", { ascending: false })
        .limit(RECENT_SCENES),
      supabase
        .from("runs")
        .select("id, scene_id, model, prompt, cost_usd, error, created_at")
        .in("project_id", projectIds)
        .in("model", videoModels)
        .order("created_at", { ascending: false })
        .limit(RECENT_RUNS),
    ]);

  if (scenesError) throw new Error(`Failed to load editor scenes: ${scenesError.message}`);
  if (runsError) throw new Error(`Failed to load editor video runs: ${runsError.message}`);

  const scenes = sceneRows ?? [];
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const sceneIds = scenes.map((s) => s.id);

  const latestRunOfScene = new Set<string>();
  const latestCostBySceneId = new Map<string, number | null>();
  const runs: VideoRun[] = (runRows ?? []).map((run) => {
    const scene = run.scene_id ? sceneById.get(run.scene_id) : undefined;
    const latest = !!run.scene_id && !latestRunOfScene.has(run.scene_id);
    if (run.scene_id) {
      latestRunOfScene.add(run.scene_id);
      if (!latestCostBySceneId.has(run.scene_id) && run.cost_usd !== null) {
        latestCostBySceneId.set(run.scene_id, run.cost_usd);
      }
    }
    const project = scene ? projectById.get(scene.project_id) : undefined;
    return {
      id: run.id,
      createdAt: run.created_at,
      status: run.error ? "failed" : latest && scene?.status === "rendering" ? "rendering" : "done",
      modelLabel: KIE_MODELS.find((m) => m.kieModelName === run.model)?.label ?? run.model,
      prompt: run.prompt ?? scene?.video_prompt ?? "",
      costUsd: run.cost_usd,
      reason: run.error,
      returnedUsd:
        run.error && run.cost_usd === null && scene && project
          ? returnedEstimate(scene, project.render_settings, withSound)
          : null,
    };
  });

  const pendingRuns: VideoRun[] = scenes
    .filter(
      (scene) =>
        scene.status === "queued" ||
        (scene.status === "rendering" && !latestRunOfScene.has(scene.id)),
    )
    .map((scene) => ({
      id: `scene-${scene.id}`,
      createdAt: scene.created_at,
      status: scene.status === "queued" ? "queued" : "rendering",
      modelLabel: getModel(
        mergeRenderSettings(
          projectById.get(scene.project_id)?.render_settings,
          scene.render_settings_override,
        ).model,
      ).label,
      prompt: scene.video_prompt ?? "",
      costUsd: null,
      reason: null,
      returnedUsd: null,
    }));

  const { data: versionRows, error: versionsError } =
    sceneIds.length > 0
      ? await supabase
          .from("scene_versions")
          .select(
            "id, n, scene_id, clip_asset_id, video_prompt, duration_s, render_settings, created_at",
          )
          .in("scene_id", sceneIds)
      : { data: [], error: null };

  if (versionsError) {
    throw new Error(`Failed to load editor scene versions: ${versionsError.message}`);
  }

  const versions = (versionRows ?? []).filter((v) => v.clip_asset_id !== null);
  const takes = [...versions]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, WALL_TAKES);

  const { data: assetRows, error: assetsError } =
    takes.length > 0
      ? await supabase
          .from("assets")
          .select("id, storage_key")
          .in(
            "id",
            takes.map((v) => v.clip_asset_id!),
          )
      : { data: [], error: null };

  if (assetsError) throw new Error(`Failed to load editor clip assets: ${assetsError.message}`);
  const assetById = new Map((assetRows ?? []).map((a) => [a.id, a]));

  // SCENES WITH NO CLIP ON A VERSION ROW. Clips made before scene_versions
  // existed, and the scripted pipeline's, hang off assets.scene_id alone — the
  // same fallback /ugc uses (activeClipIdByScene). Without it they were listed
  // as "Done" attempts with no clip to play.
  const sceneIdsWithClipVersion = new Set(versions.map((v) => v.scene_id));
  const legacySceneIds = scenes.filter((s) => !sceneIdsWithClipVersion.has(s.id)).map((s) => s.id);
  const { data: legacyRows, error: legacyError } =
    legacySceneIds.length > 0
      ? await supabase
          .from("assets")
          .select("id, scene_id, storage_key, created_at")
          .eq("kind", "clip")
          .in("scene_id", legacySceneIds)
          .order("created_at", { ascending: false })
      : { data: [], error: null };
  if (legacyError) throw new Error(`Failed to load editor legacy clips: ${legacyError.message}`);
  const legacyBySceneId = new Map<string, NonNullable<typeof legacyRows>[number]>();
  for (const asset of legacyRows ?? []) {
    if (asset.scene_id && !legacyBySceneId.has(asset.scene_id)) {
      legacyBySceneId.set(asset.scene_id, asset);
    }
  }

  type Candidate = Omit<EditorVideoClip, "url"> & { storageKey: string };
  const candidates: Candidate[] = [];
  for (const version of takes) {
    const scene = sceneById.get(version.scene_id);
    const asset = assetById.get(version.clip_asset_id!);
    const project = scene ? projectById.get(scene.project_id) : undefined;
    if (!scene || !asset || !project) continue;

    const mergedModelId = mergeRenderSettings(
      project.render_settings,
      scene.render_settings_override,
    ).model;
    const used = snapshotModel(version.render_settings);
    const modelLabel = getModel(used.id ?? mergedModelId).label;

    candidates.push({
      key: version.id,
      sceneId: scene.id,
      versionId: version.id,
      n: version.n,
      projectId: project.id,
      projectTitle: project.title,
      personal: project.is_personal,
      prompt: version.video_prompt ?? scene.video_prompt ?? "",
      modelLabel,
      durationS: version.duration_s ?? scene.duration_s,
      createdAt: version.created_at,
      storageKey: asset.storage_key,
      costUsd: latestCostBySceneId.get(scene.id) ?? null,
    });
  }
  for (const [sceneId, asset] of legacyBySceneId) {
    const scene = sceneById.get(sceneId);
    const project = scene ? projectById.get(scene.project_id) : undefined;
    if (!scene || !project) continue;
    candidates.push({
      key: `legacy-${asset.id}`,
      sceneId: scene.id,
      versionId: asset.id,
      n: 1,
      projectId: project.id,
      projectTitle: project.title,
      personal: project.is_personal,
      prompt: scene.video_prompt ?? "",
      modelLabel: getModel(
        mergeRenderSettings(project.render_settings, scene.render_settings_override).model,
      ).label,
      durationS: scene.duration_s,
      createdAt: asset.created_at,
      storageKey: asset.storage_key,
      costUsd: latestCostBySceneId.get(scene.id) ?? null,
    });
  }

  // Newest first across both sources; sign only what is shown.
  const shown = candidates
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, WALL_TAKES);
  const clips: EditorVideoClip[] = await Promise.all(
    shown.map(async ({ storageKey, ...clip }) => ({
      ...clip,
      url: await signedUrl(storageKey),
    })),
  );

  return {
    clips,
    runs: [...pendingRuns, ...runs],
  };
}

/**
 * Loads a target editor's deleted scenes, deleted scene versions (both binned
 * and purged archives), and binned personal generated images.
 * Must be called by a page that has already run `requireAdmin()`.
 */
export async function loadEditorDeleted(userId: string): Promise<EditorDeletedData> {
  const supabase = await createClient();

  const [
    { data: deletedSceneRows, error: deletedScenesError },
    { data: deletedVersionRows, error: deletedVersionsError },
    { data: deletedImageRows, error: deletedImagesError },
  ] = await Promise.all([
    supabase
      .from("deleted_scenes")
      .select(
        "scene_id, project_id, user_id, scene_idx, deleted_at, hard_deleted_at, scene, assets, versions",
      )
      .eq("user_id", userId)
      .order("deleted_at", { ascending: false }),
    supabase
      .from("deleted_scene_versions")
      .select(
        "version_id, scene_id, project_id, user_id, n, deleted_at, hard_deleted_at, version, clip_asset",
      )
      .eq("user_id", userId)
      .order("deleted_at", { ascending: false }),
    supabase
      .from("assets")
      .select("id, storage_key, created_at, deleted_at")
      .eq("user_id", userId)
      .is("project_id", null)
      .eq("kind", "generated_image")
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }),
  ]);

  if (deletedScenesError) {
    throw new Error(`Failed to load deleted scenes: ${deletedScenesError.message}`);
  }
  if (deletedVersionsError) {
    throw new Error(`Failed to load deleted scene versions: ${deletedVersionsError.message}`);
  }
  if (deletedImagesError) {
    throw new Error(`Failed to load deleted images: ${deletedImagesError.message}`);
  }

  const sceneRows = deletedSceneRows ?? [];
  const versionRows = deletedVersionRows ?? [];
  const imageRows = deletedImageRows ?? [];

  const projectIds = Array.from(
    new Set(
      [...sceneRows.map((r) => r.project_id), ...versionRows.map((r) => r.project_id)].filter(
        (id): id is string => id !== null,
      ),
    ),
  );
  const projectSettingsById = new Map<string, unknown>();
  if (projectIds.length > 0) {
    const { data: projectRows } = await supabase
      .from("projects")
      .select("id, render_settings")
      .eq("user_id", userId)
      .in("id", projectIds);
    for (const row of projectRows ?? []) {
      projectSettingsById.set(row.id, row.render_settings);
    }
  }

  const runByAssetId = new Map<
    string,
    { prompt: string | null; model: string; cost_usd: number | null }
  >();
  if (imageRows.length > 0) {
    const { data: runRows } = await supabase
      .from("runs")
      .select("asset_id, prompt, model, cost_usd")
      .eq("user_id", userId)
      .is("project_id", null)
      .in(
        "asset_id",
        imageRows.map((img) => img.id),
      );
    for (const run of runRows ?? []) {
      if (run.asset_id && !runByAssetId.has(run.asset_id)) {
        runByAssetId.set(run.asset_id, run);
      }
    }
  }

  const preparedScenes = sceneRows.map((row) => {
    const archivedScene = row.scene as {
      video_prompt?: string | null;
      render_settings_override?: unknown;
    } | null;
    const archivedVersions = Array.isArray(row.versions) ? row.versions : [];
    const merged = mergeRenderSettings(
      row.project_id ? projectSettingsById.get(row.project_id) : null,
      archivedScene?.render_settings_override,
    );
    return {
      sceneId: row.scene_id,
      projectId: row.project_id,
      idx: row.scene_idx,
      prompt: firstLine(archivedScene?.video_prompt),
      modelLabel: getModel(merged.model).label,
      deletedAt: row.deleted_at,
      purged: row.hard_deleted_at !== null,
      versionCount: archivedVersions.length,
      source: pickSceneThumbnailSource(row.assets),
    };
  });

  const preparedVersions = versionRows.map((row) => {
    const archivedVersion = row.version as {
      video_prompt?: string | null;
      render_settings?: unknown;
    } | null;
    const used = snapshotModel(archivedVersion?.render_settings);
    const known = used.id ? getModel(used.id) : null;
    return {
      versionId: row.version_id,
      sceneId: row.scene_id,
      projectId: row.project_id,
      n: row.n,
      prompt: firstLine(archivedVersion?.video_prompt),
      modelLabel: known && known.id === used.id ? known.label : null,
      deletedAt: row.deleted_at,
      purged: row.hard_deleted_at !== null,
      source: versionClipThumbnailSource(row.clip_asset),
    };
  });

  const thumbnailUrlByKey = new Map<string, string>();
  await Promise.all([
    ...[
      ...preparedScenes.map((scene) => ({
        key: `scene:${scene.sceneId}`,
        source: scene.source,
      })),
      ...preparedVersions.map((version) => ({
        key: `version:${version.versionId}`,
        source: version.source,
      })),
    ]
      .filter((entry): entry is { key: string; source: ThumbnailSource } => entry.source !== null)
      .map(async ({ key, source }) => {
        try {
          const url =
            source.kind === "image"
              ? await signedUrl(source.storageKey, SIGNED_URL_TTL_SECONDS, { quality: 80 })
              : await signedUrl(source.storageKey, SIGNED_URL_TTL_SECONDS);
          thumbnailUrlByKey.set(key, url);
        } catch (err) {
          console.error(
            `admin-creations: could not sign thumbnail for ${key} (${source.storageKey})`,
            err,
          );
        }
      }),
    ...imageRows.map(async (row) => {
      try {
        const url = await signedUrl(row.storage_key, SIGNED_URL_TTL_SECONDS, {
          width: 320,
          quality: 80,
        });
        thumbnailUrlByKey.set(`image:${row.id}`, url);
      } catch (err) {
        console.error(
          `admin-creations: could not sign deleted image thumbnail for ${row.id} (${row.storage_key})`,
          err,
        );
      }
    }),
  ]);

  function resolveThumbnail(key: string, source: ThumbnailSource | null): BinCardThumbnail {
    if (!source) return { kind: "placeholder" };
    const url = thumbnailUrlByKey.get(key);
    return url ? { kind: source.kind, url } : { kind: "placeholder" };
  }

  return {
    scenes: preparedScenes.map(({ source, ...scene }) => ({
      ...scene,
      thumbnail: resolveThumbnail(`scene:${scene.sceneId}`, source),
    })),
    versions: preparedVersions.map(({ source, ...version }) => ({
      ...version,
      thumbnail: resolveThumbnail(`version:${version.versionId}`, source),
    })),
    images: imageRows.map((row) => {
      const run = runByAssetId.get(row.id);
      const url = thumbnailUrlByKey.get(`image:${row.id}`);
      return {
        assetId: row.id,
        createdAt: row.created_at,
        deletedAt: row.deleted_at ?? row.created_at,
        prompt: run?.prompt ?? null,
        modelLabel: run ? resolveImageModelLabel(run.model) : null,
        costUsd: run?.cost_usd ?? null,
        thumbnail: url ? { kind: "image", url } : { kind: "placeholder" },
      };
    }),
  };
}
