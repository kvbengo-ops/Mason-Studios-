"use client";

// The generated-image GALLERY.
//
// This used to be a list of cards: a bordered box per image, its timestamp
// under it and two buttons under that. It read as a table of records rather
// than a wall of pictures, and on a 9:16 output the chrome around each tile
// was taller than the gap between them.
//
// So the pictures are the page now — a dense, edge-to-edge grid with every
// control hidden until the tile is hovered or focused. Nothing was removed:
// download, save-to-elements and delete are all still here, one press each
// instead of two through a dropdown, and the timestamp still reads out of the
// tile (visually on hover, to a screen reader always).
//
// HOVER IS NEVER THE ONLY WAY IN. The overlay opens on `group-hover` AND on
// `group-focus-within`, and below `md` it is simply always on — a touch device
// has no hover state, and controls that need one would be unreachable there.

import { useState } from "react";
import { Copy, Download, FileText, Info, ListChecks, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { JSX } from "react";
import type { GeneratedImage, GeneratedImageDetails } from "@/actions/image-generator";
import { PendingButton } from "@/components/pending-button";
import { useAsyncAction } from "@/components/use-async-action";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { dateTimeFormatter } from "@/lib/datetime";
import { SaveGeneratedElementButton } from "@/components/save-generated-element-button";
import { ImageLightbox } from "@/components/image-lightbox";
import { IMAGE_ASSET_KINDS } from "@/lib/asset-kinds";
import { tagsInOrder } from "@/lib/element-tags";
import { findElementByTag, type ElementTag } from "@/lib/elements";
import { cn } from "@/lib/utils";
import {
  nearestImageAspectRatio,
  requestImageReuse,
  GENERATED_IMAGE_DRAG_TYPE,
} from "@/lib/image-reuse";
import { DEFAULT_TILE_RATIO, WALL_CLASS, tileBox } from "@/lib/tile-box";
import { CreationLoading } from "@/components/creation-loading";
import { useImageAttempts } from "@/components/image-attempt-panel";
import { isImageAttemptUnfinished } from "@/lib/image-attempt";

export interface ImageHistoryCursor {
  createdAt: string;
  assetId: string;
}

export interface ImageHistoryPage {
  images: GeneratedImage[];
  nextCursor: ImageHistoryCursor | null;
}

export interface ImageGeneratorHistoryProps {
  initialPage: ImageHistoryPage;
  loadMoreAction: (cursor: ImageHistoryCursor) => Promise<ImageHistoryPage>;
  downloadAction: (assetId: string) => Promise<string>;
  deleteAction?: (assetId: string) => Promise<void>;
  /** The prompt and model an image was made from; a null field was never recorded. */
  detailsAction: (assetId: string) => Promise<GeneratedImageDetails>;
  /** The owner's @tag library, to show what the prompt's tags point at. */
  elements: readonly ElementTag[];
}

/** One action in the viewer's side panel. */
const PANEL_BUTTON =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-muted/60 px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

/** One round control on a tile. Legible on any picture, in any theme. */
const TILE_BUTTON =
  "grid size-8 place-items-center rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

function DownloadTileButton({
  assetId,
  action,
  onError,
  panel = false,
}: {
  assetId: string;
  action: (assetId: string) => Promise<string>;
  onError: (message: string | null) => void;
  panel?: boolean;
}): JSX.Element {
  const { pending, run } = useAsyncAction();
  return (
    <button
      type="button"
      className={panel ? cn(PANEL_BUTTON, "flex-1") : TILE_BUTTON}
      aria-label="Download image"
      title="Download"
      disabled={pending}
      onClick={() =>
        run(async () => {
          onError(null);
          try {
            const url = await action(assetId);
            // The server requests Content-Disposition: attachment. An HTML
            // download attribute alone is ignored for cross-origin storage URLs.
            window.location.assign(url);
          } catch {
            onError("The download link could not be created. Try again.");
          }
        })
      }
    >
      <Download className="size-4" aria-hidden="true" />
      {panel ? "Download" : null}
    </button>
  );
}

function DeleteTileButton({
  assetId,
  action,
  panel = false,
}: {
  assetId: string;
  action: (assetId: string) => Promise<void>;
  panel?: boolean;
}): JSX.Element {
  const { pending, run } = useAsyncAction();
  const [open, setOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function handleDelete(): void {
    run(async () => {
      setErrorMessage(null);
      try {
        await action(assetId);
        setOpen(false);
        window.location.reload();
      } catch {
        setErrorMessage("The image could not be deleted. Try again.");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        className={panel ? cn(PANEL_BUTTON, "w-10 px-0") : TILE_BUTTON}
        aria-label="Delete image"
        title="Delete"
        disabled={pending}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </button>
      <Dialog open={open} onOpenChange={(nextOpen) => !pending && setOpen(nextOpen)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this generated image?</DialogTitle>
            <DialogDescription>
              This moves the image to Bin. You can restore it there or delete it permanently.
            </DialogDescription>
          </DialogHeader>
          {errorMessage ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <PendingButton variant="destructive" onClick={handleDelete} pending={pending}>
              Delete
            </PendingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A prompt longer than this is clamped behind "See all". */
const PROMPT_CLAMP_CHARS = 280;

/**
 * The viewer's side panel: prompt, details, actions. `details` is undefined
 * while loading; `prompt` is null for an image made before 0116.
 */
function ImageDetails({
  image,
  details,
  size,
  elements,
  downloadAction,
  deleteAction,
  onReuse,
  thumbSize,
}: {
  /** The tile's thumbnail size: a stand-in for the ratio until the full picture loads. */
  thumbSize: { width: number; height: number } | null;
  /** Closes the viewer after Reuse, so the bar it filled is in view. */
  onReuse: () => void;
  image: GeneratedImage;
  details: GeneratedImageDetails | undefined;
  size: { width: number; height: number } | null;
  elements: readonly ElementTag[];
  downloadAction: (assetId: string) => Promise<string>;
  deleteAction?: (assetId: string) => Promise<void>;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const prompt = details?.prompt ?? null;
  const tags = prompt ? tagsInOrder(prompt) : [];
  const long = !!prompt && prompt.length > PROMPT_CLAMP_CHARS;

  function copyPrompt(): void {
    if (!prompt) return;
    navigator.clipboard.writeText(prompt).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setErrorMessage("The prompt could not be copied."),
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <section className="flex flex-col gap-3 rounded-xl bg-muted/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 font-sans text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <FileText aria-hidden="true" className="size-3.5" />
              Prompt
            </h3>
            {prompt ? (
              <button
                type="button"
                onClick={copyPrompt}
                className="inline-flex h-7 items-center gap-1 rounded-md bg-muted px-2 text-xs font-medium transition-colors hover:bg-muted/70"
              >
                <Copy aria-hidden="true" className="size-3" />
                {copied ? "Copied" : "Copy"}
              </button>
            ) : null}
          </div>

          {tags.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                // Matched by name against the library as it is NOW: a renamed or
                // deleted element shows as missing rather than as what it was.
                const element = findElementByTag(elements, tag);
                return (
                  <li key={tag} title={element ? `@${element.name}` : `@${tag} — not in library`}>
                    {element && IMAGE_ASSET_KINDS.has(element.assetKind) ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed image URL
                      <img
                        src={element.previewUrl}
                        alt={`@${element.name}`}
                        className="size-14 rounded-lg bg-muted object-cover ring-2 ring-primary/70"
                      />
                    ) : (
                      <span className="grid size-14 place-items-center rounded-lg bg-muted px-1 text-center text-[10px] text-muted-foreground">
                        @{tag}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {details === undefined ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : prompt ? (
            <div className="flex flex-col gap-1">
              <p
                className={cn(
                  "whitespace-pre-wrap break-words text-sm leading-relaxed",
                  long && !expanded && "line-clamp-6",
                )}
              >
                {prompt}
              </p>
              {long ? (
                <button
                  type="button"
                  onClick={() => setExpanded((value) => !value)}
                  className="self-start text-xs text-muted-foreground hover:text-foreground"
                >
                  {expanded ? "Show less" : "See all"}
                </button>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No prompt was recorded for this image.</p>
          )}
        </section>

        <section className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3">
          <h3 className="flex items-center gap-1.5 font-sans text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <Info aria-hidden="true" className="size-3.5" />
            Details
          </h3>
          <dl className="flex flex-col gap-1.5 text-xs">
            {[
              ["Model", details?.model],
              ["Size", size ? `${size.width}x${size.height}` : null],
              ["Created", dateTimeFormatter.format(new Date(image.createdAt))],
            ].map(([label, value]) =>
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
        {errorMessage ? (
          <p role="alert" className="text-xs text-destructive">
            {errorMessage}
          </p>
        ) : null}
        {prompt ? (
          <button
            type="button"
            onClick={() => {
              requestImageReuse({
                prompt,
                modelId: details?.modelId ?? null,
                aspectRatio: (() => {
                  const known = size ?? thumbSize;
                  return known ? nearestImageAspectRatio(known.width, known.height) : null;
                })(),
              });
              onReuse();
            }}
            className={cn(PANEL_BUTTON, "w-full")}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Reuse prompt and settings
          </button>
        ) : null}
        <div className="flex gap-2">
          <SaveGeneratedElementButton
            assetId={image.assetId}
            renderTrigger={(openSaveDialog) => (
              <button type="button" className={cn(PANEL_BUTTON, "flex-1")} onClick={openSaveDialog}>
                <Plus className="size-4" aria-hidden="true" />
                Save as element
              </button>
            )}
          />
          <DownloadTileButton
            assetId={image.assetId}
            action={downloadAction}
            onError={setErrorMessage}
            panel
          />
          {deleteAction ? (
            <DeleteTileButton assetId={image.assetId} action={deleteAction} panel />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ImageTile({
  image,
  downloadAction,
  deleteAction,
  detailsAction,
  elements,
  fresh = false,
  selecting = false,
  selected = false,
  onToggle,
}: {
  image: GeneratedImage;
  downloadAction: (assetId: string) => Promise<string>;
  deleteAction?: (assetId: string) => Promise<void>;
  detailsAction: (assetId: string) => Promise<GeneratedImageDetails>;
  elements: readonly ElementTag[];
  /** Just finished on this page: show the placeholder until the thumbnail loads. */
  fresh?: boolean;
  /** Select mode: the tile toggles instead of opening, and its controls hide. */
  selecting?: boolean;
  selected?: boolean;
  onToggle?: () => void;
}): JSX.Element {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [details, setDetails] = useState<GeneratedImageDetails | undefined>(undefined);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  // From the tile's own thumbnail, which now keeps the picture's shape — so
  // the badge is right before the viewer is ever opened.
  const [thumbSize, setThumbSize] = useState<{ width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const ratio = thumbSize ? nearestImageAspectRatio(thumbSize.width, thumbSize.height) : null;

  function loadDetails(): void {
    if (details !== undefined) return;
    detailsAction(image.assetId).then(setDetails, () =>
      setDetails({ prompt: null, model: null, modelId: null, url: null }),
    );
  }

  return (
    <li
      className={cn(
        "group relative overflow-hidden bg-muted/60 transition-[opacity,transform]",
        dragging && "scale-95 opacity-40",
      )}
      style={tileBox(thumbSize ? thumbSize.width / thumbSize.height : DEFAULT_TILE_RATIO)}
      onDragEnd={() => setDragging(false)}
      // Drag onto the prompt bar to reference this picture (image-generator-form).
      draggable={!selecting}
      onDragStart={(event) => {
        event.dataTransfer.setData(GENERATED_IMAGE_DRAG_TYPE, image.assetId);
        event.dataTransfer.effectAllowed = "copy";
        setDragging(true);
      }}
    >
      <ImageLightbox
        src={image.url}
        alt={`Generated image from ${dateTimeFormatter.format(new Date(image.createdAt))}`}
        className="h-full w-full scale-110 object-cover transition-transform duration-500"
        showIcon={false}
        onOpen={loadDetails}
        fullSrc={details?.url ?? undefined}
        onFullSize={setSize}
        onThumbSize={setThumbSize}
        aside={(close) => (
          <ImageDetails
            image={image}
            details={details}
            size={size}
            thumbSize={thumbSize}
            elements={elements}
            downloadAction={downloadAction}
            deleteAction={deleteAction}
            onReuse={close}
          />
        )}
      />

      {selecting ? (
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={selected}
          aria-label={`${selected ? "Deselect" : "Select"} image from ${dateTimeFormatter.format(new Date(image.createdAt))}`}
          className={cn(
            "absolute inset-0 z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            selected && "ring-4 ring-inset ring-primary",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute left-2 top-2 grid size-6 place-items-center rounded-md border-2 text-xs font-bold",
              selected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-white/80 bg-black/30",
            )}
          >
            {selected ? "✓" : ""}
          </span>
        </button>
      ) : null}

      {fresh && !thumbSize ? (
        <div className="pointer-events-none absolute inset-0 bg-background/70 backdrop-blur-[2px]">
          <CreationLoading kind="image" status="Generating" />
        </div>
      ) : null}

      {ratio ? (
        <span
          aria-label={`Aspect ratio ${ratio}`}
          className="pointer-events-none absolute left-2 top-2 rounded-md bg-background/80 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-foreground backdrop-blur-sm"
        >
          {ratio}
        </span>
      ) : null}

      {/* Pointer-events-none on the wash so the picture underneath stays
          clickable; the control rail opts back in for itself. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/55 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100"
      />

      <div
        className={cn(
          "pointer-events-auto absolute right-2 top-2 flex flex-col gap-1.5",
          // Always visible where there is no hover to rely on.
          "md:opacity-0 md:transition-opacity md:duration-200 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
        )}
      >
        <button
          type="button"
          className={TILE_BUTTON}
          aria-label="Reuse prompt and settings"
          title="Reuse prompt"
          onClick={() => {
            // The prompt is not on the tile; same read the viewer makes on open.
            const loaded = details
              ? Promise.resolve(details)
              : detailsAction(image.assetId).then((d) => (setDetails(d), d));
            loaded.then(
              (d) =>
                d.prompt
                  ? requestImageReuse({ prompt: d.prompt, modelId: d.modelId, aspectRatio: ratio })
                  : setErrorMessage("No prompt was recorded for this image."),
              () => setErrorMessage("The prompt could not be loaded."),
            );
          }}
        >
          <RotateCcw className="size-4" aria-hidden="true" />
        </button>
        <DownloadTileButton
          assetId={image.assetId}
          action={downloadAction}
          onError={setErrorMessage}
        />
        <SaveGeneratedElementButton
          assetId={image.assetId}
          renderTrigger={(openSaveDialog) => (
            <button
              type="button"
              className={TILE_BUTTON}
              aria-label="Save image to elements"
              title="Save to elements"
              onClick={openSaveDialog}
            >
              <Plus className="size-4" aria-hidden="true" />
            </button>
          )}
        />
        {deleteAction ? <DeleteTileButton assetId={image.assetId} action={deleteAction} /> : null}
      </div>

      <time
        dateTime={image.createdAt}
        className="absolute bottom-2 left-2 rounded-full bg-background/80 px-2 py-0.5 text-[11px] text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {dateTimeFormatter.format(new Date(image.createdAt))}
      </time>

      {errorMessage ? (
        <p
          role="alert"
          className="absolute inset-x-2 bottom-2 rounded-md bg-destructive px-2 py-1 text-[11px] text-destructive-foreground"
        >
          {errorMessage}
        </p>
      ) : null}
    </li>
  );
}

// Run ids seen unfinished in this tab. Module scope, not a ref: the page
// remounts the history (its key) the moment the new image lands, which is
// exactly when this is read.
// ponytail: grows by one id per generation, cleared on reload.
const seenRunning = new Set<string>();

export function ImageGeneratorHistory({
  initialPage,
  loadMoreAction,
  downloadAction,
  deleteAction,
  detailsAction,
  elements,
}: ImageGeneratorHistoryProps): JSX.Element {
  const { pending, run } = useAsyncAction();
  const [olderImages, setOlderImages] = useState<GeneratedImage[]>([]);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Keep the first page in props so a server refresh also refreshes its signed
  // thumbnail URLs. The page remounts this component if those first rows change.
  const images = [...initialPage.images, ...olderImages];
  // Select mode: tiles toggle, and the toolbar moves the selection to Bin
  // (restorable for 3 days, like deleting one).
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const { pending: moving, run: runMove } = useAsyncAction();
  const stopSelecting = (): void => {
    setSelecting(false);
    setSelected(new Set());
    setConfirming(false);
  };
  const toggle = (assetId: string): void =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  function moveToBin(): void {
    if (!deleteAction) return;
    const ids = [...selected];
    runMove(async () => {
      let failed = 0;
      for (const id of ids) {
        try {
          await deleteAction(id);
        } catch {
          failed++;
        }
      }
      // Same as deleting one image: reload so the first page's server-rendered
      // tiles drop the moved images too.
      if (failed > 0) window.alert(`${failed} could not be moved to Bin. The rest were.`);
      window.location.reload();
    });
  }
  // One placeholder per image still drawing, first on the wall, so a press is
  // visible at once and several can run side by side. Read from the Runs
  // panel's attempts, so it survives leaving the page and coming back.
  //
  // A placeholder hands over to its picture without a blank frame: it stays
  // until the refresh puts the image on the wall, and that image's tile keeps
  // the spinner until its thumbnail has loaded. Only attempts seen running on
  // this page count, so an old finished attempt never conjures a spinner.
  const onWall = new Set(images.map((image) => image.assetId));
  const attempts = useImageAttempts();
  for (const attempt of attempts) {
    if (isImageAttemptUnfinished(attempt.status)) seenRunning.add(attempt.runId);
  }
  const fresh = new Set(
    attempts.flatMap((attempt) =>
      seenRunning.has(attempt.runId) && attempt.image ? [attempt.image.assetId] : [],
    ),
  );
  const rendering = attempts.filter(
    (attempt) =>
      isImageAttemptUnfinished(attempt.status) ||
      (seenRunning.has(attempt.runId) && attempt.image && !onWall.has(attempt.image.assetId)),
  );

  function handleLoadMore(): void {
    if (!nextCursor) return;
    const cursor = nextCursor;
    run(async () => {
      setErrorMessage(null);
      try {
        const page = await loadMoreAction(cursor);
        setOlderImages((previous) => [...previous, ...page.images]);
        setNextCursor(page.nextCursor);
      } catch {
        setErrorMessage("More images could not be loaded. Try again.");
      }
    });
  }

  return (
    <section aria-labelledby="image-history-heading" className="flex flex-1 flex-col">
      <h2 id="image-history-heading" className="sr-only">
        Image history
      </h2>

      {deleteAction && images.length > 0 ? (
        selecting ? (
          <div
            role="toolbar"
            aria-label="Selected images"
            className="sticky top-0 z-20 mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/95 px-3 py-2 backdrop-blur"
          >
            <span className="text-sm font-medium tabular-nums" aria-live="polite">
              {selected.size} selected
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={moving}
              onClick={() => setSelected(new Set(images.map((image) => image.assetId)))}
            >
              Select all
            </Button>
            {selected.size > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={moving}
                onClick={() => setSelected(new Set())}
              >
                Clear
              </Button>
            ) : null}
            <span className="flex-1" />
            <PendingButton
              type="button"
              variant="outline"
              size="sm"
              pending={moving}
              disabled={selected.size === 0}
              onClick={() => (confirming ? moveToBin() : setConfirming(true))}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {confirming
                ? `Confirm: move ${selected.size} to Bin`
                : `Move ${selected.size} to Bin`}
            </PendingButton>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={moving}
              onClick={stopSelecting}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex justify-end px-1 pb-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Select images"
              title="Select"
              onClick={() => setSelecting(true)}
            >
              <ListChecks aria-hidden="true" className="size-4" />
            </Button>
          </div>
        )
      ) : null}

      {images.length === 0 && rendering.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-24 text-center">
          <p className="text-base font-medium text-foreground">Nothing generated yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Describe a scene in the prompt bar below and your images will fill this wall.
          </p>
        </div>
      ) : (
        /* JUSTIFIED ROWS: every row the same height, each tile as wide as its
           picture's own shape, so a 16:9 reads wide and a 9:16 reads tall and
           nothing is cropped beyond the few pixels that fill a row. The
           trailing ::after soaks up the last row's spare width so a lone
           picture is not stretched across the page. Newest first, left to
           right. */
        <ul className={WALL_CLASS} aria-busy={pending}>
          {rendering.map((attempt) => (
            <li
              key={attempt.runId}
              className="relative isolate overflow-hidden border border-border bg-card"
              style={tileBox(DEFAULT_TILE_RATIO)}
            >
              <CreationLoading
                kind="image"
                status={attempt.status === "queued" ? "Queued" : "Generating"}
              />
            </li>
          ))}
          {images.map((image) => (
            <ImageTile
              key={image.assetId}
              image={image}
              downloadAction={downloadAction}
              deleteAction={deleteAction}
              detailsAction={detailsAction}
              elements={elements}
              fresh={fresh.has(image.assetId)}
              selecting={selecting}
              selected={selected.has(image.assetId)}
              onToggle={() => toggle(image.assetId)}
            />
          ))}
        </ul>
      )}

      {errorMessage ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}

      {nextCursor ? (
        <div className="flex justify-center p-4">
          <PendingButton type="button" variant="outline" pending={pending} onClick={handleLoadMore}>
            Load More
          </PendingButton>
        </div>
      ) : null}
    </section>
  );
}
