"use client";

// The Elements Library's grid: every operator's saved @tag references, with the
// three things an owner can do to one of theirs — rename, re-describe by hand,
// and remove.
//
// SHARED SINCE 0091_shared_elements_library.sql, which is what makes this grid
// heterogeneous where it used to be uniform. Three card shapes now, and the
// difference between them is not cosmetic:
//
//   yours          @name, View, Download, Rename, Remove.
//   somebody       plain name, saved by X, View, Download, Save to my elements.
//   else's         Saving creates your own copy and leaves the original intact.
//   theirs + you   the above plus Rename and a separately-labelled Remove,
//   are an admin   because 0091 admits is_admin() on BOTH write policies.
//
// VIEW AND DOWNLOAD ARE UNGATED, on every card, for every approved account —
// that is what "shared" means here, and it is the half a permission matrix is
// easiest to get wrong in the safe-looking direction. Both are plain anchors to
// signed URLs minted server-side; the bucket stays private and no client ever
// sees a storage key.
//
// THE @ IS DROPPED ON A CARD THAT IS NOT YOURS, and that is the one piece of
// this worth arguing for. Resolution is still per-owner — `unique (user_id,
// name)` means "@lena_ref" identifies one row within one account's set — so
// typing another operator's tag into your own prompt substitutes nothing and
// the worker strips the '@' as ordinary text. Rendering "@lena_ref" on a card
// you cannot use would advertise exactly that trap, and it fails the quiet way:
// no error, just a clip that does not look like the person.
//
// The controls being absent is an affordance, never the boundary. Every
// Server Action re-checks ownership against elements.user_id (actions/elements
// .ts runs on the admin client, which has no RLS), so a hidden button and a
// forged request meet the same refusal.
//
// WHY THIS IS NOT ugc-reference-picker.tsx. That component's Elements tab is
// also a library manager, and reusing it was the first thing considered. It is
// a Dialog: 1,800 lines whose element-editing state is threaded through a
// tabbed modal built to answer "which reference do I put in this prompt?" and
// to hand a PickedReference back to a parent. This page asks nothing and hands
// back nothing — it is the library itself, not a way to pick out of it — and
// lifting ~400 lines of tab out of a working modal is a refactor of the /ugc
// reference flow, which is exactly what this change was told not to disturb.
//
// So the REUSE is where reuse costs nothing and drift would hurt: the same
// three Server Actions (actions/elements.ts), the same rows through the same
// loader (lib/element-library.ts's loadElementTags), the same accepted-file
// rules (lib/file-type.ts), the same dropzone (components/reference-dropzone
// .tsx, pointed at all three kinds via its acceptKinds prop), and the same category
// vocabulary. What is new here is a grid, which the picker has no equivalent
// of.

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  Check,
  Copy,
  Download,
  Eye,
  ImageIcon,
  Loader2,
  MoreHorizontal,
  ListChecks,
  Pencil,
  Plus,
  Share2,
  Trash2,
  VideoIcon,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";
import { ActionForm } from "@/components/action-form";
import { ElementBatchUploadDialog } from "@/components/element-batch-upload-dialog";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ElementTag } from "@/lib/elements";
import type { ElementCategory } from "@/types/db";
import { saveSharedElement } from "@/actions/save-shared-element";
import { deleteElement, updateElement } from "@/actions/elements";
import { deleteElements, shareElements } from "@/actions/element-bulk";
import { getElementLibraryUrl, loadElementLibraryPageAction } from "@/actions/element-library";
import type { ElementLibraryFilter, ElementLibraryPage } from "@/lib/element-library";
import { useAsyncAction } from "@/components/use-async-action";
import {
  formatFileSizeMB,
  MAX_REFERENCE_AUDIO_BYTES,
  MAX_REFERENCE_AUDIO_SECONDS,
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_VIDEO_BYTES,
  MIN_REFERENCE_AUDIO_SECONDS,
} from "@/lib/file-type";

/**
 * Carried over verbatim from ugc-reference-picker.tsx, and for its reason: the
 * two the UI offers since 0081 are `image` and `audio`, but rows saved before
 * it still hold character/product/location/voice and have to render a label
 * rather than `undefined`.
 */
const CATEGORY_LABEL: Record<ElementCategory, string> = {
  image: "Image",
  audio: "Audio",
  // 0093: the third kind the UI offers, alongside image and audio above.
  video: "Video",
  character: "Character",
  product: "Product",
  location: "Location",
  voice: "Voice",
};

/**
 * WHAT THE FILE IS, off `assets.kind` — never off `category`.
 *
 * ElementTag.assetKind's own doc comment is the reason this is a separate
 * question: a picture saved before 0081 is filed as "character", and deciding
 * "is this a sound?" from the label puts a PNG inside an <audio> element that
 * plays nothing.
 */
function isAudioElement(element: ElementTag): boolean {
  return element.assetKind === "audio";
}

/**
 * Same rule, same reason, for the third kind (0093_video_reference_elements
 * .sql): off `assets.kind`, never `category` — there is no pre-0093 row to
 * worry about here (video did not exist to be miscategorised), but keeping
 * both checks on the same field is what keeps them from disagreeing later.
 */
function isVideoElement(element: ElementTag): boolean {
  return element.assetKind === "video_ref";
}

/**
 * The tile inside a card: a real player for a voice (unchanged), a picture
 * for anything else pre-0093, and — new since 0093 — a muted, playsInline
 * `<video>` for a video reference, with the same onError-to-placeholder
 * fallback bin-thumbnail.tsx uses for a rendered clip in /bin.
 *
 * SPLIT OUT OF THE .map() BELOW rather than inlined, for the reason
 * bin-thumbnail.tsx's own header gives: the fallback needs `useState`, and a
 * hook cannot live inside a plain callback — only inside a component
 * function of its own, one instance per card.
 *
 * An expired signed URL otherwise shows a broken-image glyph for `<img>` or
 * leaves `<video>` looking like it is still loading forever. `onError`
 * replaces either failure with the same explicit placeholder.
 */
function ElementThumbnail({ element }: { element: ElementTag }): JSX.Element {
  const [previewFailed, setPreviewFailed] = useState(false);
  const { pending, run } = useAsyncAction();

  if (isAudioElement(element)) {
    // A real player, not an icon: the only way to tell two voice clips
    // apart is to hear them, and the card is where someone deciding which
    // to @tag is standing.
    return (
      <div className="relative flex size-full flex-col items-center justify-center gap-5 overflow-hidden bg-gradient-to-br from-violet-500/15 via-background to-sky-500/15 px-4">
        <div className="flex size-12 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm ring-1 ring-border transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none">
          <Volume2 className="size-5" aria-hidden="true" />
        </div>
        <div className="flex h-8 items-center gap-1" aria-hidden="true">
          {[3, 6, 4, 8, 5, 7, 3, 6, 4, 8, 5, 3].map((height, index) => (
            <span
              key={index}
              className="w-1 rounded-full bg-foreground/35 transition-transform duration-300 group-hover:scale-y-110 motion-reduce:transition-none"
              style={{ height: `${height * 3}px` }}
            />
          ))}
        </div>
        <audio controls preload="none" src={element.previewUrl} className="h-9 w-full max-w-64">
          Your browser cannot play this clip.
        </audio>
      </div>
    );
  }

  if (isVideoElement(element)) {
    if (previewFailed) {
      return (
        <div
          role="img"
          aria-label={`${element.name}: no preview`}
          className="flex size-full flex-col items-center justify-center gap-3 bg-gradient-to-br from-slate-500/10 to-slate-500/20 text-muted-foreground"
        >
          <span className="grid size-12 place-items-center rounded-full bg-background/90 shadow-sm ring-1 ring-border">
            <VideoIcon className="size-5" aria-hidden="true" />
          </span>
          <span className="text-xs font-medium">Preview unavailable</span>
        </div>
      );
    }
    // Metadata paints the video's first frame before playback. Native controls
    // provide the single play affordance and keep playback keyboard-accessible.
    return (
      <div className="relative size-full bg-neutral-900">
        <video
          src={element.previewUrl}
          preload="metadata"
          muted
          playsInline
          controls
          aria-label={`${element.name} video`}
          onError={() => setPreviewFailed(true)}
          className="relative size-full object-contain"
        />
      </div>
    );
  }

  // Plain <img>, not next/image — the same call every other signed-URL
  // preview here makes (ugc-reference-picker.tsx, avatar-upload.tsx, which
  // states the reason): these URLs expire and are never a static asset the
  // optimizer could cache, and loadElementTags has already asked Supabase
  // for a 320px rendition, so there is nothing left to optimize.

  if (previewFailed) {
    return (
      <div
        role="img"
        aria-label={`${element.name}: no preview`}
        className="flex size-full flex-col items-center justify-center gap-3 bg-gradient-to-br from-slate-500/10 to-slate-500/20 text-muted-foreground"
      >
        <span className="grid size-12 place-items-center rounded-full bg-background/90 shadow-sm ring-1 ring-border">
          <ImageIcon className="size-5" aria-hidden="true" />
        </span>
        <span className="text-xs font-medium">Preview unavailable</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        const opened = window.open("about:blank", "_blank");
        if (opened) opened.opener = null;
        run(async () => {
          try {
            const url = await getElementLibraryUrl(element.id, "view");
            if (opened) opened.location.href = url;
            else window.location.assign(url);
          } catch {
            opened?.close();
            toast.error("Preview could not be opened.");
          }
        });
      }}
      className="group/preview relative size-full cursor-zoom-in disabled:cursor-wait"
      aria-label={`View ${element.name}`}
    >
      <img
        src={element.previewUrl}
        alt={element.description ?? element.name}
        loading="lazy"
        decoding="async"
        onError={() => setPreviewFailed(true)}
        className="size-full object-contain transition-transform duration-500 ease-out group-hover/preview:scale-[1.025] motion-reduce:transition-none"
      />
      <span className="pointer-events-none absolute inset-x-0 bottom-0 flex translate-y-2 items-center justify-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent pb-3 pt-8 text-xs font-medium text-white opacity-0 transition-[opacity,transform] duration-200 group-hover/preview:translate-y-0 group-hover/preview:opacity-100 group-focus-visible/preview:translate-y-0 group-focus-visible/preview:opacity-100 motion-reduce:transition-none">
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Eye className="size-3.5" aria-hidden="true" />
        )}
        View preview
      </span>
    </button>
  );
}

function ElementActionsMenu({
  element,
  own,
  canEdit,
  canDelete,
  onRename,
  onRemoved,
  onShare,
}: {
  element: ElementTag;
  own: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onRename: () => void;
  onRemoved: () => void;
  /** Asks the library to confirm sharing this one element with everyone. */
  onShare: () => void;
}): JSX.Element {
  const { pending, run } = useAsyncAction();
  const [confirming, setConfirming] = useState(false);

  function handleDownload(): void {
    run(async () => {
      try {
        const url = await getElementLibraryUrl(element.id, "download");
        window.location.assign(url);
      } catch {
        toast.error("Download could not be prepared.");
      }
    });
  }

  function handleSaveCopy(): void {
    run(async () => {
      try {
        const result = await saveSharedElement(element.id);
        if (result && "error" in result) {
          toast.error(result.error);
          return;
        }
        toast.success(
          result && "notice" in result
            ? result.notice
            : `Saved to your elements as @${element.name}.`,
        );
      } catch {
        toast.error("Failed to save to your elements.");
      }
    });
  }

  function handleRemove(): void {
    run(async () => {
      const formData = new FormData();
      formData.set("elementId", element.id);
      try {
        const result = await deleteElement(formData);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        setConfirming(false);
        onRemoved();
      } catch {
        toast.error("Failed to remove that reference.");
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="secondary"
            disabled={pending}
            aria-label={`Actions for ${element.name}`}
            title="More actions"
            className="absolute right-2 top-2 z-10 size-8 rounded-full border border-white/20 bg-background/85 shadow-md backdrop-blur-sm transition-[transform,background-color] hover:scale-105 hover:bg-background active:scale-95 motion-reduce:transition-none"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <MoreHorizontal className="size-4" aria-hidden="true" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {!own ? (
            <DropdownMenuItem disabled={pending} onSelect={handleSaveCopy}>
              <Plus aria-hidden="true" />
              Save to my elements
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem disabled={pending} onSelect={handleDownload}>
            <Download aria-hidden="true" />
            Download
          </DropdownMenuItem>
          {canEdit ? (
            <DropdownMenuItem onSelect={onRename}>
              <Pencil aria-hidden="true" />
              Edit
            </DropdownMenuItem>
          ) : null}
          {own && !element.isShared ? (
            <DropdownMenuItem onSelect={onShare}>
              <Share2 aria-hidden="true" />
              Share to all
            </DropdownMenuItem>
          ) : null}
          {canDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                <Trash2 className="text-destructive" aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {own ? `@${element.name}` : element.name}?</DialogTitle>
            <DialogDescription>
              This removes the reference from active libraries and prompts. Its database record and
              source file will be kept for recovery.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              No, keep it
            </Button>
            <Button type="button" variant="destructive" disabled={pending} onClick={handleRemove}>
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Removing…
                </>
              ) : (
                "Yes, remove"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CopyElementTag({ name }: { name: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const tag = `@${name}`;

  async function copyTag(): Promise<void> {
    try {
      await navigator.clipboard.writeText(tag);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      toast.success(`${tag} copied to clipboard`, {
        position: "bottom-center",
        closeButton: true,
        duration: 3000,
      });
    } catch {
      toast.error("Tag could not be copied.", { position: "bottom-center" });
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copyTag()}
      className="group/tag relative flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left font-mono text-sm font-semibold text-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      aria-label={`Copy ${tag}`}
      title={tag}
    >
      <span className="truncate">{tag}</span>
      {copied ? (
        <Check className="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
      ) : (
        <Copy
          className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/tag:opacity-70 group-focus-visible/tag:opacity-70 motion-reduce:transition-none"
          aria-hidden="true"
        />
      )}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-30 -translate-x-1/2 translate-y-1 whitespace-nowrap rounded-md bg-foreground px-2.5 py-1.5 font-sans text-xs font-medium text-background opacity-0 shadow-lg transition-[opacity,transform] group-hover/tag:translate-y-0 group-hover/tag:opacity-100 group-focus-visible/tag:translate-y-0 group-focus-visible/tag:opacity-100 motion-reduce:transition-none"
      >
        {copied ? "Copied" : "Copy tag"}
      </span>
    </button>
  );
}

function CopyFieldButton({
  fieldId,
  label,
  prefix = "",
  align = "center",
}: {
  fieldId: string;
  label: string;
  prefix?: string;
  align?: "center" | "top";
}): JSX.Element {
  const [copied, setCopied] = useState(false);

  async function copyField(): Promise<void> {
    const field = document.getElementById(fieldId);
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
    try {
      await navigator.clipboard.writeText(`${prefix}${field.value}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      toast.success(`${label} copied to clipboard`, {
        position: "bottom-center",
        closeButton: true,
        duration: 3000,
      });
    } catch {
      toast.error(`${label} could not be copied.`, { position: "bottom-center" });
    }
  }

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onClick={() => void copyField()}
      aria-label={`Copy ${label.toLowerCase()}`}
      title={`Copy ${label.toLowerCase()}`}
      className={`absolute right-2 size-8 rounded-md text-muted-foreground transition-[color,background-color,transform] hover:bg-muted hover:text-foreground active:scale-95 motion-reduce:transition-none ${align === "top" ? "top-2" : "top-1/2 -translate-y-1/2"}`}
    >
      {copied ? (
        <Check className="size-4 text-emerald-600" aria-hidden="true" />
      ) : (
        <Copy className="size-4" aria-hidden="true" />
      )}
    </Button>
  );
}

/**
 * "Mine" earns its place only because the library went shared: it is the one
 * filter that answers a question the grid created rather than one it inherited.
 * Before 0091 every card was yours and the button would have said "All" twice;
 * now finding the four references you can actually edit means scrolling past
 * everyone else's.
 */
type Filter = ElementLibraryFilter;

const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  mine: "Mine",
  images: "Images",
  audio: "Audio",
  video: "Video",
};

export function ElementsLibrary({
  initialPage,
  viewerId,
  viewerIsAdmin,
}: {
  initialPage: ElementLibraryPage;
  /** Who is looking — compared against ElementTag.userId, per card. */
  viewerId: string;
  /** Admins get Rename AND Remove on other people's cards (0091). */
  viewerIsAdmin: boolean;
  /**
   * elements.user_id -> display name, from 0091's element_creators().
   *
   * Nullable per entry, and a missing key is the same story: that function
   * coalesces username to email, both of which the schema allows to be absent,
   * and it returns nothing at all to an unapproved caller. Every read of it
   * below falls back to "someone else" rather than rendering "saved by null".
   */
}): JSX.Element {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [elements, setElements] = useState(initialPage.elements);
  const [creatorNames, setCreatorNames] = useState(initialPage.creatorNames);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [retryIsFirstPage, setRetryIsFirstPage] = useState(false);
  const [editing, setEditing] = useState<ElementTag | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // What the open confirm dialog will act on: a bulk selection, or one card's "Share to all".
  const [confirm, setConfirm] = useState<{ kind: "share" | "delete"; ids: string[] } | null>(null);
  const { pending: bulkPending, run: runBulk } = useAsyncAction();
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);
  const loadMoreInFlightRef = useRef(false);
  const skippedInitialLoadRef = useRef(false);

  useEffect(() => {
    const timeout = setTimeout(() => setCommittedQuery(query), 450);
    return () => clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    if (!skippedInitialLoadRef.current) {
      skippedInitialLoadRef.current = true;
      return;
    }
    const request = ++requestRef.current;
    setLoading(true);
    setLoadError(null);
    void loadElementLibraryPageAction({ query: committedQuery, filter, cursor: null })
      .then((page) => {
        if (request !== requestRef.current) return;
        setElements(page.elements);
        setCreatorNames(page.creatorNames);
        setNextCursor(page.nextCursor);
      })
      .catch(() => {
        if (request === requestRef.current) {
          setRetryIsFirstPage(true);
          setLoadError("References could not be loaded.");
        }
      })
      .finally(() => {
        if (request === requestRef.current) setLoading(false);
      });
  }, [committedQuery, filter, retryToken]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!nextCursor || loading || loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;
    const cursor = nextCursor;
    const request = requestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const page = await loadElementLibraryPageAction({ query: committedQuery, filter, cursor });
      if (request !== requestRef.current) return;
      setElements((current) => [...current, ...page.elements]);
      setCreatorNames((current) => ({ ...current, ...page.creatorNames }));
      setNextCursor(page.nextCursor);
    } catch {
      if (request === requestRef.current) {
        setRetryIsFirstPage(false);
        setLoadError("More references could not be loaded.");
      }
    } finally {
      loadMoreInFlightRef.current = false;
      if (request === requestRef.current) setLoading(false);
    }
  }, [committedQuery, filter, loading, nextCursor]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextCursor) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void loadMore();
      },
      { rootMargin: "500px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

  /**
   * MINE IS AN EXPLICIT MATCH, never "not somebody else's". ElementTag.userId
   * is optional (its own doc says why), and `undefined === viewerId` is false —
   * so a row that somehow arrives without one reads as not-yours and loses its
   * controls, which is the direction that fails safe.
   */
  const isOwn = (element: ElementTag): boolean => element.userId === viewerId;

  // Only cards the viewer may remove can be selected: owner, or an admin.
  const isSelectable = (element: ElementTag): boolean => isOwn(element) || viewerIsAdmin;
  // Derived from what is loaded, so an id left over from before a filter change counts for nothing.
  const selectedElements = elements.filter((element) => selected.has(element.id));
  const shareableIds = selectedElements
    .filter((element) => isOwn(element) && !element.isShared)
    .map((element) => element.id);

  function toggleSelected(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function exitSelectMode(): void {
    setSelectMode(false);
    setSelected(new Set());
  }

  function runConfirmed(): void {
    if (!confirm) return;
    const { kind, ids } = confirm;
    runBulk(async () => {
      try {
        const result = kind === "share" ? await shareElements(ids) : await deleteElements(ids);
        if ("error" in result) {
          toast.error(result.error);
          return;
        }
        const verb = kind === "share" ? "Shared" : "Removed";
        toast.success(
          result.skipped > 0
            ? `${verb} ${result.done}; ${result.skipped} skipped${kind === "share" ? " (tag already used by a shared element, or not yours)" : ""}.`
            : `${verb} ${result.done}.`,
        );
        setConfirm(null);
        exitSelectMode();
        setRetryIsFirstPage(true);
        setRetryToken((value) => value + 1);
      } catch {
        toast.error(
          kind === "share" ? "Could not share those elements." : "Could not remove those elements.",
        );
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="self-start">
        <ElementBatchUploadDialog />
      </div>

      <p className="text-xs text-muted-foreground">
        Pictures up to {formatFileSizeMB(MAX_REFERENCE_IMAGE_BYTES)}; voice clips{" "}
        {MIN_REFERENCE_AUDIO_SECONDS}–{MAX_REFERENCE_AUDIO_SECONDS} seconds, up to{" "}
        {formatFileSizeMB(MAX_REFERENCE_AUDIO_BYTES)}; MP4 videos up to{" "}
        {formatFileSizeMB(MAX_REFERENCE_VIDEO_BYTES)}. A picture is described automatically so{" "}
        <span className="font-medium text-foreground">@name</span> steers a render; a voice clip is
        sent as the file itself; a video is described the same way a voice clip is — press Describe
        on it in the /ugc picker, or type one here once it is saved.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {/* The input stays local so focus and the cursor never jump. Its
            debounced value is searched in Postgres and resets pagination. */}
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search references"
          aria-label="Search references by name or description"
          className="h-8 w-full sm:w-56"
        />
        {(["all", "mine", "images", "audio", "video"] as const).map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={filter === value ? "secondary" : "ghost"}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {FILTER_LABEL[value]}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant={selectMode ? "secondary" : "outline"}
          aria-pressed={selectMode}
          onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
        >
          <ListChecks className="size-4" aria-hidden="true" />
          Select
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">{elements.length} loaded</span>
      </div>

      {elements.length === 0 && !loading ? (
        <p className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {committedQuery.trim()
            ? `Nothing matches "${committedQuery.trim()}". Search covers the @name and the description.`
            : filter === "mine"
              ? "You haven't saved anything yet. Drop a picture, voice clip, or video above to make your first @tag."
              : filter === "all"
                ? "Nothing saved yet, by anyone. Drop a picture, voice clip, or video above to make the first @tag."
                : "Nothing in this filter."}
        </p>
      ) : (
        <ul
          aria-busy={loading}
          className="grid grid-cols-2 gap-4 transition-opacity motion-reduce:transition-none sm:grid-cols-3 lg:grid-cols-4"
        >
          {elements.map((element) => {
            const own = isOwn(element);
            // THE WHOLE PERMISSION MATRIX, in four lines and one place.
            // Everyone who can see a card can view and download it; only the
            // owner or an admin gets Rename and Remove. Computed here rather
            // than inferred from separate JSX conditions further down, so the
            // rule reads as one statement and matches 0091's policies verbatim.
            const canEdit = own || viewerIsAdmin;
            const canDelete = own || viewerIsAdmin;
            const isSelected = selected.has(element.id);
            const savedBy = element.userId ? creatorNames[element.userId] : undefined;
            const MediaIcon = isAudioElement(element)
              ? Volume2
              : isVideoElement(element)
                ? VideoIcon
                : ImageIcon;
            return (
              <li
                key={element.id}
                className={`group relative flex min-w-0 flex-col rounded-xl border bg-card shadow-sm transition-[transform,box-shadow,border-color] duration-200 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20 motion-reduce:transition-none sm:hover:-translate-y-1 sm:hover:border-foreground/20 sm:hover:shadow-lg ${isAudioElement(element) ? "col-span-2 sm:col-span-1" : ""} ${isSelected ? "border-primary ring-2 ring-primary/40" : ""}`}
              >
                {selectMode && isSelectable(element) ? (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelected(element.id)}
                    aria-label={`Select ${element.name}`}
                    className="absolute left-2 top-2 z-10 size-5 cursor-pointer accent-primary"
                  />
                ) : null}
                <ElementActionsMenu
                  element={element}
                  own={own}
                  canEdit={canEdit}
                  canDelete={canDelete}
                  onRename={() => setEditing(element)}
                  onRemoved={() =>
                    setElements((current) => current.filter((item) => item.id !== element.id))
                  }
                  onShare={() => setConfirm({ kind: "share", ids: [element.id] })}
                />
                <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-t-xl border-b bg-muted/60">
                  <ElementThumbnail element={element} />
                </div>

                <div className="flex flex-1 flex-col gap-3 p-3.5">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    {/* @ ONLY ON A CARD YOU CAN USE — see this file's header. On
                      someone else's, the name is still worth showing (it is how
                      they refer to it, and it is what a description is written
                      about); the '@' is what would be a lie. */}
                    <CopyElementTag name={element.name} />
                    <div className="flex shrink-0 items-center gap-1">
                      {own && element.isShared ? (
                        <Badge variant="outline" className="text-[10px] font-medium">
                          Shared
                        </Badge>
                      ) : null}
                      <Badge variant="secondary" className="gap-1 text-[10px] font-medium">
                        <MediaIcon className="size-3" aria-hidden="true" />
                        {CATEGORY_LABEL[element.category]}
                      </Badge>
                    </div>
                  </div>

                  {/* Only on other people's. "saved by you" on every one of your own
                  cards is noise on the common case, and the grid already says
                  which those are by giving them an @ and controls. */}
                  {own ? null : (
                    <p className="truncate text-xs text-muted-foreground">
                      saved by {savedBy ?? "someone else"}
                    </p>
                  )}

                  {element.description ? (
                    <p className="line-clamp-3 text-xs text-muted-foreground">
                      {element.description}
                    </p>
                  ) : (
                    <p className="text-xs italic text-muted-foreground">
                      No description — this tag substitutes nothing into a prompt.
                    </p>
                  )}

                  {canEdit || canDelete ? null : (
                    <span className="mt-auto text-xs italic text-muted-foreground">
                      Original is read-only
                    </span>
                  )}
                </div>
              </li>
            );
          })}
          {loading
            ? Array.from({ length: 4 }, (_, index) => (
                <li
                  key={`loading-${index}`}
                  aria-hidden="true"
                  className="flex min-w-0 flex-col rounded-xl border bg-card shadow-sm"
                >
                  <Skeleton className="aspect-[4/3] w-full rounded-t-xl" />
                  <div className="flex flex-col gap-3 p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-5 w-14 rounded-full" />
                    </div>
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-5/6" />
                  </div>
                </li>
              ))
            : null}
        </ul>
      )}

      {loading ? (
        <span role="status" className="sr-only">
          Loading references…
        </span>
      ) : null}

      {loadError ? (
        <div className="flex flex-col items-center gap-2 py-3" role="alert">
          <p className="text-sm text-destructive">{loadError}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              retryIsFirstPage ? setRetryToken((value) => value + 1) : void loadMore()
            }
          >
            Try again
          </Button>
        </div>
      ) : null}
      {nextCursor ? (
        <div ref={sentinelRef} className="flex min-h-10 justify-center">
          {!loading ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => void loadMore()}>
              Load more
            </Button>
          ) : null}
        </div>
      ) : elements.length > 0 ? (
        <p className="text-center text-xs text-muted-foreground">All references loaded.</p>
      ) : null}

      {selectMode ? (
        <div
          role="toolbar"
          aria-label="Selected elements"
          className="sticky bottom-4 z-20 flex flex-wrap items-center gap-2 self-center rounded-xl border bg-card px-4 py-2 shadow-lg"
        >
          <span className="text-sm font-medium">{selectedElements.length} selected</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              setSelected(
                new Set(elements.filter((element) => isSelectable(element)).map((e) => e.id)),
              )
            }
          >
            Select all loaded
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={shareableIds.length === 0}
            onClick={() => setConfirm({ kind: "share", ids: shareableIds })}
          >
            <Share2 className="size-4" aria-hidden="true" />
            Share to all
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={selectedElements.length === 0}
            onClick={() =>
              setConfirm({ kind: "delete", ids: selectedElements.map((element) => element.id) })
            }
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Delete
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={exitSelectMode}>
            Done
          </Button>
        </div>
      ) : null}

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => !bulkPending && !open && setConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === "share"
                ? `Share ${confirm.ids.length} element${confirm.ids.length === 1 ? "" : "s"} with everyone?`
                : `Remove ${confirm?.ids.length ?? 0} element${confirm?.ids.length === 1 ? "" : "s"}?`}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === "share"
                ? "Everyone can view, download and save a copy. There is no unshare button, though you can still delete one later."
                : "This removes them from active libraries and prompts. Their records and source files are kept for recovery."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={bulkPending}
              onClick={() => setConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={confirm?.kind === "delete" ? "destructive" : "default"}
              disabled={bulkPending}
              onClick={runConfirmed}
            >
              {bulkPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Working…
                </>
              ) : confirm?.kind === "share" ? (
                "Share to all"
              ) : (
                "Yes, remove"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EditElementDialog
        element={editing}
        onClose={() => setEditing(null)}
        onSaved={() => setRetryToken((value) => value + 1)}
      />
    </div>
  );
}

/**
 * Rename and re-describe, in one form, because updateElement writes name,
 * category and description together — sending a partial would blank whichever
 * field the dialog left out.
 *
 * THE RENAME IS THE DANGEROUS FIELD and the dialog says so: substitution is by
 * name at render time, so updateElement follows a rename through every prompt
 * this operator has already written (rewriteTagInOwnPrompts). That happens
 * whether the rename is made here or in the /ugc picker — same action, same
 * rewrite — which is the point of not giving this page its own write path.
 */
function EditElementDialog({
  element,
  onClose,
  onSaved,
}: {
  element: ElementTag | null;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  return (
    <Dialog open={element !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {element ? (
          <ActionForm
            action={async (formData) => {
              const result = await updateElement(formData);
              // Closed only on success. A refusal — a duplicate name, an
              // illegal character — has to leave the dialog open with the
              // typed value still in it, or the operator is bounced back to
              // the grid with a toast and nothing to correct.
              if (!result) {
                onClose();
                onSaved();
              }
              return result;
            }}
            fallbackErrorMessage="Failed to update that reference."
            className="flex flex-col gap-4"
          >
            <DialogHeader>
              <DialogTitle>Edit @{element.name}</DialogTitle>
              <DialogDescription>
                Renaming rewrites this tag in every prompt its owner has already written, so a scene
                that used it keeps working.
              </DialogDescription>
            </DialogHeader>

            <input type="hidden" name="elementId" value={element.id} />
            {/* Preserved, not re-asked. The panel only edits name and
                description; submitting without this would fail
                isElementCategory and refuse the save, and defaulting it would
                silently re-file somebody's pre-0081 "character" as an image. */}
            <input type="hidden" name="category" value={element.category} />

            <div className="flex flex-col gap-2">
              <Label htmlFor="element-name">Name</Label>
              <div className="relative">
                <Input
                  id="element-name"
                  name="name"
                  defaultValue={element.name}
                  maxLength={64}
                  required
                  className="pr-12"
                  // Mirrors updateElement's own server-side test, so the common
                  // mistake is caught before a round trip rather than after.
                  pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,63}"
                  title="Letters, numbers, - and _ only, starting with a letter or number."
                />
                <CopyFieldButton fieldId="element-name" label="Tag" prefix="@" />
              </div>
              <p className="text-xs text-muted-foreground">
                Typed as @name in a prompt. Letters, numbers, - and _ only.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="element-description">Description</Label>
              <div className="relative">
                <Textarea
                  id="element-description"
                  name="description"
                  defaultValue={element.description ?? ""}
                  rows={4}
                  className="pr-12"
                />
                <CopyFieldButton fieldId="element-description" label="Description" align="top" />
              </div>
              <p className="text-xs text-muted-foreground">
                {isAudioElement(element)
                  ? "Notes for you. A voice clip is sent to the vendor as the file itself, so this text does not reach a render."
                  : "Substituted into the prompt wherever this tag appears."}
              </p>
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
            </DialogFooter>
          </ActionForm>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
