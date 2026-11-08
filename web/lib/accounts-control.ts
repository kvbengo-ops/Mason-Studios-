import {
  binExpiryLabel,
  binRetentionCutoffIso,
  pickSceneClipSource,
  pickSceneThumbnailSource,
  versionClipThumbnailSource,
  type SceneClipSource,
  type ThumbnailSource,
} from "@/lib/bin-thumbnails";
import type { BinCardThumbnail } from "@/components/bin-card";
import { addUtcDays, addUtcMonths, startOfUtcDay, startOfUtcMonth } from "@/lib/date-range";
import {
  getSpendCategoryTotals,
  getSpendCategoryTotalsByUser,
  getSpendTotalUsd,
  type SpendCategoryTotals,
  type UserSpendCategoryTotal,
} from "@/lib/db-aggregates";
import { getBytePlusBalanceUsd } from "@/lib/byteplus-balance";
import { getKieAccountBalanceUsd } from "@/lib/kie-balance";
import { KIE_MODELS } from "@/lib/kie/models";
import { COMPILER_MODELS, getModel, IMAGE_MODELS, mergeRenderSettings } from "@/lib/models";
import { computeRunway, RUNWAY_WINDOW_DAYS, type RunwayEstimate } from "@/lib/runway";
import { getGlobalSpendSnapshot, type GlobalSpendCapSettings } from "@/lib/spend";
import { extFromFilename, signedUrl } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";
import type { ProfileRole, ProfileStatus } from "@/types/db";

const SIGNED_URL_TTL_SECONDS = 3600;

export type AccountsControlWindowDays = 7 | 14 | 30;

export interface DailySpendPoint {
  date: string;
  label: string;
  renderUsd: number;
  iterateUsd: number;
  totalUsd: number;
}

export interface AccountControlDirectoryRow {
  id: string;
  email: string;
  username: string;
  role: ProfileRole;
  status: ProfileStatus;
  created_at: string;
  project_count: number;
  spend_usd: number;
}

export interface AccountSpendSummary {
  id: string;
  email: string;
  username: string;
  role: ProfileRole;
  status: ProfileStatus;
  projectCount: number;
  rangeRenderUsd: number;
  rangeIterateUsd: number;
  rangeTotalUsd: number;
  allTimeSpendUsd: number;
}

export interface AccountsControlOverview {
  windowDays: AccountsControlWindowDays;
  todaySpendUsd: number;
  teamGlobalSpendUsd: number;
  globalSpendCap: GlobalSpendCapSettings;
  weekSpendUsd: number;
  monthSpendUsd: number;
  kieBalanceUsd: number | null;
  /** BytePlus ModelArk render spend in the selected window, from runs.vendor. */
  bytePlusRangeUsd: number;
  /** BytePlus available balance (lib/byteplus-balance.ts); null = unreadable, never 0. */
  bytePlusBalanceUsd: number | null;
  runwayEstimate: RunwayEstimate;
  rangeCategoryTotals: SpendCategoryTotals;
  dailySeries: DailySpendPoint[];
  modelUsage: ModelUsage[];
  accounts: AccountSpendSummary[];
}

export interface ModelUsage {
  label: string;
  runs: number;
  costUsd: number;
}

export interface AccountControlDeletedScene {
  sceneId: string;
  projectId: string | null;
  idx: number | null;
  prompt: string;
  modelLabel: string | null;
  deletedAt: string;
  expiresLabel: string | null;
  versionCount: number;
  thumbnail: BinCardThumbnail;
  downloadUrl: string | null;
  downloadFilename: string | null;
}

export interface AccountControlDeletedVersion {
  versionId: string;
  sceneId: string | null;
  projectId: string | null;
  n: number | null;
  prompt: string;
  modelLabel: string | null;
  deletedAt: string;
  expiresLabel: string | null;
  thumbnail: BinCardThumbnail;
  downloadUrl: string | null;
  downloadFilename: string | null;
}

export interface AccountControlDeletedImage {
  assetId: string;
  createdAt: string;
  deletedAt: string;
  prompt: string | null;
  modelLabel: string | null;
  costUsd: number | null;
  thumbnail: BinCardThumbnail;
  downloadUrl: string | null;
  downloadFilename: string | null;
}

export interface AccountControlDeletedData {
  scenes: AccountControlDeletedScene[];
  versions: AccountControlDeletedVersion[];
  images: AccountControlDeletedImage[];
}

const shortDayFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function toUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Aggregates raw `runs` rows into a contiguous daily series of length
 * `windowDays` ending on `now` (UTC), split between video rendering
 * (`scene_id !== null`) and image/iterating (`scene_id === null`).
 */
export function buildDailySpendSeries(
  runs: readonly {
    created_at: string;
    cost_usd: number | null;
    scene_id: string | null;
  }[],
  windowDays: AccountsControlWindowDays,
  now: Date = new Date(),
): DailySpendPoint[] {
  const todayUtc = startOfUtcDay(now);
  const startUtc = addUtcDays(todayUtc, -(windowDays - 1));

  const byDate = new Map<string, DailySpendPoint>();
  for (let i = 0; i < windowDays; i++) {
    const day = addUtcDays(startUtc, i);
    const key = toUtcDateKey(day);
    byDate.set(key, {
      date: key,
      label: shortDayFormatter.format(day),
      renderUsd: 0,
      iterateUsd: 0,
      totalUsd: 0,
    });
  }

  for (const run of runs) {
    if (typeof run.cost_usd !== "number" || run.cost_usd <= 0) continue;
    const key = run.created_at.slice(0, 10);
    const point = byDate.get(key);
    if (!point) continue;
    if (run.scene_id !== null) {
      point.renderUsd += run.cost_usd;
    } else {
      point.iterateUsd += run.cost_usd;
    }
    point.totalUsd = point.renderUsd + point.iterateUsd;
  }

  return Array.from(byDate.values());
}

/**
 * A display name for `runs.model`, which holds whatever each writer sent:
 * kie's wire name for worker renders, a kie image id for personal images, an
 * Anthropic id for compiles. Not getModel() — it falls back to Seedance 2.5
 * and would credit every unknown model to it. Unknown ids show as-is.
 */
export function runModelLabel(model: string): string {
  return (
    KIE_MODELS.find((m) => m.id === model || m.kieModelName === model)?.label ??
    IMAGE_MODELS.find((m) => m.id === model || m.textToImageId === model || m.editId === model)
      ?.label ??
    COMPILER_MODELS.find((m) => m.id === model)?.label ??
    model
  );
}

/** Billed runs per model in the window, most-used first, then by spend. */
export function buildModelUsage(
  runs: readonly { model: string; cost_usd: number | null; vendor?: string }[],
): ModelUsage[] {
  const byLabel = new Map<string, ModelUsage>();
  for (const run of runs) {
    // BytePlus and kie share Seedance 2.5's wire id; runs.vendor tells them apart.
    const label = runModelLabel(run.model) + (run.vendor === "byteplus" ? " · BytePlus" : "");
    const usage = byLabel.get(label) ?? { label, runs: 0, costUsd: 0 };
    usage.runs += 1;
    usage.costUsd += run.cost_usd ?? 0;
    byLabel.set(label, usage);
  }
  return Array.from(byLabel.values()).sort((a, b) => b.runs - a.runs || b.costUsd - a.costUsd);
}

/**
 * Merges `user_directory` rows with per-user spend category totals for the
 * selected date window and sorts accounts by window spend (highest first),
 * then all-time spend.
 */
export function mergeAccountSpendRanking(
  directoryRows: readonly AccountControlDirectoryRow[],
  rangeTotals: readonly UserSpendCategoryTotal[],
): AccountSpendSummary[] {
  const rangeByUserId = new Map(rangeTotals.map((row) => [row.userId, row]));

  return directoryRows
    .filter((row) => row.role === "admin" || row.role === "editor" || row.role === "trusted_editor")
    .map((row) => {
      const range = rangeByUserId.get(row.id);
      return {
        id: row.id,
        email: row.email,
        username: row.username,
        role: row.role,
        status: row.status,
        projectCount: row.project_count,
        rangeRenderUsd: range?.renderUsd ?? 0,
        rangeIterateUsd: range?.iterateUsd ?? 0,
        rangeTotalUsd: range?.totalUsd ?? 0,
        allTimeSpendUsd: row.spend_usd,
      };
    })
    .sort((a, b) => {
      if (b.rangeTotalUsd !== a.rangeTotalUsd) return b.rangeTotalUsd - a.rangeTotalUsd;
      if (b.allTimeSpendUsd !== a.allTimeSpendUsd) return b.allTimeSpendUsd - a.allTimeSpendUsd;
      return a.username.localeCompare(b.username);
    });
}

export function parseWindowDays(raw: string | string[] | undefined): AccountsControlWindowDays {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "7") return 7;
  if (value === "30") return 30;
  return 14;
}

/**
 * Loads the top-level spending KPIs, daily credit trend series, and per-account
 * credit ranking for `/accounts-control`. Must be called after `requireAdmin()`.
 */
export async function loadAccountsControlOverview(
  windowDays: AccountsControlWindowDays = 14,
  now: Date = new Date(),
): Promise<AccountsControlOverview> {
  const supabase = await createClient();

  const todayStart = startOfUtcDay(now);
  const tomorrowStart = addUtcDays(todayStart, 1);
  const monthStart = startOfUtcMonth(now);
  const nextMonthStart = addUtcMonths(monthStart, 1);
  const windowStart = addUtcDays(todayStart, -(windowDays - 1));
  const runwayWindowStart = new Date(now.getTime() - RUNWAY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [
    todaySpendUsd,
    globalSpendSnapshot,
    weekSpendUsd,
    monthSpendUsd,
    rangeCategoryTotals,
    userCategoryTotals,
    kieBalanceUsd,
    bytePlusBalanceUsd,
    { data: directoryData, error: directoryError },
  ] = await Promise.all([
    getSpendTotalUsd(supabase, todayStart.toISOString(), tomorrowStart.toISOString()),
    getGlobalSpendSnapshot(now),
    getSpendTotalUsd(supabase, runwayWindowStart.toISOString(), now.toISOString()),
    getSpendTotalUsd(supabase, monthStart.toISOString(), nextMonthStart.toISOString()),
    getSpendCategoryTotals(supabase, windowStart.toISOString(), tomorrowStart.toISOString()),
    getSpendCategoryTotalsByUser(supabase, windowStart.toISOString(), tomorrowStart.toISOString()),
    getKieAccountBalanceUsd(),
    getBytePlusBalanceUsd(),
    supabase
      .from("user_directory")
      .select("id, email, username, role, status, created_at, project_count, spend_usd")
      .in("role", ["admin", "editor", "trusted_editor"])
      .order("spend_usd", { ascending: false }),
  ]);

  if (directoryError) {
    throw new Error(`Failed to load accounts for Accounts Control: ${directoryError.message}`);
  }

  // Paged fetch of runs in [windowStart, tomorrowStart) so PostgREST's
  // max_rows = 1000 never truncates the daily chart series.
  const PAGE = 1000;
  const windowRuns: {
    created_at: string;
    cost_usd: number | null;
    scene_id: string | null;
    model: string;
    vendor: string;
  }[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data: runBatch, error: runsError } = await supabase
      .from("runs")
      .select("created_at, cost_usd, scene_id, model, vendor")
      .gte("created_at", windowStart.toISOString())
      .lt("created_at", tomorrowStart.toISOString())
      .not("cost_usd", "is", null)
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (runsError) {
      throw new Error(`Failed to load daily run series: ${runsError.message}`);
    }
    const rows = runBatch ?? [];
    windowRuns.push(...rows);
    if (rows.length < PAGE) break;
  }

  const dailySeries = buildDailySpendSeries(windowRuns, windowDays, now);
  const accounts = mergeAccountSpendRanking(
    (directoryData ?? []) as AccountControlDirectoryRow[],
    userCategoryTotals,
  );
  const runwayEstimate = computeRunway(kieBalanceUsd, weekSpendUsd);

  return {
    windowDays,
    todaySpendUsd,
    teamGlobalSpendUsd: globalSpendSnapshot.spentUsd,
    globalSpendCap: globalSpendSnapshot.settings,
    weekSpendUsd,
    monthSpendUsd,
    kieBalanceUsd,
    bytePlusRangeUsd: windowRuns
      .filter((run) => run.vendor === "byteplus")
      .reduce((sum, run) => sum + (run.cost_usd ?? 0), 0),
    bytePlusBalanceUsd,
    runwayEstimate,
    rangeCategoryTotals,
    dailySeries,
    modelUsage: buildModelUsage(windowRuns),
    accounts,
  };
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

function firstLine(text: string | null | undefined): string {
  const line = text?.split("\n")[0]?.trim();
  return line ? line : "(no prompt)";
}

export interface AccountsRunLogRow {
  id: string;
  userId: string | null;
  model: string;
  /** runs.vendor as a person reads it: "kie", "BytePlus". */
  provider: string;
  costUsd: number | null;
  error: string | null;
  thumbnail: BinCardThumbnail;
}

export function providerLabel(vendor: string): string {
  return vendor === "byteplus" ? "BytePlus" : vendor;
}

/**
 * Where a run's output lives. An image run names its picture (runs.asset_id).
 * A video run has no such column, but worker store.MarkDone inserts the clip
 * and the run in ONE transaction, so the clip shares the run's scene_id and
 * created_at (now() is fixed per transaction) — an exact match, not a guess.
 */
export function runPreviewSource(
  run: { asset_id: string | null; scene_id: string | null; created_at: string },
  imageKeyByAssetId: ReadonlyMap<string, string>,
  clipKeyBySceneAndTime: ReadonlyMap<string, string>,
): { kind: "image" | "video"; storageKey: string } | null {
  if (run.asset_id) {
    const key = imageKeyByAssetId.get(run.asset_id);
    return key ? { kind: "image", storageKey: key } : null;
  }
  if (run.scene_id) {
    const key = clipKeyBySceneAndTime.get(sceneTimeKey(run.scene_id, run.created_at));
    return key ? { kind: "video", storageKey: key } : null;
  }
  return null;
}

export function sceneTimeKey(sceneId: string, createdAt: string): string {
  return `${sceneId}|${new Date(createdAt).getTime()}`;
}

/**
 * One page of every run in the same `windowDays` window as the overview — the
 * log that used to live on /spend behind its own date picker. `projects` is
 * embedded off runs.project_id (not through scenes) so a scene-less run still
 * resolves its owner. Each row carries its provider and a preview of what it
 * made; a preview that cannot be found or signed is a placeholder, never an
 * error, because the run log matters more than its pictures.
 */
export async function loadAccountsRunLog(
  windowDays: AccountsControlWindowDays,
  range: { from: number; to: number },
  now: Date = new Date(),
): Promise<{ rows: AccountsRunLogRow[]; total: number }> {
  const supabase = await createClient();
  const tomorrowStart = addUtcDays(startOfUtcDay(now), 1);
  const windowStart = addUtcDays(startOfUtcDay(now), -(windowDays - 1));
  const { data, error, count } = await supabase
    .from("runs")
    .select(
      "id, model, vendor, cost_usd, error, created_at, scene_id, asset_id, user_id, projects ( user_id )",
      { count: "exact" },
    )
    .gte("created_at", windowStart.toISOString())
    .lt("created_at", tomorrowStart.toISOString())
    .order("created_at", { ascending: false })
    .range(range.from, range.to);
  if (error) throw new Error(`Failed to load runs: ${error.message}`);
  const rows = (data ?? []) as unknown as {
    id: string;
    model: string;
    vendor: string;
    cost_usd: number | null;
    error: string | null;
    created_at: string;
    scene_id: string | null;
    asset_id: string | null;
    user_id: string | null;
    projects: { user_id: string } | null;
  }[];

  const assetIds = [...new Set(rows.flatMap((run) => (run.asset_id ? [run.asset_id] : [])))];
  const videoRuns = rows.filter((run) => !run.asset_id && run.scene_id && run.cost_usd !== null);
  const sceneIds = [...new Set(videoRuns.map((run) => run.scene_id!))];
  const times = videoRuns.map((run) => run.created_at).sort();

  const [images, clips] = await Promise.all([
    assetIds.length > 0
      ? supabase.from("assets").select("id, storage_key").in("id", assetIds)
      : null,
    sceneIds.length > 0
      ? supabase
          .from("assets")
          .select("scene_id, created_at, storage_key")
          .eq("kind", "clip")
          .in("scene_id", sceneIds)
          .gte("created_at", times[0]!)
          .lte("created_at", times[times.length - 1]!)
      : null,
  ]);
  if (images?.error) console.error(`loadAccountsRunLog: image previews: ${images.error.message}`);
  if (clips?.error) console.error(`loadAccountsRunLog: clip previews: ${clips.error.message}`);
  const imageKeyByAssetId = new Map(
    (images?.data ?? []).map((asset) => [asset.id, asset.storage_key] as const),
  );
  const clipKeyBySceneAndTime = new Map(
    (clips?.data ?? []).flatMap((asset) =>
      asset.scene_id
        ? [[sceneTimeKey(asset.scene_id, asset.created_at), asset.storage_key] as const]
        : [],
    ),
  );

  const thumbnails = await Promise.all(
    rows.map(async (run): Promise<BinCardThumbnail> => {
      const source = runPreviewSource(run, imageKeyByAssetId, clipKeyBySceneAndTime);
      if (!source) return { kind: "placeholder" };
      try {
        return source.kind === "image"
          ? {
              kind: "image",
              url: await signedUrl(source.storageKey, SIGNED_URL_TTL_SECONDS, { quality: 80 }),
            }
          : { kind: "video", url: await signedUrl(source.storageKey, SIGNED_URL_TTL_SECONDS) };
      } catch (err) {
        console.error(`loadAccountsRunLog: could not sign preview for run ${run.id}`, err);
        return { kind: "placeholder" };
      }
    }),
  );

  return {
    rows: rows.map((run, i) => ({
      id: run.id,
      userId: run.user_id ?? run.projects?.user_id ?? null,
      model: run.model,
      provider: providerLabel(run.vendor),
      costUsd: run.cost_usd,
      error: run.error,
      thumbnail: thumbnails[i]!,
    })),
    total: count ?? 0,
  };
}

/**
 * Loads a target account's active 2-week Bin entries (deleted scenes, deleted
 * takes, and binned personal images) with playable video clip URLs, download
 * URLs, and 2-week expiry labels for `/accounts-control`.
 */
export async function loadAccountControlDeleted(
  userId: string,
  nowMs: number = Date.now(),
): Promise<AccountControlDeletedData> {
  const supabase = await createClient();
  const cutoffIso = binRetentionCutoffIso(nowMs);

  const [
    { data: deletedSceneRows, error: deletedScenesError },
    { data: deletedVersionRows, error: deletedVersionsError },
    { data: deletedImageRows, error: deletedImagesError },
  ] = await Promise.all([
    supabase
      .from("deleted_scenes")
      .select("scene_id, project_id, user_id, scene_idx, deleted_at, scene, assets, versions")
      .eq("user_id", userId)
      .is("hard_deleted_at", null)
      .gte("deleted_at", cutoffIso)
      .order("deleted_at", { ascending: false }),
    supabase
      .from("deleted_scene_versions")
      .select("version_id, scene_id, project_id, user_id, n, deleted_at, version, clip_asset")
      .eq("user_id", userId)
      .is("hard_deleted_at", null)
      .gte("deleted_at", cutoffIso)
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
    const clipSource = pickSceneClipSource(row.assets);
    return {
      sceneId: row.scene_id,
      projectId: row.project_id,
      idx: row.scene_idx,
      prompt: firstLine(archivedScene?.video_prompt),
      modelLabel: getModel(merged.model).label,
      deletedAt: row.deleted_at,
      expiresLabel: binExpiryLabel(row.deleted_at, nowMs),
      versionCount: archivedVersions.length,
      clipSource,
      fallbackSource: clipSource ? null : pickSceneThumbnailSource(row.assets),
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
      expiresLabel: binExpiryLabel(row.deleted_at, nowMs),
      source: versionClipThumbnailSource(row.clip_asset),
    };
  });

  const signedUrlByKey = new Map<string, string>();
  const signTasks: { key: string; source: ThumbnailSource }[] = [];

  for (const scene of preparedScenes) {
    if (scene.clipSource) {
      signTasks.push({
        key: `scene-clip:${scene.sceneId}`,
        source: { kind: "video", storageKey: scene.clipSource.clipStorageKey },
      });
      if (scene.clipSource.posterStorageKey) {
        signTasks.push({
          key: `scene-poster:${scene.sceneId}`,
          source: { kind: "image", storageKey: scene.clipSource.posterStorageKey },
        });
      }
    } else if (scene.fallbackSource) {
      signTasks.push({
        key: `scene:${scene.sceneId}`,
        source: scene.fallbackSource,
      });
    }
  }
  for (const version of preparedVersions) {
    if (version.source) {
      signTasks.push({
        key: `version:${version.versionId}`,
        source: version.source,
      });
    }
  }

  await Promise.all([
    ...signTasks.map(async ({ key, source }) => {
      try {
        const url =
          source.kind === "image"
            ? await signedUrl(source.storageKey, SIGNED_URL_TTL_SECONDS, { quality: 80 })
            : await signedUrl(source.storageKey, SIGNED_URL_TTL_SECONDS);
        signedUrlByKey.set(key, url);
      } catch (err) {
        console.error(
          `accounts-control: could not sign media for ${key} (${source.storageKey})`,
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
        signedUrlByKey.set(`image:${row.id}`, url);
      } catch (err) {
        console.error(
          `accounts-control: could not sign deleted image for ${row.id} (${row.storage_key})`,
          err,
        );
      }
    }),
  ]);

  function resolveSceneMedia(scene: {
    sceneId: string;
    idx: number | null;
    clipSource: SceneClipSource | null;
    fallbackSource: ThumbnailSource | null;
  }): {
    thumbnail: BinCardThumbnail;
    downloadUrl: string | null;
    downloadFilename: string | null;
  } {
    const num = scene.idx === null ? scene.sceneId.slice(0, 8) : String(scene.idx).padStart(2, "0");
    if (scene.clipSource) {
      const clipUrl = signedUrlByKey.get(`scene-clip:${scene.sceneId}`);
      const posterUrl = signedUrlByKey.get(`scene-poster:${scene.sceneId}`) ?? null;
      if (clipUrl) {
        const ext = extFromFilename(scene.clipSource.clipStorageKey, "mp4");
        return {
          thumbnail: { kind: "video", url: clipUrl, posterUrl },
          downloadUrl: clipUrl,
          downloadFilename: `deleted-scene-${num}.${ext}`,
        };
      }
      if (posterUrl) {
        const ext = scene.clipSource.posterStorageKey
          ? extFromFilename(scene.clipSource.posterStorageKey, "jpg")
          : "jpg";
        return {
          thumbnail: { kind: "image", url: posterUrl },
          downloadUrl: posterUrl,
          downloadFilename: `deleted-scene-${num}.${ext}`,
        };
      }
      return { thumbnail: { kind: "placeholder" }, downloadUrl: null, downloadFilename: null };
    }
    if (!scene.fallbackSource) {
      return { thumbnail: { kind: "placeholder" }, downloadUrl: null, downloadFilename: null };
    }
    const url = signedUrlByKey.get(`scene:${scene.sceneId}`);
    if (!url) {
      return { thumbnail: { kind: "placeholder" }, downloadUrl: null, downloadFilename: null };
    }
    const ext = extFromFilename(
      scene.fallbackSource.storageKey,
      scene.fallbackSource.kind === "video" ? "mp4" : "jpg",
    );
    return {
      thumbnail: { kind: scene.fallbackSource.kind, url },
      downloadUrl: url,
      downloadFilename: `deleted-scene-${num}.${ext}`,
    };
  }

  return {
    scenes: preparedScenes.map(({ clipSource, fallbackSource, ...scene }) => {
      const media = resolveSceneMedia({
        sceneId: scene.sceneId,
        idx: scene.idx,
        clipSource,
        fallbackSource,
      });
      return {
        ...scene,
        thumbnail: media.thumbnail,
        downloadUrl: media.downloadUrl,
        downloadFilename: media.downloadFilename,
      };
    }),
    versions: preparedVersions.map(({ source, ...version }) => {
      const url = source ? signedUrlByKey.get(`version:${version.versionId}`) : undefined;
      const ext = source ? extFromFilename(source.storageKey, "mp4") : "mp4";
      const num = version.n === null ? version.versionId.slice(0, 8) : `v${version.n}`;
      return {
        ...version,
        thumbnail: source && url ? { kind: source.kind, url } : { kind: "placeholder" },
        downloadUrl: url ?? null,
        downloadFilename: url ? `deleted-version-${num}.${ext}` : null,
      };
    }),
    images: imageRows.map((row) => {
      const run = runByAssetId.get(row.id);
      const url = signedUrlByKey.get(`image:${row.id}`);
      const ext = extFromFilename(row.storage_key, "jpg");
      return {
        assetId: row.id,
        createdAt: row.created_at,
        deletedAt: row.deleted_at ?? row.created_at,
        prompt: run?.prompt ?? null,
        modelLabel: run ? resolveImageModelLabel(run.model) : null,
        costUsd: run?.cost_usd ?? null,
        thumbnail: url ? { kind: "image", url } : { kind: "placeholder" },
        downloadUrl: url ?? null,
        downloadFilename: url ? `deleted-image-${row.id.slice(0, 8)}.${ext}` : null,
      };
    }),
  };
}
