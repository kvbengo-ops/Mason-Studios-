import { BULK_ALLOWANCE_SCOPE_ROLES } from "@/lib/allowance";
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
import {
  SPEND_DAY_SHIFT_MS,
  manilaDayKey,
  manilaDayKeys,
  manilaWindowStartIso as manilaMidnightWindowStartIso,
} from "@/lib/burn";

// A spend day runs 05:00 to 05:00 Manila (0138), the same boundary the caps and
// the "Today" tile use, so the chart's last bar equals "Today".
const spendDayKey = (instant: Date): string =>
  manilaDayKey(new Date(instant.getTime() - SPEND_DAY_SHIFT_MS));
const spendDayKeys = (now: Date, days: number): string[] =>
  manilaDayKeys(new Date(now.getTime() - SPEND_DAY_SHIFT_MS), days);
/** 05:00 Manila on the first of the last `days` spend days. */
export function manilaWindowStartIso(now: Date, days: number): string {
  const midnight = manilaMidnightWindowStartIso(new Date(now.getTime() - SPEND_DAY_SHIFT_MS), days);
  return new Date(Date.parse(midnight) + SPEND_DAY_SHIFT_MS).toISOString();
}
import {
  getSpendCategoryTotals,
  getSpendCategoryTotalsByUser,
  getSpendTotalUsd,
  getUserSpendUsd,
  type SpendCategoryTotals,
  type UserSpendCategoryTotal,
} from "@/lib/db-aggregates";
import { getBytePlusBalanceUsd } from "@/lib/byteplus-balance";
import { getKieAccountBalanceUsd } from "@/lib/kie-balance";
import { KIE_MODELS } from "@/lib/kie/models";
import { COMPILER_MODELS, getModel, imageModelLabelFor, mergeRenderSettings } from "@/lib/models";
import { computeRunway, RUNWAY_WINDOW_DAYS, type RunwayEstimate } from "@/lib/runway";
import {
  getGlobalSpendSnapshot,
  endOfManilaDayIso,
  startOfManilaDayIso,
  startOfManilaMonthIso,
  type GlobalSpendCapSettings,
} from "@/lib/spend";
import { extFromFilename, signedUrl, getImageUrl } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";
import type { ProfileRole, ProfileStatus } from "@/types/db";

const SIGNED_URL_TTL_SECONDS = 3600;

export type AccountsControlWindowDays = 7 | 14 | 30;

/** The Spend chart's bucket size: last 24 hours, the page window, or last 12 months. */
export type SpendGranularity = "hourly" | "daily" | "monthly";

export function parseSpendGranularity(value: string | string[] | undefined): SpendGranularity {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "hourly" || raw === "monthly" ? raw : "daily";
}

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
  last_seen_at: string | null;
  avatar_storage_key: string | null;
}

export interface AccountSpendSummary {
  id: string;
  email: string;
  username: string;
  role: ProfileRole;
  status: ProfileStatus;
  /** profiles.last_seen_at (0130), the presence heartbeat. */
  lastSeenAt?: string | null;
  /** profiles.avatar_storage_key, signed by the page for the rows it shows. */
  avatarStorageKey?: string | null;
  /** Billed runs in the window (runs table only; deleted projects' archive has no rows to count). */
  rangeRunCount?: number;
  rangeRenderUsd: number;
  rangeIterateUsd: number;
  rangeTotalUsd: number;
}

export interface AccountsControlOverview {
  windowDays: AccountsControlWindowDays;
  todaySpendUsd: number;
  /** Yesterday from the 05:00 Manila reset up to this time: today's like-for-like comparison. */
  yesterdaySameTimeUsd: number;
  /** Last month over the same elapsed span as this month so far. */
  lastMonthSameSpanUsd: number;
  /** The `windowDays` before the current window. */
  previousWindowUsd: number;
  /** Every runs row (attempt) since the 05:00 Manila reset, billed or not. */
  rendersToday: number | null;
  /** Mean cost of the billed (cost > 0) runs in the window; null when there were none. */
  avgCostPerRenderUsd: number | null;
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
  /** The last 24 Manila hours, from the same window read as dailySeries. */
  hourlySeries: DailySpendPoint[];
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

/**
 * Aggregates raw `runs` rows into a contiguous daily series of length
 * `windowDays` ending on `now`, one bucket per Asia/Manila calendar day
 * (rather than spend-cap periods), split between video rendering
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
  const byDate = new Map<string, DailySpendPoint>();
  for (const key of spendDayKeys(now, windowDays)) {
    byDate.set(key, {
      date: key,
      label: shortDayFormatter.format(new Date(`${key}T00:00:00Z`)),
      renderUsd: 0,
      iterateUsd: 0,
      totalUsd: 0,
    });
  }

  for (const run of runs) {
    if (typeof run.cost_usd !== "number" || run.cost_usd <= 0) continue;
    const point = byDate.get(spendDayKey(new Date(run.created_at)));
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

const HOUR_MS = 60 * 60 * 1000;
// Asia/Manila has no daylight saving, so a fixed +8h offset is exact.
const MANILA_OFFSET_MS = 8 * HOUR_MS;

const hourLabelFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  timeZone: "UTC",
});

/**
 * The last 24 Asia/Manila clock hours ending with the current one, split the
 * same way as buildDailySpendSeries. Each point's date is the Manila hour as
 * "YYYY-MM-DDTHH" and its label "3 PM".
 */
export function buildHourlySpendSeries(
  runs: readonly {
    created_at: string;
    cost_usd: number | null;
    scene_id: string | null;
  }[],
  now: Date = new Date(),
): DailySpendPoint[] {
  const hourIndex = (date: Date): number =>
    Math.floor((date.getTime() + MANILA_OFFSET_MS) / HOUR_MS);
  const currentHour = hourIndex(now);
  const byHour = new Map<number, DailySpendPoint>();
  for (let index = currentHour - 23; index <= currentHour; index++) {
    // A Date whose UTC fields read as the Manila wall clock.
    const wall = new Date(index * HOUR_MS);
    byHour.set(index, {
      date: wall.toISOString().slice(0, 13),
      label: hourLabelFormatter.format(wall),
      renderUsd: 0,
      iterateUsd: 0,
      totalUsd: 0,
    });
  }

  for (const run of runs) {
    if (typeof run.cost_usd !== "number" || run.cost_usd <= 0) continue;
    const point = byHour.get(hourIndex(new Date(run.created_at)));
    if (!point) continue;
    if (run.scene_id !== null) {
      point.renderUsd += run.cost_usd;
    } else {
      point.iterateUsd += run.cost_usd;
    }
    point.totalUsd = point.renderUsd + point.iterateUsd;
  }

  return Array.from(byHour.values());
}

const monthLabelFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

/** The last `months` Manila calendar months, oldest first, as [start, end) ISO pairs. */
export function manilaMonthWindows(
  now: Date,
  months: number,
): { date: string; label: string; startIso: string; endIso: string }[] {
  const windows: { date: string; label: string; startIso: string; endIso: string }[] = [];
  let endIso = new Date(now.getTime() + 1).toISOString();
  let startIso = startOfManilaMonthIso(now);
  for (let i = 0; i < months; i++) {
    const wall = new Date(new Date(startIso).getTime() + MANILA_OFFSET_MS);
    windows.unshift({
      date: wall.toISOString().slice(0, 7),
      label: monthLabelFormatter.format(wall),
      startIso,
      endIso,
    });
    endIso = startIso;
    startIso = startOfManilaMonthIso(new Date(new Date(startIso).getTime() - 24 * HOUR_MS));
  }
  return windows;
}

/**
 * The last 12 Manila months of team spend: one spend_category_totals call per
 * month, run in parallel, so no runs rows are paged in. Only loaded when the
 * chart is set to Monthly.
 */
export async function loadMonthlySpendSeries(now: Date = new Date()): Promise<DailySpendPoint[]> {
  const supabase = await createClient();
  const windows = manilaMonthWindows(now, 12);
  const totals = await Promise.all(
    windows.map((w) => getSpendCategoryTotals(supabase, w.startIso, w.endIso)),
  );
  return windows.map((w, i) => ({
    date: w.date,
    label: w.label,
    renderUsd: totals[i]!.renderUsd,
    iterateUsd: totals[i]!.iterateUsd,
    totalUsd: totals[i]!.totalUsd,
  }));
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
    imageModelLabelFor(model) ??
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
 * Merges `profiles` rows with per-user spend category totals for the
 * selected date window and sorts accounts by window spend (highest first),
 * then username.
 */
export function mergeAccountSpendRanking(
  directoryRows: readonly AccountControlDirectoryRow[],
  rangeTotals: readonly UserSpendCategoryTotal[],
): AccountSpendSummary[] {
  const rangeByUserId = new Map(rangeTotals.map((row) => [row.userId, row]));

  // No role filter here: the directory read already chose the roles, and a
  // second three-role list here hid Hybrid Editors and AI Animators (0131).
  return directoryRows
    .map((row) => {
      const range = rangeByUserId.get(row.id);
      return {
        id: row.id,
        email: row.email,
        username: row.username,
        role: row.role,
        status: row.status,
        lastSeenAt: row.last_seen_at,
        avatarStorageKey: row.avatar_storage_key,
        rangeRenderUsd: range?.renderUsd ?? 0,
        rangeIterateUsd: range?.iterateUsd ?? 0,
        rangeTotalUsd: range?.totalUsd ?? 0,
      };
    })
    .sort((a, b) => {
      if (b.rangeTotalUsd !== a.rangeTotalUsd) return b.rangeTotalUsd - a.rangeTotalUsd;
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

  // Asia/Manila boundaries, the same ones the spend caps reset on. The upper
  // edge of every "so far" figure is the next 05:00 Manila reset.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const todayStart = new Date(startOfManilaDayIso(now));
  const tomorrowStart = new Date(endOfManilaDayIso(now));
  const monthStart = new Date(startOfManilaMonthIso(now));
  const windowStart = new Date(manilaWindowStartIso(now, windowDays));
  // Previous periods, like for like: yesterday up to this time of day, last
  // month over the same elapsed span, and the window before this one.
  const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);
  const lastMonthStart = new Date(startOfManilaMonthIso(new Date(monthStart.getTime() - DAY_MS)));
  const lastMonthSpanEnd = new Date(
    Math.min(
      lastMonthStart.getTime() + (now.getTime() - monthStart.getTime()),
      monthStart.getTime(),
    ),
  );
  const previousWindowStart = new Date(manilaWindowStartIso(now, windowDays * 2));
  const runwayWindowStart = new Date(now.getTime() - RUNWAY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [
    todaySpendUsd,
    yesterdaySameTimeUsd,
    lastMonthSameSpanUsd,
    previousWindowUsd,
    { count: rendersToday, error: rendersTodayError },
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
    getSpendTotalUsd(
      supabase,
      yesterdayStart.toISOString(),
      new Date(now.getTime() - DAY_MS).toISOString(),
    ),
    getSpendTotalUsd(supabase, lastMonthStart.toISOString(), lastMonthSpanEnd.toISOString()),
    // Same source as rangeCategoryTotals, so the two windows compare like for like.
    getSpendCategoryTotals(
      supabase,
      previousWindowStart.toISOString(),
      windowStart.toISOString(),
    ).then((totals) => totals.totalUsd),
    supabase
      .from("runs")
      .select("id", { count: "exact", head: true })
      .gte("created_at", todayStart.toISOString()),
    getGlobalSpendSnapshot(now),
    getSpendTotalUsd(supabase, runwayWindowStart.toISOString(), now.toISOString()),
    getSpendTotalUsd(supabase, monthStart.toISOString(), tomorrowStart.toISOString()),
    getSpendCategoryTotals(supabase, windowStart.toISOString(), tomorrowStart.toISOString()),
    getSpendCategoryTotalsByUser(supabase, windowStart.toISOString(), tomorrowStart.toISOString()),
    getKieAccountBalanceUsd(),
    getBytePlusBalanceUsd(),
    // profiles, not user_directory: that view sums every run ever made on each
    // read, and all-time spend is only shown for the selected account
    // (loadAccountAllTimeSpendUsd).
    supabase
      .from("profiles")
      .select("id, email, username, role, status, created_at, last_seen_at, avatar_storage_key")
      // Every role: hybrid_editor and ai_animator (0131) were missing, so most
      // of the team never appeared in Top accounts.
      .in("role", ["admin", ...BULK_ALLOWANCE_SCOPE_ROLES.all]),
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
    user_id: string | null;
    projects: { user_id: string } | null;
  }[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data: runBatch, error: runsError } = await supabase
      .from("runs")
      .select("created_at, cost_usd, scene_id, model, vendor, user_id, projects ( user_id )")
      .gte("created_at", windowStart.toISOString())
      .lt("created_at", tomorrowStart.toISOString())
      .not("cost_usd", "is", null)
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (runsError) {
      throw new Error(`Failed to load daily run series: ${runsError.message}`);
    }
    const rows = (runBatch ?? []) as unknown as typeof windowRuns;
    windowRuns.push(...rows);
    if (rows.length < PAGE) break;
  }

  const dailySeries = buildDailySpendSeries(windowRuns, windowDays, now);
  // The window is at least 7 days, so it always covers the last 24 hours.
  const hourlySeries = buildHourlySpendSeries(windowRuns, now);
  // Billed runs per owner, resolved like every spend read: coalesce(runs.user_id, project owner).
  const runCountByUserId = new Map<string, number>();
  const billedRuns = windowRuns.filter((run) => (run.cost_usd ?? 0) > 0);
  for (const run of billedRuns) {
    const owner = run.user_id ?? run.projects?.user_id;
    if (owner) runCountByUserId.set(owner, (runCountByUserId.get(owner) ?? 0) + 1);
  }
  const accounts = mergeAccountSpendRanking(
    (directoryData ?? []) as AccountControlDirectoryRow[],
    userCategoryTotals,
  ).map((account) => ({
    ...account,
    rangeRunCount: runCountByUserId.get(account.id) ?? 0,
  }));
  if (rendersTodayError)
    console.error(`Failed to count today's runs: ${rendersTodayError.message}`);
  const runwayEstimate = computeRunway(kieBalanceUsd, weekSpendUsd);

  return {
    windowDays,
    todaySpendUsd,
    yesterdaySameTimeUsd,
    lastMonthSameSpanUsd,
    previousWindowUsd,
    rendersToday: rendersTodayError ? null : (rendersToday ?? 0),
    avgCostPerRenderUsd:
      billedRuns.length > 0
        ? billedRuns.reduce((sum, run) => sum + (run.cost_usd ?? 0), 0) / billedRuns.length
        : null,
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
    hourlySeries,
    modelUsage: buildModelUsage(windowRuns),
    accounts,
  };
}

function resolveImageModelLabel(model: string): string {
  return imageModelLabelFor(model) ?? model;
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
 * One account's all-time spend, for the selected-account panel only. Fail-soft:
 * null shows "—" rather than taking the page down.
 */
export async function loadAccountAllTimeSpendUsd(
  userId: string,
  now: Date = new Date(),
): Promise<number | null> {
  try {
    return await getUserSpendUsd(
      await createClient(),
      userId,
      new Date(0).toISOString(),
      endOfManilaDayIso(now),
    );
  } catch (error) {
    console.error(`Failed to load all-time spend for ${userId}`, error);
    return null;
  }
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
  const tomorrowStart = new Date(endOfManilaDayIso(now));
  const windowStart = new Date(manilaWindowStartIso(now, windowDays));
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
              url: await signedUrl(source.storageKey, SIGNED_URL_TTL_SECONDS),
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
 * Loads a target account's active 3-day Bin entries (deleted scenes, deleted
 * takes, and binned personal images) with playable video clip URLs, download
 * URLs, and 3-day expiry labels for `/accounts-control`.
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
  const runByAssetId = new Map<
    string,
    { prompt: string | null; model: string; cost_usd: number | null }
  >();
  // Independent of each other, so one round trip's wait, not two.
  const [projectsResult, runsResult] = await Promise.all([
    projectIds.length > 0
      ? supabase.from("projects").select("id, render_settings").in("id", projectIds)
      : null,
    imageRows.length > 0
      ? supabase
          .from("runs")
          .select("asset_id, prompt, model, cost_usd")
          .eq("user_id", userId)
          .is("project_id", null)
          .in(
            "asset_id",
            imageRows.map((img) => img.id),
          )
      : null,
  ]);
  for (const row of projectsResult?.data ?? []) {
    projectSettingsById.set(row.id, row.render_settings);
  }
  for (const run of runsResult?.data ?? []) {
    if (run.asset_id && !runByAssetId.has(run.asset_id)) {
      runByAssetId.set(run.asset_id, run);
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
            ? await signedUrl(source.storageKey, SIGNED_URL_TTL_SECONDS)
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
        const url = await getImageUrl(row.storage_key, "thumb", SIGNED_URL_TTL_SECONDS);
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
