import Link from "next/link";
import { redirect } from "next/navigation";
import type { JSX, ReactNode } from "react";
import {
  ArrowUpRight,
  BarChart3,
  DownloadIcon,
  History,
  SlidersHorizontal,
  TriangleAlert,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { requireAdmin } from "@/actions/guard";
import { purgeDeletedScene, purgeDeletedVersion, reapExpiredBinEntries } from "@/actions/ugc";
import { AccountStatusBadge } from "@/components/account-status-badge";
import { ActionForm } from "@/components/action-form";
import { BinCard } from "@/components/bin-card";
import { BinThumbnail } from "@/components/bin-thumbnail";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { PaginationControls } from "@/components/pagination-controls";
import { RoleBadge } from "@/components/role-badge";
import { PresenceDot } from "@/components/presence-dot";
import { RoleSelect } from "@/components/role-select";
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
import { formatUsd } from "@/lib/format-usd";
import { pageRange, parsePage, totalPageCount } from "@/lib/pagination";
import { formatRunwayDays, isRunwayShort } from "@/lib/runway";
import { extFromFilename } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { AccountsControlLiveRefresh } from "@/components/accounts-control-live-refresh";

export type AccountsControlView = "spending" | "accounts" | "runs";
export type AccountsControlTab = "videos" | "images" | "deleted";

const WINDOW_OPTIONS: readonly AccountsControlWindowDays[] = [7, 14, 30];

const RUNS_PAGE_SIZE = 50;

const VIEWS: readonly { id: AccountsControlView; label: string; icon: LucideIcon }[] = [
  { id: "spending", label: "Spending", icon: BarChart3 },
  { id: "accounts", label: "Accounts", icon: Users },
  { id: "runs", label: "Runs", icon: History },
];

const TABS: readonly { id: AccountsControlTab; label: string }[] = [
  { id: "videos", label: "Videos" },
  { id: "images", label: "Images" },
  { id: "deleted", label: "Bin" },
];

// The Create page's segmented switch (components/create-mode-switch.tsx),
// so every Image | Video, window and tab choice in the app reads the same.
const SEGMENTED =
  "flex max-w-full shrink-0 gap-1 rounded-xl border border-border/70 bg-muted/40 p-1";
const SEGMENT =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const SEGMENT_ON = "bg-card text-foreground shadow-sm";
const SEGMENT_OFF = "text-muted-foreground hover:text-foreground";
const PANEL = "min-w-0 rounded-2xl border border-border/70 bg-card";

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
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-5 sm:px-6">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">{meta}</span>
      </div>
      <div className="border-t border-border/60 px-5 py-5 sm:px-6 sm:py-6">{children}</div>
    </section>
  );
}

function EmptyState({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="rounded-xl border border-dashed border-border bg-muted/20 px-6 py-16 text-center text-sm leading-relaxed text-muted-foreground">
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
    <article className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-muted">{media}</div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate font-medium text-foreground">{label}</span>
          {cost !== null ? (
            <span className="shrink-0 tabular-nums text-muted-foreground">{formatUsd(cost)}</span>
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

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] gap-4";

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
  icon: Icon,
}: {
  label: string;
  value: string;
  sub: string;
  alert?: boolean;
  icon: LucideIcon;
}): JSX.Element {
  return (
    <div
      className={cn(
        PANEL,
        "relative flex flex-col gap-3 p-5 sm:p-6",
        alert && "border-destructive/40",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        <span
          className={cn(
            "grid size-9 place-items-center rounded-xl",
            alert ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary",
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
        </span>
      </div>
      <span className="text-3xl font-semibold tracking-tight tabular-nums">{value}</span>
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

// Literal class names so Tailwind generates them; colours cycle past five.
const DONUT_STROKES = [
  "stroke-chart-1",
  "stroke-chart-2",
  "stroke-chart-3",
  "stroke-chart-4",
  "stroke-chart-5",
];
const DONUT_DOTS = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];

/** Models used as a donut of credit share, total in the centre, legend beside it. */
function ModelDonut({
  usage,
}: {
  usage: readonly { label: string; runs: number; costUsd: number }[];
}): JSX.Element {
  const totalUsd = usage.reduce((sum, m) => sum + m.costUsd, 0);
  const totalRuns = usage.reduce((sum, m) => sum + m.runs, 0);
  const shares = usage.map((m) => (totalUsd > 0 ? (m.costUsd / totalUsd) * 100 : 0));
  return (
    <div className="flex flex-col items-center gap-8 sm:flex-row sm:items-center">
      {/* r = 15.915 makes the circumference 100, so a dash length is a percentage. */}
      <div className="relative size-48 shrink-0">
        <svg aria-hidden="true" viewBox="0 0 42 42" className="size-full -rotate-90">
          <circle cx={21} cy={21} r={15.915} fill="none" strokeWidth={6} className="stroke-muted" />
          {usage.map((m, i) => {
            const share = shares[i] ?? 0;
            // ponytail: O(n²) prefix sum, n is a handful of models.
            const offset = -shares.slice(0, i).reduce((sum, s) => sum + s, 0);
            return share > 0 ? (
              <circle
                key={m.label}
                cx={21}
                cy={21}
                r={15.915}
                fill="none"
                strokeWidth={6}
                strokeDasharray={`${share} ${100 - share}`}
                strokeDashoffset={offset}
                className={DONUT_STROKES[i % DONUT_STROKES.length]}
              />
            ) : null;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-2xl font-semibold tracking-tight tabular-nums">
            {formatUsd(totalUsd)}
          </span>
          <span className="text-xs text-muted-foreground">{totalRuns} runs</span>
        </div>
      </div>
      <ul className="grid w-full grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
        {usage.map((m, i) => (
          <li key={m.label} className="flex min-w-0 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn("size-2 shrink-0 rounded-full", DONUT_DOTS[i % DONUT_DOTS.length])}
              />
              <span className="truncate" title={m.label}>
                {m.label}
              </span>
            </span>
            <span className="text-base font-semibold tabular-nums">{formatUsd(m.costUsd)}</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {m.runs} run{m.runs === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
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
  const runEmailByUserId = new Map(overview.accounts.map((account) => [account.id, account.email]));
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
    <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-6 sm:gap-8 md:px-8 md:py-10">
      <AccountsControlLiveRefresh />
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div className="flex max-w-2xl flex-col gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
            Administration
          </span>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Accounts and Spending Control
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Understand your team’s spending. Set limits. Review what gets made.
          </p>
        </div>
        <Link
          href="/users"
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SlidersHorizontal aria-hidden="true" className="size-4" />
          Manage accounts
          <ArrowUpRight aria-hidden="true" className="size-4 text-muted-foreground" />
        </Link>
      </header>

      {kieEmpty || runwayShort ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-medium">
              {kieEmpty ? "Kie account is out of funds." : "Kie funds are running low."}
            </span>{" "}
            Fund the Kie account before starting more paid renders.
          </p>
        </div>
      ) : null}

      <section aria-label="Spend summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat
          icon={BarChart3}
          label="Today (UTC)"
          value={formatUsd(overview.todaySpendUsd)}
          sub="So far today"
        />
        <Stat
          icon={History}
          label="This month"
          value={formatUsd(overview.monthSpendUsd)}
          sub={`${formatUsd(overview.weekSpendUsd)} last 7 days`}
        />
        <Stat
          icon={Wallet}
          label="Kie balance"
          value={
            overview.kieBalanceUsd !== null ? formatUsd(overview.kieBalanceUsd) : "Unavailable"
          }
          sub={`Runway ${formatRunwayDays(overview.runwayEstimate)}`}
          alert={kieEmpty || runwayShort}
        />
        <Stat
          icon={Wallet}
          label="BytePlus balance"
          value={
            overview.bytePlusBalanceUsd !== null
              ? formatUsd(overview.bytePlusBalanceUsd)
              : "Unavailable"
          }
          sub={`${formatUsd(overview.bytePlusRangeUsd)} spent last ${overview.windowDays} days`}
          alert={overview.bytePlusBalanceUsd !== null && overview.bytePlusBalanceUsd <= 0}
        />
        <GlobalSpendCapControl
          settings={overview.globalSpendCap}
          spentUsd={overview.teamGlobalSpendUsd}
        />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/70 pb-4">
        <nav aria-label="Sections" className={SEGMENTED}>
          {VIEWS.map((entry) => {
            const active = view === entry.id;
            const Icon = entry.icon;
            return (
              <Link
                key={entry.id}
                href={buildAccountsControlHref({ view: entry.id, days: windowDays, user, tab })}
                aria-current={active ? "page" : undefined}
                scroll={false}
                className={cn(SEGMENT, "sm:px-5", active ? SEGMENT_ON : SEGMENT_OFF)}
              >
                <Icon aria-hidden="true" className="hidden size-4 sm:block" />
                {entry.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted-foreground">Reporting window · UTC</span>
          <nav aria-label="Spending window" className={SEGMENTED}>
            {WINDOW_OPTIONS.map((days) => (
              <Link
                key={days}
                href={buildAccountsControlHref({ view, days, user, tab })}
                aria-current={windowDays === days ? "page" : undefined}
                scroll={false}
                className={cn(SEGMENT, windowDays === days ? SEGMENT_ON : SEGMENT_OFF)}
              >
                {days} days
              </Link>
            ))}
          </nav>
        </div>
      </div>

      {view === "spending" ? (
        // Wide graph column, narrow side column: Daily spend | Top accounts,
        // then Models used | Your team.
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <ViewPanel
            id="accounts-control-spending-heading"
            title="Daily spend"
            meta={`${formatUsd(overview.rangeCategoryTotals.totalUsd)} in ${windowDays} days`}
          >
            <Tabs defaultValue="bars" className="gap-4">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="size-2 rounded-full bg-chart-1" />
                    Video {formatUsd(overview.rangeCategoryTotals.renderUsd)}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="size-2 rounded-full bg-chart-4" />
                    Images {formatUsd(overview.rangeCategoryTotals.iterateUsd)}
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
                <div className="mb-3 flex items-center justify-between gap-3 text-[11px] tabular-nums text-muted-foreground">
                  <span>Spent</span>
                  <span>Peak day · {formatUsd(maxDailyUsd)}</span>
                </div>
                <div
                  role="img"
                  aria-label={`Daily spend over the last ${windowDays} days`}
                  className="flex h-64 items-end gap-1 rounded-t-lg border-b border-border bg-[linear-gradient(to_top,var(--border)_1px,transparent_1px)] bg-[size:100%_25%] pt-4 sm:h-72 sm:gap-2"
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
                        title={`${point.label} (${point.date}): ${formatUsd(point.totalUsd)} — Video: ${formatUsd(point.renderUsd)}, Images: ${formatUsd(point.iterateUsd)}`}
                        className="group flex h-full flex-1 items-end justify-center"
                      >
                        {point.totalUsd > 0 ? (
                          <div
                            className="flex w-full max-w-8 flex-col overflow-hidden rounded-t-md transition-opacity group-hover:opacity-80"
                            style={{ height: `${totalPct}%`, minHeight: 2 }}
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
                  aria-label={`Daily spend over the last ${windowDays} days`}
                  className="relative h-64 border-y border-border bg-[linear-gradient(to_top,var(--border)_1px,transparent_1px)] bg-[size:100%_25%] sm:h-72"
                >
                  {maxLineUsd > 0 ? (
                    <span className="absolute bottom-full right-0 text-[11px] tabular-nums text-muted-foreground">
                      {formatUsd(maxLineUsd)}
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
                    ]
                      .filter(({ values }) => values.length > 0)
                      .map(({ stroke, values }) => (
                        <polyline
                          key={`${stroke}-area`}
                          // The reference's soft fill: the line closed down to the baseline.
                          points={`${(0.5 / values.length) * 100},100 ${values
                            .map(
                              (usd, i) =>
                                `${((i + 0.5) / values.length) * 100},${100 - pctOfMaxLine(usd)}`,
                            )
                            .join(" ")} ${((values.length - 0.5) / values.length) * 100},100`}
                          stroke="none"
                          className={
                            stroke === "stroke-chart-1" ? "fill-chart-1/15" : "fill-chart-4/10"
                          }
                        />
                      ))}
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
                  {/* Daily totals below make the same figures available without hovering. */}
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
                            <span className="font-medium">{formatUsd(point.totalUsd)}</span>
                            <span className="inline-flex items-center gap-1.5">
                              <span className="size-2 rounded-full bg-chart-1" />
                              {formatUsd(point.renderUsd)} Video
                            </span>
                            <span className="inline-flex items-center gap-1.5">
                              <span className="size-2 rounded-full bg-chart-4" />
                              {formatUsd(point.iterateUsd)} Images
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </TabsContent>
              <div className="flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
                <span>{series[0]?.label ?? ""}</span>
                {series.length > 2 ? (
                  <span>{series[Math.floor(series.length / 2)]?.label ?? ""}</span>
                ) : null}
                <span>{series[series.length - 1]?.label ?? ""}</span>
              </div>
            </Tabs>
            <details className="mt-5 border-t border-border/60 pt-4">
              <summary className="cursor-pointer rounded-md text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                View daily totals
              </summary>
              <div className="mt-4">
                <Table>
                  <caption className="sr-only">Daily spend</caption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Day</TableHead>
                      <TableHead scope="col" numeric>
                        Video
                      </TableHead>
                      <TableHead scope="col" numeric>
                        Images
                      </TableHead>
                      <TableHead scope="col" numeric>
                        Total
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {series.map((point) => (
                      <TableRow key={point.date}>
                        <TableHead scope="row">{point.label}</TableHead>
                        <TableCell numeric>{formatUsd(point.renderUsd)}</TableCell>
                        <TableCell numeric>{formatUsd(point.iterateUsd)}</TableCell>
                        <TableCell numeric>{formatUsd(point.totalUsd)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </details>
          </ViewPanel>

          <ViewPanel
            id="accounts-control-top-accounts-heading"
            title="Top accounts"
            meta={`Spend · ${windowDays} days`}
          >
            {overview.accounts.length === 0 ? (
              <EmptyState>No accounts found.</EmptyState>
            ) : (
              <div className="-mx-5 sm:-mx-6">
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-5 sm:pl-6">Name</TableHead>
                      <TableHead numeric className="w-24 pr-5 sm:pr-6">
                        Spend
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {/* ponytail: top 8 here, the full list lives on the Accounts view. */}
                    {[...overview.accounts]
                      .sort((a, b) => b.rangeTotalUsd - a.rangeTotalUsd)
                      .slice(0, 8)
                      .map((account) => (
                        <TableRow key={account.id}>
                          <TableCell className="py-3 pl-5 sm:pl-6">
                            <Link
                              href={buildAccountsControlHref({
                                view: "accounts",
                                days: windowDays,
                                user: account.id,
                                tab,
                              })}
                              className="flex min-w-0 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <span
                                aria-hidden="true"
                                className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-semibold uppercase text-primary"
                              >
                                {account.username.slice(0, 2)}
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-medium">
                                  {account.username}
                                </span>
                                <span className="block truncate text-[11px] text-muted-foreground">
                                  {account.email}
                                </span>
                              </span>
                            </Link>
                          </TableCell>
                          <TableCell numeric className="py-3 pr-5 font-medium sm:pr-6">
                            {formatUsd(account.rangeTotalUsd)}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </ViewPanel>

          <ViewPanel
            id="accounts-control-models-heading"
            title="Models used"
            meta={`${overview.modelUsage.reduce((sum, m) => sum + m.runs, 0)} billed runs in ${windowDays} days`}
          >
            {overview.modelUsage.length === 0 ? (
              <EmptyState>No billed runs in this window.</EmptyState>
            ) : (
              <ModelDonut usage={overview.modelUsage} />
            )}
          </ViewPanel>

          {claudeSpend?.status === "ok" ? (
            <p className="text-xs tabular-nums text-muted-foreground xl:col-span-2">
              Claude API this month: {formatUsd(claudeSpend.usd)}
            </p>
          ) : null}
        </div>
      ) : null}

      {view === "accounts" ? (
        <ViewPanel
          id="accounts-control-accounts-heading"
          title="Accounts"
          meta={`${overview.accounts.length} account${overview.accounts.length === 1 ? "" : "s"}`}
        >
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[19rem_minmax(0,1fr)]">
            {/* ONE account picker: the per-account ranking is also the selector,
                so there is no second strip of the same names to keep in sync. */}
            <aside className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/20 p-3 lg:sticky lg:top-6">
              <div className="flex items-center justify-between px-1 py-1 text-xs text-muted-foreground">
                <span className="font-medium">Team directory</span>
                <span>Spend · {windowDays} days</span>
              </div>
              {overview.accounts.length === 0 ? (
                <p className="px-3 py-6 text-sm text-muted-foreground">No accounts found.</p>
              ) : (
                <nav
                  aria-label="Select account"
                  className="flex max-h-[22rem] flex-col gap-2 overflow-y-auto lg:max-h-[36rem]"
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
                          "flex flex-col gap-3 rounded-xl border p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "border-primary/40 bg-card shadow-sm"
                            : "border-transparent hover:border-border hover:bg-card/60",
                        )}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-2.5">
                            <span
                              aria-hidden="true"
                              className={cn(
                                "grid size-8 shrink-0 place-items-center rounded-lg text-xs font-semibold uppercase",
                                active
                                  ? "bg-primary/10 text-primary"
                                  : "bg-muted text-muted-foreground",
                              )}
                            >
                              {account.username.slice(0, 2)}
                            </span>
                            <span className="min-w-0">
                              <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                                <PresenceDot lastSeenAt={account.lastSeenAt} />
                                <span className="truncate">{account.username}</span>
                              </span>
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {account.email}
                              </span>
                            </span>
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {formatUsd(account.rangeTotalUsd)}
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
                className="rounded-lg border-t border-border/60 px-3 py-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                  <div className="flex flex-wrap items-end justify-between gap-4">
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
                        <PresenceDot lastSeenAt={selectedAccount.lastSeenAt} className="size-2.5" />
                      </div>
                      <p className="break-all text-xs text-muted-foreground">
                        {selectedAccount.email}
                      </p>
                      <RoleSelect
                        key={selectedAccount.id}
                        userId={selectedAccount.id}
                        role={selectedAccount.role}
                      />
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

                  <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/70 bg-border/70 xl:grid-cols-4">
                    {[
                      { label: `${windowDays}-day spend`, usd: selectedAccount.rangeTotalUsd },
                      { label: "Video", usd: selectedAccount.rangeRenderUsd },
                      { label: "Images", usd: selectedAccount.rangeIterateUsd },
                      { label: "All-time spend", usd: selectedAccount.allTimeSpendUsd },
                    ].map((stat) => (
                      <div key={stat.label} className="min-w-0 bg-card p-4">
                        <dt className="text-[11px] text-muted-foreground">{stat.label}</dt>
                        <dd className="mt-2 text-lg font-semibold tracking-tight tabular-nums">
                          {formatUsd(stat.usd)}
                        </dd>
                      </div>
                    ))}
                  </dl>
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
          <div className="flex justify-end">
            <a
              href="/api/accounts-control/runs-csv"
              download="all-runs.csv"
              className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <DownloadIcon aria-hidden="true" className="size-3.5" />
              Export all runs CSV
            </a>
          </div>
          {runLog.rows.length === 0 ? (
            <EmptyState>No runs in this window.</EmptyState>
          ) : (
            <div className="flex flex-col gap-5">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Every recorded attempt across the team, including failures. Costs are in USD. CSV
                preview links expire after one hour.
              </p>
              <div className="overflow-hidden rounded-xl border border-border">
                <Table className="min-w-[840px]">
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>Preview</TableHead>
                      <TableHead>User email</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead className="whitespace-nowrap">Model</TableHead>
                      <TableHead numeric>Cost</TableHead>
                      <TableHead>Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runLog.rows.map((run) => (
                      <TableRow key={run.id} className="align-top">
                        <TableCell className="py-4">
                          <div className="h-24 w-14 overflow-hidden rounded-md bg-muted">
                            <BinThumbnail
                              thumbnail={run.thumbnail}
                              itemLabel={`Output of ${run.model}`}
                              badge="—"
                            />
                          </div>
                        </TableCell>
                        <TableCell className="min-w-36 break-words py-4 font-medium">
                          {run.userId ? (runEmailByUserId.get(run.userId) ?? "—") : "—"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap py-4 text-xs">
                          {run.provider}
                        </TableCell>
                        <TableCell className="max-w-64 break-words py-4 text-xs">
                          <span className="inline-block rounded-md bg-muted px-2 py-1">
                            {run.model}
                          </span>
                        </TableCell>
                        <TableCell numeric className="py-4">
                          {run.costUsd !== null ? (
                            <span className="block font-medium">{formatUsd(run.costUsd)}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">Not billed</span>
                          )}
                        </TableCell>
                        <TableCell className="max-w-sm break-words py-4 text-xs leading-relaxed text-destructive">
                          {run.error ?? "—"}
                        </TableCell>
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
