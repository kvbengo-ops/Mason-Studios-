"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { JSX } from "react";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import {
  Copy,
  Download,
  FolderPlus,
  Link2,
  MusicIcon,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { shareClipLink } from "@/actions/clip-actions";
import { deleteClipScene, deleteClipVersion, regenerateClip } from "@/actions/ugc";
import {
  MoveClipDialog,
  SaveClipDialog,
  type ClipProjectOption,
} from "@/components/clip-tile-dialogs";
import { CreationLoading } from "@/components/creation-loading";
import { PendingButton } from "@/components/pending-button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { formatAverageBitrate } from "@/lib/average-bitrate";
import { dateTimeFormatter } from "@/lib/datetime";
import { asAttachment } from "@/lib/download-url";
import { findElementByTag, type ElementTag } from "@/lib/elements";
import { DEFAULT_TILE_RATIO, WALL_CLASS, tileBox } from "@/lib/tile-box";
import { requestVideoIterate } from "@/lib/video-iterate";
import { cn } from "@/lib/utils";

/** One tile on /create's Video wall. A finished clip is a TAKE. */
export type WallItem =
  | {
      kind: "clip";
      key: string;
      sceneId: string;
      versionId: string;
      projectId: string;
      projectTitle: string;
      /** The hidden personal project: there is nothing to open. */
      personal: boolean;
      prompt: string;
      /** Picker label, for the details card. */
      modelLabel: string | null;
      modelId: string | null;
      resolution: string | null;
      durationS: number | null;
      createdAt: string;
      url: string;
      filename: string;
      referenceTags: string[];
      /** How Delete is done: a version if its scene has others, else the scene; null if neither is allowed. */
      deleteMode: "version" | "scene" | null;
    }
  | { kind: "rendering"; key: string; prompt: string; queued: boolean }
  | { kind: "failed"; key: string; sceneId: string; prompt: string };

const TILE_BUTTON =
  "grid size-8 place-items-center rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Refills the prompt bar from a take — the viewer's Iterate, also on the tile. */
function iterateOn(item: WallItem & { kind: "clip" }): void {
  requestVideoIterate({
    prompt: item.prompt,
    referenceTags: item.referenceTags,
    modelId: item.modelId,
    resolution: item.resolution,
    durationS: item.durationS,
  });
}

const PANEL_BUTTON =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-muted/60 px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

export function CreateClipWall({
  items,
  projects,
  initialVersionId,
  elements = [],
}: {
  items: readonly WallItem[];
  /** The caller's own clip projects, for Add to project. */
  projects: readonly ClipProjectOption[];
  initialVersionId?: string | null;
  /** The caller's saved Elements, so the viewer can show a take's references as thumbnails. */
  elements?: readonly ElementTag[];
}): JSX.Element {
  const [openKey, setOpenKey] = useState<string | null>(initialVersionId ?? null);
  const open = items.find((item) => item.kind === "clip" && item.key === openKey) ?? null;
  // Select mode: tiles toggle instead of opening, and the toolbar moves the
  // selected takes to Bin (restorable for 3 days, like deleting one).
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const deletable = items.filter(
    (item): item is WallItem & { kind: "clip" } => item.kind === "clip" && item.deleteMode !== null,
  );
  const toggle = (key: string): void =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const stopSelecting = (): void => {
    setSelecting(false);
    setSelected(new Set());
  };

  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-24 text-center">
        <p className="text-base font-medium text-foreground">No clips yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Describe a scene in the bar below and your clips will fill this wall.
        </p>
      </div>
    );
  }

  return (
    <>
      {deletable.length > 0 ? (
        <BulkBinBar
          selecting={selecting}
          selected={deletable.filter((item) => selected.has(item.key))}
          allItems={items}
          onStart={() => setSelecting(true)}
          onSelectAll={() => setSelected(new Set(deletable.map((item) => item.key)))}
          onClear={() => setSelected(new Set())}
          onDone={stopSelecting}
        />
      ) : null}
      <ul className={WALL_CLASS}>
        {items.map((item) =>
          item.kind === "clip" ? (
            <ClipTile
              key={item.key}
              item={item}
              projects={projects}
              onOpen={() => setOpenKey(item.key)}
              selecting={selecting && item.deleteMode !== null}
              selected={selected.has(item.key)}
              onToggle={() => toggle(item.key)}
            />
          ) : (
            <li
              key={item.key}
              className={
                item.kind === "rendering"
                  ? "relative isolate overflow-hidden border border-border bg-card"
                  : "flex flex-col items-center justify-center gap-2 bg-muted p-3 text-center text-muted-foreground"
              }
              style={tileBox(DEFAULT_TILE_RATIO)}
            >
              {item.kind === "rendering" ? (
                <CreationLoading kind="video" status={item.queued ? "Queued" : "Rendering"} />
              ) : (
                <>
                  <FailedTile item={item} />
                  <p className="line-clamp-3 text-[11px]">{item.prompt}</p>
                </>
              )}
            </li>
          ),
        )}
      </ul>

      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpenKey(null)}>
        <DialogContent className="flex h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none flex-col gap-2 overflow-hidden p-2 sm:max-w-none md:flex-row">
          <DialogTitle className="sr-only">Clip</DialogTitle>
          {open && open.kind === "clip" ? (
            <ClipViewer item={open} elements={elements} onClose={() => setOpenKey(null)} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Select mode's toolbar. Moving to Bin reuses the one-take actions: a scene
 * whose every take is selected goes as a scene (deleteClipScene), otherwise
 * each selected take goes as a version, so the last take is never left as an
 * orphaned version delete.
 */
function BulkBinBar({
  selecting,
  selected,
  allItems,
  onStart,
  onSelectAll,
  onClear,
  onDone,
}: {
  selecting: boolean;
  selected: readonly (WallItem & { kind: "clip" })[];
  allItems: readonly WallItem[];
  onStart: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  onDone: () => void;
}): JSX.Element {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);

  function moveToBin(): void {
    start(async () => {
      const takesPerScene = new Map<string, number>();
      for (const item of allItems) {
        if (item.kind === "clip") {
          takesPerScene.set(item.sceneId, (takesPerScene.get(item.sceneId) ?? 0) + 1);
        }
      }
      const byScene = new Map<string, (WallItem & { kind: "clip" })[]>();
      for (const item of selected) {
        byScene.set(item.sceneId, [...(byScene.get(item.sceneId) ?? []), item]);
      }
      let failed = 0;
      for (const [sceneId, takes] of byScene) {
        const wholeScene = takes.length >= (takesPerScene.get(sceneId) ?? 0);
        const jobs = wholeScene ? [null] : takes;
        for (const take of jobs) {
          try {
            const formData = new FormData();
            formData.set("sceneId", sceneId);
            if (take) formData.set("versionId", take.versionId);
            const result = take
              ? await deleteClipVersion(formData)
              : await deleteClipScene(formData);
            if (result?.error) failed++;
          } catch (error) {
            unstable_rethrow(error);
            failed++;
          }
        }
      }
      const moved = selected.length;
      if (failed > 0) toast.error(`${failed} could not be moved to Bin. The rest were.`);
      else toast(`${moved} moved to Bin. Restore them from Bin within 3 days.`);
      setConfirming(false);
      onDone();
      router.refresh();
    });
  }

  if (!selecting) {
    return (
      <div className="flex justify-end px-1 pb-2">
        <button type="button" onClick={onStart} className={PANEL_BUTTON}>
          Select
        </button>
      </div>
    );
  }

  return (
    <div
      role="toolbar"
      aria-label="Selected clips"
      className="sticky top-0 z-20 mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/95 px-3 py-2 backdrop-blur"
    >
      <span className="text-sm font-medium tabular-nums" aria-live="polite">
        {selected.length} selected
      </span>
      <button type="button" onClick={onSelectAll} disabled={pending} className={PANEL_BUTTON}>
        Select all
      </button>
      {selected.length > 0 ? (
        <button type="button" onClick={onClear} disabled={pending} className={PANEL_BUTTON}>
          Clear
        </button>
      ) : null}
      <span className="flex-1" />
      <PendingButton
        type="button"
        variant="outline"
        pending={pending}
        disabled={selected.length === 0}
        onClick={() => (confirming ? moveToBin() : setConfirming(true))}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        {confirming ? `Confirm: move ${selected.length} to Bin` : `Move ${selected.length} to Bin`}
      </PendingButton>
      <button type="button" onClick={onDone} disabled={pending} className={PANEL_BUTTON}>
        Cancel
      </button>
    </div>
  );
}

function ClipTile({
  item,
  projects,
  onOpen,
  selecting = false,
  selected = false,
  onToggle,
}: {
  item: WallItem & { kind: "clip" };
  projects: readonly ClipProjectOption[];
  onOpen: () => void;
  selecting?: boolean;
  selected?: boolean;
  onToggle?: () => void;
}) {
  // The clip's own shape, once its metadata is in — same idea as the image wall.
  const [ratio, setRatio] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [dialog, setDialog] = useState<"save" | "move" | null>(null);

  async function share(): Promise<void> {
    try {
      const result = await shareClipLink(item.sceneId, item.versionId);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      await navigator.clipboard.writeText(result.url);
      toast("Link copied. It works for 7 days.");
    } catch (error) {
      unstable_rethrow(error);
      toast.error("Could not copy a link. Try again.");
    }
  }

  return (
    <li
      className="group relative overflow-hidden bg-muted/60"
      style={tileBox(ratio ?? DEFAULT_TILE_RATIO)}
      // Plays muted while hovered, back to the poster frame on leave.
      onMouseEnter={() => void videoRef.current?.play().catch(() => {})}
      onMouseLeave={() => {
        const video = videoRef.current;
        if (!video) return;
        video.pause();
        video.currentTime = 0.1;
      }}
    >
      {selecting ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute left-2 top-2 z-10 grid size-6 place-items-center rounded-md border-2 text-xs font-bold",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-white/80 bg-black/30",
          )}
        >
          {selected ? "✓" : ""}
        </span>
      ) : null}
      <button
        type="button"
        onClick={selecting ? onToggle : onOpen}
        aria-pressed={selecting ? selected : undefined}
        aria-label={`${selecting ? (selected ? "Deselect" : "Select") : "Open"} clip: ${item.prompt.slice(0, 60)}`}
        className="block h-full w-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {/* #t=0.1 makes the browser paint a frame instead of black. */}
        <video
          ref={videoRef}
          src={`${item.url}#t=0.1`}
          muted
          loop
          playsInline
          preload="metadata"
          onLoadedMetadata={(event) => {
            const { videoWidth, videoHeight } = event.currentTarget;
            if (videoWidth > 0 && videoHeight > 0) setRatio(videoWidth / videoHeight);
          }}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
        />
      </button>
      <div className="absolute right-2 top-2 flex flex-col gap-1.5 md:opacity-0 md:transition-opacity md:duration-200 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
        <button
          type="button"
          className={TILE_BUTTON}
          aria-label="Reuse prompt and settings"
          title="Reuse prompt"
          onClick={() => iterateOn(item)}
        >
          <RotateCcw className="size-4" aria-hidden="true" />
        </button>
        <a
          href={asAttachment(item.url, item.filename)}
          download={item.filename}
          className={TILE_BUTTON}
          aria-label="Download clip"
          title="Download"
        >
          <Download className="size-4" aria-hidden="true" />
        </a>
        <button
          type="button"
          className={TILE_BUTTON}
          aria-label="Save clip to elements"
          title="Save to elements"
          onClick={() => setDialog("save")}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={TILE_BUTTON}
          aria-label="Copy a share link"
          title="Share"
          onClick={() => void share()}
        >
          <Link2 className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={TILE_BUTTON}
          aria-label="Add clip to a project"
          title="Add to project"
          onClick={() => setDialog("move")}
        >
          <FolderPlus className="size-4" aria-hidden="true" />
        </button>
      </div>
      <SaveClipDialog item={item} open={dialog === "save"} onClose={() => setDialog(null)} />
      <MoveClipDialog
        item={item}
        projects={projects}
        open={dialog === "move"}
        onClose={() => setDialog(null)}
      />
      <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-background/80 px-2 py-0.5 font-mono text-[11px] tabular-nums text-foreground backdrop-blur-sm">
        {item.durationS ? `0:${String(Math.round(item.durationS)).padStart(2, "0")}` : "clip"}
      </span>
    </li>
  );
}

function FailedTile({ item }: { item: WallItem & { kind: "failed" } }): JSX.Element {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <>
      <span className="text-xs font-medium text-destructive">Failed</span>
      {/* Same scene, same prompt, same settings: regenerateClip keeps the
          scene's model, duration and references when the form omits them,
          and routes a failed scene through retryScene. */}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const formData = new FormData();
            formData.set("sceneId", item.sceneId);
            formData.set("prompt", item.prompt);
            const result = await regenerateClip(formData);
            if (result && "error" in result && result.error) toast.error(result.error);
            router.refresh();
          })
        }
        className="text-[11px] underline underline-offset-2 disabled:opacity-50"
      >
        Retry
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const formData = new FormData();
            formData.set("sceneId", item.sceneId);
            await deleteClipScene(formData);
            router.refresh();
          })
        }
        className="text-[11px] underline underline-offset-2 disabled:opacity-50"
      >
        Remove
      </button>
    </>
  );
}

/**
 * A take's references as thumbnails: picture, a video's first frame, or a
 * voice tile. Resolved against the operator's CURRENT library by tag name, so
 * a reference whose element was deleted since falls back to its @name.
 */
function ReferenceThumbs({
  tags,
  elements,
}: {
  tags: readonly string[];
  elements: readonly ElementTag[];
}): JSX.Element {
  const THUMB = "size-14 shrink-0 overflow-hidden rounded-lg border border-border bg-muted";
  return (
    <ul aria-label="References" className="flex flex-wrap gap-2">
      {tags.map((tag) => {
        const element = findElementByTag(elements, tag);
        const label = `@${tag}`;
        return (
          <li key={tag} title={label}>
            {!element ? (
              <span className="inline-flex h-7 items-center rounded-md bg-muted px-2 text-xs">
                {label}
              </span>
            ) : element.assetKind === "audio" ? (
              <span className={cn(THUMB, "grid place-items-center")}>
                <MusicIcon aria-hidden="true" className="size-5 text-muted-foreground" />
                <span className="sr-only">{label}</span>
              </span>
            ) : element.assetKind === "video_ref" ? (
              // One viewer open at a time, so a metadata-only fetch for the
              // first frame is cheap here (unlike the prompt bar's menu).
              <video
                src={element.previewUrl}
                muted
                playsInline
                preload="metadata"
                aria-label={label}
                className={cn(THUMB, "object-cover")}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- signed Storage URL
              <img src={element.previewUrl} alt={label} className={cn(THUMB, "object-cover")} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ClipViewer({
  item,
  elements,
  onClose,
}: {
  item: WallItem & { kind: "clip" };
  elements: readonly ElementTag[];
  onClose: () => void;
}): JSX.Element {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [bitrate, setBitrate] = useState<string | null>(null);

  function handleDelete(): void {
    if (!item.deleteMode) return;
    start(async () => {
      const formData = new FormData();
      formData.set("sceneId", item.sceneId);
      if (item.deleteMode === "version") formData.set("versionId", item.versionId);
      const result =
        item.deleteMode === "version"
          ? await deleteClipVersion(formData)
          : await deleteClipScene(formData);
      if (result?.error) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  const rows: [string, string | null][] = [
    ["Model", item.modelLabel],
    ["Length", item.durationS ? `${item.durationS}s` : null],
    ["Resolution", item.resolution],
    ["Size", size ? `${size.width}x${size.height}` : null],
    ["Avg. bitrate", bitrate],
    ["Created", dateTimeFormatter.format(new Date(item.createdAt))],
  ];

  return (
    <>
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-md bg-black">
        <video
          key={item.url}
          src={item.url}
          controls
          autoPlay
          loop
          playsInline
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            setSize({ width: video.videoWidth, height: video.videoHeight });
            void fetch(item.url, { method: "HEAD" })
              .then((response) => {
                const bytes = Number(response.headers.get("content-length"));
                if (response.ok) setBitrate(formatAverageBitrate(bytes, video.duration));
              })
              .catch(() => setBitrate(null));
          }}
          className="h-full w-full object-contain"
        />
      </div>
      <aside className="flex max-h-[45%] min-h-0 shrink-0 flex-col overflow-hidden rounded-xl bg-card md:max-h-none md:w-[22rem]">
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          <section className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-sans text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Prompt
              </h3>
              <button
                type="button"
                onClick={() =>
                  navigator.clipboard.writeText(item.prompt).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                }
                className="inline-flex h-7 items-center gap-1 rounded-md bg-muted px-2 text-xs font-medium transition-colors hover:bg-muted/70"
              >
                <Copy aria-hidden="true" className="size-3" />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {item.prompt || "No prompt was recorded for this take."}
            </p>
            {item.referenceTags.length > 0 ? (
              <ReferenceThumbs tags={item.referenceTags} elements={elements} />
            ) : null}
          </section>
          <section className="flex flex-col gap-1.5 rounded-xl bg-muted/40 p-3">
            <h3 className="font-sans text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Details
            </h3>
            <dl className="flex flex-col gap-1.5 text-xs">
              {rows.map(([label, value]) =>
                value ? (
                  <div key={label} className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="text-right font-medium">{value}</dd>
                  </div>
                ) : null,
              )}
            </dl>
          </section>
        </div>
        <div className="flex flex-col gap-2 border-t border-border p-3">
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => {
              iterateOn(item);
              onClose();
            }}
            className={cn(PANEL_BUTTON, "w-full")}
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            Reuse prompt
          </button>
          <div className="flex gap-2">
            <a
              href={asAttachment(item.url, item.filename)}
              download={item.filename}
              className={cn(PANEL_BUTTON, "flex-1")}
            >
              <Download aria-hidden="true" className="size-4" />
              Download
            </a>
            {!item.personal ? (
              <Link href={`/ugc/${item.projectId}?scene=${item.sceneId}`} className={PANEL_BUTTON}>
                Open project
              </Link>
            ) : null}
            {item.deleteMode ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => (confirming ? handleDelete() : setConfirming(true))}
                aria-label={confirming ? "Confirm delete" : "Delete take"}
                className={cn(PANEL_BUTTON, confirming && "bg-destructive text-white")}
              >
                <Trash2 aria-hidden="true" className="size-4" />
                {confirming ? "Confirm" : null}
              </button>
            ) : null}
          </div>
        </div>
      </aside>
    </>
  );
}
