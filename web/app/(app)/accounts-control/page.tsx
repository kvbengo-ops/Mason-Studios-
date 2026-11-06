import Link from "next/link";
import { redirect } from "next/navigation";
import type { JSX, ReactNode } from "react";
import { DownloadIcon, TriangleAlert } from "lucide-react";
import { requireAdmin } from "@/actions/guard";
import { purgeDeletedScene, purgeDeletedVersion, reapExpiredBinEntries } from "@/actions/ugc";
import { AccountStatusBadge } from "@/components/account-status-badge";
import { ActionForm } from "@/components/action-form";
import { BinCard } from "@/components/bin-card";
import { BinThumbnail } from "@/components/bin-thumbnail";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { PaginationControls } from "@/components/pagination-controls";
import { RoleBadge } from "@/components/role-badge";
import { GlobalSpendCapControl } from "@/components/global-spend-cap-control";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  loadAccountControlDeleted,
  loadAccountsControlOverview,
  loadAccountsRunLog,
  parseWindowDays,
  type AccountControlDeletedData,
  type AccountsControlWindowDays,
} from "@/lib/accounts-control";
import {
  loadEditorImages,
  loadEditorVideos,
  type EditorImageItem,
  type EditorVideoClip,
} from "@/lib/admin-creations";
import { getAnthropicMonthlySpend } from "@/lib/anthropic-spend";
import { dateTimeFormatter } from "@/lib/datetime";
import { asAttachment } from "@/lib/download-url";
import { formatCredits, formatDual, formatUsd } from "@/lib/format-usd";
import { pageRange, parsePage, totalPageCount } from "@/lib/pagination";
import { formatRunwayDays, isRunwayShort } from "@/lib/runway";
import { extFromFilename } from "@/lib/storage";
import { cn } from "@/lib/utils";

export type AccountsControlView = "spending" | "accounts" | "runs";
export type AccountsControlTab = "videos" | "images" | "deleted";

const WINDOW_OPTIONS: readonly AccountsControlWindowDays[] = [7, 14, 30];

const RUNS_PAGE_SIZE = 50;

const VIEWS: readonly { id: AccountsControlView; label: string }[] = [
  { id: "spending", label: "Spending" },
  { id: "accounts", label: "Accounts" },
  { id: "runs", label: "Runs" },
];

const TABS: readonly { id: AccountsControlTab; label: string }[] = [
  { id: "videos", label: "Videos" },
  { id: "images", label: "Images" },
  { id: "deleted", label: "Bin" },
];

// The Create page's segmented switch (components/create-mode-switch.tsx),
// so every Image | Video, window and tab choice in the app reads the same.
const SEGMENTED = "flex shrink-0 gap-1 rounded-xl border border-border bg-background/80 p-1";
const SEGMENT =
  "inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium transition-colors";
const SEGMENT_ON = "bg-muted text-foreground shadow-sm";
const SEGMENT_OFF = "text-muted-foreground hover:text-foreground";
const PANEL = "rounded-2xl border border-border bg-card";

function parseView(raw: string | string[] | undefined): AccountsControlView {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "accounts" || value === "runs") return value;
  return "spending";
}

function parseTab(raw: string | string[] | undefined): AccountsControlTab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "images" || value === "deleted") return value;
  return "videos";
}

function parseUserParam(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.trim().length > 0 ? value.trim() : null;
}

function buildAccountsControlHref(params: {
  view: AccountsControlView;
  days: AccountsControlWindowDays;
  user?: string | null;
  tab?: AccountsControlTab;
  page?: number;
}): string {
  const query = new URLSearchParams();
  if (params.view !== "spending") {
    query.set("view", params.view);
  }
  if (params.days !== 14) {
    query.set("days", String(params.days));
  }
  if (params.user) {
    query.set("user", params.user);
  }
  if (params.tab && params.tab !== "videos") {
    query.set("tab", params.tab);
  }
  if (params.page && params.page > 1) {
    query.set("page", String(params.page));
  }
  const qs = query.toString();
  return qs ? `/accounts-control?${qs}` : "/accounts-control";
}

function DownloadLink({ href, filename }: { href: string; filename?: string | null }): JSX.Element {
  return (
    <a
      href={asAttachment(href, filename ?? null)}
      download={filename ?? undefined}
      className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <DownloadIcon aria-hidden="true" className="size-3.5" />
      Download
    </a>
  );
}

function SectionHeading({
  id,
  title,
  count,
}: {
  id: string;
  title: string;
  count: number;
}): JSX.Element {
  return (
    <h3 id={id} className="flex items-baseline gap-2 text-lg font-medium">
      {title}
      <span className="font-sans text-sm font-normal tabular-nums text-muted-foreground">
        {count}
      </span>
    </h3>
  );
}

/** One view's panel: a heading row over its content. */
function ViewPanel({
  id,
  title,
  meta,
  children,
}: {
  id: string;
  title: string;
  meta?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section aria-labelledby={id} className={PANEL}>
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <h2 id={id} className="text-lg font-medium">
          {title}
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">{meta}</span>
      </div>
      <div className="border-t border-border px-5 py-5">{children}</div>
    </section>
  );
}

function EmptyState({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/** One gallery tile: the media first, then a quiet caption — the Create wall's shape. */
function MediaTile({
  media,
  label,
  cost,
  prompt,
  footnote,
  action,
}: {
  media: ReactNode;
  label: string | null;
  cost: number | null;
  prompt: string;
  footnote: string;
  action: ReactNode;
}): JSX.Element {
  return (
    <article className="flex min-w-0 flex-col gap-2">
      <div className="relative aspect-[9/16] w-full overflow-hidden rounded-xl bg-muted">
        {media}
      </div>
      <div className="flex flex-col gap-1 px-0.5">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate font-medium text-foreground">{label}</span>
          {cost !== null ? (
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatCredits(cost)}
            </span>
          ) : null}
        </div>
        <p className="line-clamp-2 break-words text-sm leading-snug">{prompt}</p>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-muted-foreground">{footnote}</span>
          {action}
        </div>
      </div>
    </article>
  );
}

const GRID = "grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4";

function VideosSection({ clips }: { clips: readonly EditorVideoClip[] }): JSX.Element {
  return (
    <section aria-labelledby="accounts-control-videos-heading" className="flex flex-col gap-4">
      <SectionHeading id="accounts-control-videos-heading" title="Videos" count={clips.length} />
      {clips.length === 0 ? (
        <EmptyState>No generated video clips for this account yet.</EmptyState>
      ) : (
        <div className={GRID}>
          {clips.map((clip) => {
            const ext = extFromFilename(clip.url.split("?")[0] ?? "", "mp4");
            const filename = `clip-${clip.sceneId.slice(0, 8)}-v${clip.n}.${ext}`;
            return (
              <MediaTile
                key={clip.key}
                media={
                  <video
                    src={clip.url}
                    controls
                    preload="metadata"
                    playsInline
                    className="h-full w-full bg-black object-contain"
                  />
                }
                label={`${clip.modelLabel} · v${clip.n}${clip.durationS ? ` · ${clip.durationS}s` : ""}`}
                cost={clip.costUsd}
                prompt={clip.prompt || "(no prompt)"}
                footnote={`${clip.personal ? "Personal" : clip.projectTitle} · ${dateTimeFormatter.format(new Date(clip.createdAt))}`}
                action={<DownloadLink href={clip.url} filename={filename} />}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function ImagesSection({ images }: { images: readonly EditorImageItem[] }): JSX.Element {
  return (
    <section aria-labelledby="accounts-control-images-heading" className="flex flex-col gap-4">
      <SectionHeading id="accounts-control-images-heading" title="Images" count={images.length} />
      {images.length === 0 ? (
        <EmptyState>No personal generated images for this account yet.</EmptyState>
      ) : (
        <div className={GRID}>
          {images.map((image) => {
            const ext = extFromFilename(image.url.split("?")[0] ?? "", "jpg");
            const filename = `image-${image.assetId.slice(0, 8)}.${ext}`;
            return (
              <MediaTile
                key={image.assetId}
                media={
                  // eslint-disable-next-line @next/next/no-img-element -- signed Storage URL
                  <img
                    src={image.url}
                    alt={image.prompt ?? "Generated image"}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                }
                label={image.modelLabel}
                cost={image.costUsd}
                prompt={image.prompt ?? "(no prompt)"}
                footnote={dateTimeFormatter.format(new Date(image.createdAt))}
                action={<DownloadLink href={image.url} filename={filename} />}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function PurgeButton({ confirmMessage }: { confirmMessage: string }): JSX.Element {
  return (
    <ConfirmSubmitButton
      pendingLabel="Deleting"
      variant="ghost"
      size="sm"
      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      confirmMessage={confirmMessage}
    >
      Delete permanently
    </ConfirmSubmitButton>
  );
}

function DeletedSection({ deleted }: { deleted: AccountControlDeletedData }): JSX.Element {
  const { scenes, versions, images } = deleted;

  if (scenes.length + versions.length + images.length === 0) {
    return <EmptyState>Nothing in this account&apos;s 2-week Bin.</EmptyState>;
  }

  return (
    <div className="flex flex-col gap-10">
      <p className="text-xs text-muted-foreground">
        Deleted work stays here for two weeks, then is removed for good.
      </p>

      {scenes.length > 0 ? (
        <section
          aria-labelledby="accounts-control-deleted-scenes-heading"
          className="flex flex-col gap-4"
        >
          <SectionHeading
            id="accounts-control-deleted-scenes-heading"
            title="Scenes"
            count={scenes.length}
          />
          <div className={GRID}>
            {scenes.map((scene) => {
              const metaParts = [
                `${scene.versionCount} version${scene.versionCount === 1 ? "" : "s"}`,
                scene.modelLabel,
              ].filter(Boolean);
              return (
                <BinCard
                  key={scene.sceneId}
                  itemLabel={scene.idx === null ? "Scene" : `Scene #${scene.idx}`}
                  badge={scene.idx === null ? "—" : `#${scene.idx}`}
                  meta={metaParts.join(" · ")}
                  promptFirstLine={scene.prompt}
                  deletedAtLabel={dateTimeFormatter.format(new Date(scene.deletedAt))}
                  expiresLabel={scene.expiresLabel}
                  thumbnail={scene.thumbnail}
                  actions={
                    <>
                      {scene.downloadUrl ? (
                        <DownloadLink href={scene.downloadUrl} filename={scene.downloadFilename} />
                      ) : null}
                      <ActionForm
                        action={purgeDeletedScene}
                        fallbackErrorMessage="Could not delete this scene permanently."
                      >
                        <input type="hidden" name="sceneId" value={scene.sceneId} />
                        <PurgeButton
                          confirmMessage={`Permanently delete ${
                            scene.idx === null ? "this scene" : `scene #${scene.idx}`
                          }? This removes the scene and its files from storage for good — it can no longer be restored.`}
                        />
                      </ActionForm>
                    </>
                  }
                />
              );
            })}
          </div>
        </section>
      ) : null}

      {versions.length > 0 ? (
        <section
          aria-labelledby="accounts-control-deleted-versions-heading"
          className="flex flex-col gap-4"
        >
          <SectionHeading
            id="accounts-control-deleted-versions-heading"
            title="Takes"
            count={versions.length}
          />
          <div className={GRID}>
            {versions.map((version) => (
              <BinCard
                key={version.versionId}
                itemLabel={version.n === null ? "Version" : `Version v${version.n}`}
                badge={version.n === null ? "—" : `v${version.n}`}
                meta={version.modelLabel ?? undefined}
                promptFirstLine={version.prompt}
                deletedAtLabel={dateTimeFormatter.format(new Date(version.deletedAt))}
                expiresLabel={version.expiresLabel}
                thumbnail={version.thumbnail}
                actions={
                  <>
                    {version.downloadUrl ? (
                      <DownloadLink
                        href={version.downloadUrl}
                        filename={version.downloadFilename}
                      />
                    ) : null}
                    <ActionForm
                      action={purgeDeletedVersion}
                      fallbackErrorMessage="Could not delete this version permanently."
                    >
                      <input type="hidden" name="versionId" value={version.versionId} />
                      <PurgeButton
                        confirmMessage={`Permanently delete ${
                          version.n === null ? "this version" : `v${version.n}`
                        }? This removes the version and its clip from storage for good — it can no longer be restored.`}
                      />
                    </ActionForm>
                  </>
                }
              />
            ))}
          </div>
        </section>
      ) : null}

      {images.length > 0 ? (
        <section
          aria-labelledby="accounts-control-deleted-images-heading"
          className="flex flex-col gap-4"
        >
          <SectionHeading
            id="accounts-control-deleted-images-heading"
            title="Images"
            count={images.length}
          />
          <div className={GRID}>
            {images.map((image) => (
              <MediaTile
                key={image.assetId}
                media={
                  <BinThumbnail
                    thumbnail={image.thumbnail}
                    itemLabel="Generated image"
                    badge="Image"
                  />
                }
                label={image.modelLabel ?? "Image"}
                cost={image.costUsd}
                prompt={image.prompt ?? "Generated image"}
                footnote={`Deleted ${dateTimeFormatter.format(new Date(image.deletedAt))}`}
                action={
                  image.downloadUrl ? (
                    <DownloadLink href={image.downloadUrl} filename={image.downloadFilename} />
                  ) : null
                }
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  alert = false,
}: {
  label: string;
  value: string;
  sub: string;
  alert?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1 bg-card px-5 py-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
      <span
        className={cn(
          "text-xs tabular-nums",
          alert ? "font-medium text-destructive" : "text-muted-foreground",
        )}
      >
        {sub}
      </span>
    </div>
  );
}

export default async function AccountsControlPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string | string[];
    days?: string | string[];
    user?: string | string[];
    tab?: string | string[];
    page?: string | string[];
  }>;
}): Promise<JSX.Element> {
  await requireAdmin();
  await reapExpiredBinEntries();

  const resolvedParams = await searchParams;
  const view = parseView(resolvedParams.view);
  const windowDays = parseWindowDays(resolvedParams.days);
  const tab = parseTab(resolvedParams.tab);
  const requestedUserId = parseUserParam(resolvedParams.user);
  const requestedPage = parsePage(resolvedParams.page);

  // Only what the open view shows is loaded.
  const [overview, claudeSpend, runLog] = await Promise.all([
    loadAccountsControlOverview(windowDays),
    view === "spending" ? getAnthropicMonthlySpend() : null,
    view === "runs"
      ? loadAccountsRunLog(windowDays, pageRange(requestedPage, RUNS_PAGE_SIZE))
      : null,
  ]);
  const totalPages = runLog ? totalPageCount(runLog.total, RUNS_PAGE_SIZE) : 1;
  const selectedAccount =
    overview.accounts.find((account) => account.id === requestedUserId) ??
    overview.accounts[0] ??
    null;

  let inspectorContent: JSX.Element | null = null;
  if (view === "accounts" && selectedAccount) {
    if (tab === "videos") {
      const { clips } = await loadEditorVideos(selectedAccount.id);
      inspectorContent = <VideosSection clips={clips} />;
    } else if (tab === "images") {
      const imagePage = await loadEditorImages(selectedAccount.id, null);
      inspectorContent = <ImagesSection images={imagePage.images} />;
    } else {
      const deleted = await loadAccountControlDeleted(selectedAccount.id);
      inspectorContent = <DeletedSection deleted={deleted} />;
    }
  }

  const maxDailyUsd = Math.max(...overview.dailySeries.map((point) => point.totalUsd), 0);
  const maxLineUsd = Math.max(
    ...overview.dailySeries.flatMap((point) => [point.renderUsd, point.iterateUsd]),
    0,
  );
  const pctOfMaxLine = (usd: number): number => (maxLineUsd > 0 ? (usd / maxLineUsd) * 100 : 0);
  const maxAccountRangeUsd = Math.max(
    ...overview.accounts.map((account) => account.rangeTotalUsd),
    0,
  );
  const runwayShort = isRunwayShort(overview.runwayEstimate);
  const kieEmpty = overview.kieBalanceUsd !== null && overview.kieBalanceUsd <= 0;
  const series = overview.dailySeries;
  const user = selectedAccount?.id ?? null;
  const hrefFor = (page: number): string =>
    buildAccountsControlHref({ view, days: windowDays, user, tab, page });

  // A stale bookmark lands on the real last page, not an empty table.
  if (runLog && requestedPage > totalPages && runLog.total > 0) redirect(hrefFor(totalPages));

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 md:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">Accounts and Spending Control</h1>
          <p className="text-sm text-muted-foreground">
            Team spend, vendor balances, and everything each account has made.
          </p>
        </div>

        <nav aria-label="Spending window" className={SEGMENTED}>
          {WINDOW_OPTIONS.map((days) => {
            const active = windowDays === days;
            return (
              <Link
                key={days}
                href={buildAccountsControlHref({ view, days, user, tab })}
                aria-current={active ? "page" : undefined}
                className={cn(SEGMENT, active ? SEGMENT_ON : SEGMENT_OFF)}
              >
                {days} days
              </Link>
            );
          })}
        </nav>
      </header>

      {kieEmpty || runwayShort ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-medium">
              {kieEmpty ? "Kie account is out of credits." : "Kie credits are running low."}
            </span>{" "}
            Fund the Kie account before starting more paid renders.
          </p>
        </div>
      ) : null}

      {/* gap-px over a border-coloured grid: hairline dividers at any width. */}
      <section
        aria-label="Credit consumption summary"
        className={cn(PANEL, "grid gap-px overflow-hidden bg-border sm:grid-cols-3")}
      >
        <Stat
          label="Today (UTC)"
          value={formatCredits(overview.todaySpendUsd)}
          sub={formatUsd(overview.todaySpendUsd)}
        />
        <Stat
          label="This month"
          value={formatCredits(overview.monthSpendUsd)}
          sub={`${formatUsd(overview.monthSpendUsd)} · ${formatUsd(overview.weekSpendUsd)} last 7 days`}
        />
        <Stat
          label="Kie balance"
          value={
            overview.kieBalanceUsd !== null ? formatCredits(overview.kieBalanceUsd) : "Unavailable"
          }
          sub={`${overview.kieBalanceUsd !== null ? `${formatUsd(overview.kieBalanceUsd)} · ` : ""}Runway ${formatRunwayDays(overview.runwayEstimate)}`}
          alert={kieEmpty || runwayShort}
        />
      </section>

      <nav aria-label="Sections" className={cn(SEGMENTED, "self-start")}>
        {VIEWS.map((entry) => {
          const active = view === entry.id;
          return (
            <Link
              key={entry.id}
              href={buildAccountsControlHref({ view: entry.id, days: windowDays, user, tab })}
              aria-current={active ? "page" : undefined}
              scroll={false}
              className={cn(SEGMENT, "px-4", active ? SEGMENT_ON : SEGMENT_OFF)}
            >
              {entry.label}
            </Link>
          );
        })}
      </nav>

      {view === "spending" ? (
        <>
          <GlobalSpendCapControl
            settings={overview.globalSpendCap}
            spentUsd={overview.teamGlobalSpendUsd}
          />

          <ViewPanel
            id="accounts-control-spending-heading"
            title="Daily spend"
            meta={`${formatDual(overview.rangeCategoryTotals.totalUsd)} in ${windowDays} days`}
          >
            <Tabs defaultValue="bars" className="gap-4">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="size-2 rounded-full bg-chart-1" />
                    Video {formatCredits(overview.rangeCategoryTotals.renderUsd)}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="size-2 rounded-full bg-chart-4" />
                    Images {formatCredits(overview.rangeCategoryTotals.iterateUsd)}
                  </span>
                </div>
                <TabsList aria-label="Chart type">
                  <TabsTrigger value="bars" className="px-3 text-xs">
                    Bars
                  </TabsTrigger>
                  <TabsTrigger value="line" className="px-3 text-xs">
                    Line
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="bars">
                <div
                  role="img"
                  aria-label={`Daily credit consumption over the last ${windowDays} days`}
                  className="flex h-52 items-end gap-1 border-b border-border"
                >
                  {series.map((point) => {
                    const totalPct = maxDailyUsd > 0 ? (point.totalUsd / maxDailyUsd) * 100 : 0;
                    const renderPct =
                      point.totalUsd > 0 ? (point.renderUsd / point.totalUsd) * 100 : 0;
                    const iteratePct =
                      point.totalUsd > 0 ? (point.iterateUsd / point.totalUsd) * 100 : 0;
                    return (
                      <div
                        key={point.date}
                        title={`${point.label} (${point.date}): ${formatDual(point.totalUsd)} — Video: ${formatCredits(point.renderUsd)}, Images: ${formatCredits(point.iterateUsd)}`}
                        className="group flex h-full flex-1 items-end justify-center"
                      >
                        {point.totalUsd > 0 ? (
                          // <=24px wide, 4px rounded data-end, square at the baseline,
                          // 2px surface gap between the stacked segments.
                          <div
                            className="flex w-full max-w-6 flex-col gap-0.5 overflow-hidden rounded-t-[4px] transition-opacity group-hover:opacity-80"
                            style={{ height: `${Math.max(totalPct, 6)}%` }}
                          >
                            {iteratePct > 0 ? (
                              <div
                                className="w-full bg-chart-4"
                                style={{ height: `${iteratePct}%` }}
                              />
                            ) : null}
                            {renderPct > 0 ? (
                              <div
                                className="w-full bg-chart-1"
                                style={{ height: `${renderPct}%` }}
                              />
                            ) : null}
                          </div>
                        ) : (
                          <div className="h-0.5 w-full max-w-6 rounded-full bg-muted" />
                        )}
                      </div>
                    );
                  })}
                </div>
              </TabsContent>

              <TabsContent value="line">
                {/* The top border is the peak day, the bottom border is zero. */}
                <div
                  role="img"
                  aria-label={`Daily credit consumption over the last ${windowDays} days`}
                  className="relative h-52 border-y border-border"
                >
                  {maxLineUsd > 0 ? (
                    <span className="absolute bottom-full right-0 text-[11px] tabular-nums text-muted-foreground">
                      {formatCredits(maxLineUsd)}
                    </span>
                  ) : null}
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    className="absolute inset-0 size-full overflow-visible"
                  >
                    {[
                      { stroke: "stroke-chart-4", values: series.map((p) => p.iterateUsd) },
                      { stroke: "stroke-chart-1", values: series.map((p) => p.renderUsd) },
                    ].map(({ stroke, values }) => (
                      <polyline
                        key={stroke}
                        points={values
                          .map(
                            (usd, i) =>
                              `${((i + 0.5) / values.length) * 100},${100 - pctOfMaxLine(usd)}`,
                          )
                          .join(" ")}
                        fill="none"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                        className={stroke}
                      />
                    ))}
                  </svg>
                  {/* ponytail: CSS hover keeps this a server component; no keyboard
                    tooltip, the sr-only table below carries the same numbers. */}
                  <div className="absolute inset-0 flex">
                    {series.map((point, i) => (
                      <div key={point.date} className="group relative h-full flex-1">
                        <div className="pointer-events-none absolute inset-0 hidden group-hover:block">
                          <div className="absolute inset-y-0 left-1/2 w-px bg-muted-foreground/40" />
                          <span
                            className="absolute left-1/2 size-2 -translate-x-1/2 translate-y-1/2 rounded-full bg-chart-4 ring-2 ring-card"
                            style={{ bottom: `${pctOfMaxLine(point.iterateUsd)}%` }}
                          />
                          <span
                            className="absolute left-1/2 size-2 -translate-x-1/2 translate-y-1/2 rounded-full bg-chart-1 ring-2 ring-card"
                            style={{ bottom: `${pctOfMaxLine(point.renderUsd)}%` }}
                          />
                          <div
                            className={cn(
                              "absolute top-2 z-10 flex flex-col gap-0.5 whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs tabular-nums text-popover-foreground shadow-sm",
                              i < series.length / 2
                                ? "left-[calc(50%+0.5rem)]"
                                : "right-[calc(50%+0.5rem)]",
                            )}
                          >
                            <span className="text-muted-foreground">{point.label}</span>
                            <span className="font-medium">{formatDual(point.totalUsd)}</span>
                            <span className="inline-flex items-center gap-1.5">
                              <span className="size-2 rounded-full bg-chart-1" />
                              {formatCredits(point.renderUsd)} Video
                            </span>
                            <span className="inline-flex items-center gap-1.5">
                              <span className="size-2 rounded-full bg-chart-4" />
                              {formatCredits(point.iterateUsd)} Images
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <table className="sr-only">
                  <caption>Daily spend</caption>
                  <thead>
                    <tr>
                      <th scope="col">Day</th>
                      <th scope="col">Video</th>
                      <th scope="col">Images</th>
                      <th scope="col">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.map((point) => (
                      <tr key={point.date}>
                        <th scope="row">{point.label}</th>
                        <td>{formatCredits(point.renderUsd)}</td>
                        <td>{formatCredits(point.iterateUsd)}</td>
                        <td>{formatDual(point.totalUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TabsContent>
              <div className="flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
                <span>{series[0]?.label ?? ""}</span>
                {series.length > 2 ? (
                  <span>{series[Math.floor(series.length / 2)]?.label ?? ""}</span>
                ) : null}
                <span>{series[series.length - 1]?.label ?? ""}</span>
              </div>
            </Tabs>
          </ViewPanel>

          <ViewPanel
            id="accounts-control-models-heading"
            title="Models used"
            meta={`${overview.modelUsage.reduce((sum, m) => sum + m.runs, 0)} billed runs in ${windowDays} days`}
          >
            {overview.modelUsage.length === 0 ? (
              <EmptyState>No billed runs in this window.</EmptyState>
            ) : (
              <ul className="flex flex-col gap-3">
                {overview.modelUsage.map((usage) => (
                  <li
                    key={usage.label}
                    className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]"
                  >
                    <span className="truncate" title={usage.label}>
                      {usage.label}
                    </span>
                    <div className="h-2">
                      <div
                        className="h-full min-w-1 rounded-r-[4px] bg-chart-1"
                        style={{
                          width: `${(usage.runs / (overview.modelUsage[0]?.runs ?? 1)) * 100}%`,
                        }}
                      />
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {`${usage.runs} run${usage.runs === 1 ? "" : "s"} · ${formatCredits(usage.costUsd)}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </ViewPanel>

          {claudeSpend?.status === "ok" ? (
            <p className="text-xs tabular-nums text-muted-foreground">
              Claude API this month: {formatUsd(claudeSpend.usd)}
            </p>
          ) : null}
        </>
      ) : null}

      {view === "accounts" ? (
        <ViewPanel
          id="accounts-control-accounts-heading"
          title="Accounts"
          meta={`${overview.accounts.length} account${overview.accounts.length === 1 ? "" : "s"}`}
        >
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
            {/* ONE account picker: the per-account ranking is also the selector,
                so there is no second strip of the same names to keep in sync. */}
            <aside className="flex flex-col gap-1 rounded-xl bg-muted/40 p-1.5 lg:sticky lg:top-6">
              {overview.accounts.length === 0 ? (
                <p className="px-3 py-6 text-sm text-muted-foreground">No accounts found.</p>
              ) : (
                <nav
                  aria-label="Select account"
                  className="flex max-h-[28rem] flex-col gap-0.5 overflow-y-auto"
                >
                  {overview.accounts.map((account) => {
                    const active = selectedAccount?.id === account.id;
                    const barPct =
                      maxAccountRangeUsd > 0
                        ? (account.rangeTotalUsd / maxAccountRangeUsd) * 100
                        : 0;
                    const renderSharePct =
                      account.rangeTotalUsd > 0
                        ? (account.rangeRenderUsd / account.rangeTotalUsd) * 100
                        : 0;
                    return (
                      <Link
                        key={account.id}
                        href={buildAccountsControlHref({
                          view,
                          days: windowDays,
                          user: account.id,
                          tab,
                        })}
                        aria-current={active ? "true" : undefined}
                        scroll={false}
                        className={cn(
                          "flex flex-col gap-2 rounded-xl px-3 py-2.5 transition-colors",
                          active ? "bg-card shadow-sm" : "hover:bg-card/60",
                        )}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {account.username}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {formatCredits(account.rangeTotalUsd)}
                          </span>
                        </span>
                        <span className="h-1 w-full overflow-hidden rounded-full bg-border/60">
                          {account.rangeTotalUsd > 0 ? (
                            <span
                              className="flex h-full overflow-hidden rounded-full bg-primary/35"
                              style={{ width: `${Math.max(barPct, 4)}%` }}
                            >
                              <span
                                className="h-full bg-primary"
                                style={{ width: `${renderSharePct}%` }}
                              />
                            </span>
                          ) : null}
                        </span>
                      </Link>
                    );
                  })}
                </nav>
              )}
              <Link
                href="/users"
                className="mt-1 rounded-xl px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-card/60 hover:text-foreground"
              >
                Approvals &amp; allowances →
              </Link>
            </aside>

            <section
              aria-labelledby="accounts-control-inspector-heading"
              className="flex min-w-0 flex-col gap-6"
            >
              {selectedAccount ? (
                <>
                  <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3
                          id="accounts-control-inspector-heading"
                          className="truncate text-2xl font-medium"
                        >
                          {selectedAccount.username}
                        </h3>
                        <RoleBadge role={selectedAccount.role} />
                        <AccountStatusBadge
                          role={selectedAccount.role}
                          status={selectedAccount.status}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {selectedAccount.email} ·{" "}
                        <span className="tabular-nums">
                          {windowDays} days {formatDual(selectedAccount.rangeTotalUsd)} · all-time{" "}
                          {formatDual(selectedAccount.allTimeSpendUsd)}
                        </span>
                      </p>
                    </div>

                    <nav aria-label="Creation categories" className={SEGMENTED}>
                      {TABS.map((entry) => {
                        const active = tab === entry.id;
                        return (
                          <Link
                            key={entry.id}
                            href={buildAccountsControlHref({
                              view,
                              days: windowDays,
                              user: selectedAccount.id,
                              tab: entry.id,
                            })}
                            aria-current={active ? "page" : undefined}
                            // Same page, new query: keep the reader where they are.
                            scroll={false}
                            className={cn(SEGMENT, "px-4", active ? SEGMENT_ON : SEGMENT_OFF)}
                          >
                            {entry.label}
                          </Link>
                        );
                      })}
                    </nav>
                  </div>

                  {inspectorContent}
                </>
              ) : (
                <>
                  <h3 id="accounts-control-inspector-heading" className="sr-only">
                    Account creations
                  </h3>
                  <EmptyState>No accounts available to inspect.</EmptyState>
                </>
              )}
            </section>
          </div>
        </ViewPanel>
      ) : null}

      {/* Every vendor call in the window, every account. */}
      {runLog ? (
        <ViewPanel
          id="accounts-control-runs-heading"
          title="All runs"
          meta={`${runLog.total} in the last ${windowDays} days`}
        >
          {runLog.rows.length === 0 ? (
            <EmptyState>No runs in this window.</EmptyState>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="overflow-hidden rounded-xl border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">Date</TableHead>
                      <TableHead>Project</TableHead>
                      <TableHead className="whitespace-nowrap">Model</TableHead>
                      <TableHead numeric>Cost</TableHead>
                      <TableHead>Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runLog.rows.map((run) => (
                      <TableRow key={run.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {dateTimeFormatter.format(new Date(run.createdAt))}
                        </TableCell>
                        <TableCell>{run.projectTitle ?? "—"}</TableCell>
                        <TableCell className="whitespace-nowrap">{run.model}</TableCell>
                        <TableCell numeric>
                          {run.costUsd !== null ? formatUsd(run.costUsd) : "Not billed"}
                        </TableCell>
                        <TableCell className="text-destructive">{run.error ?? ""}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <PaginationControls
                page={requestedPage}
                totalPages={totalPages}
                previousHref={requestedPage > 1 ? hrefFor(requestedPage - 1) : null}
                nextHref={requestedPage < totalPages ? hrefFor(requestedPage + 1) : null}
              />
            </div>
          )}
        </ViewPanel>
      ) : null}
    </main>
  );
}
