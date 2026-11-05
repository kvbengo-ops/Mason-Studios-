"use client";

// Step 9 — Deliver (docs/architecture.md § "User flow"). Plain
// <video controls> per clip — no custom player, no assembly, no
// concatenation. If a `final` asset ever exists it gets its own player on
// the server-rendered page above this grid; this component only ever
// renders the individual clips plus the client-only actions the page
// needs: downloading everything as one zip (SMN-feature-spec.md § 3.8 —
// this is the actual handoff, not a convenience), downloading the manifest
// JSON, exporting the cut as a CSV shot list, marking the project
// delivered, reopening it again (the way back out of the lock that status
// places on Character/Brief/Frames — see lib/editable-guard.ts's header
// comment), and reordering the assembled cut.
//
// This screen does exactly two things: show the whole cut, and show its
// ORDER. It deliberately hosts no per-clip repair controls — "Fix the
// prompt" and "Re-render this clip" used to sit in every card's footer
// here, each with a dollar figure on it, which put two spend paths on the
// one screen an operator opens to look at finished work. Repairing a bad
// scene happens on the scene itself: components/scene-workbench.tsx (the
// /projects/[id]/scenes/[sceneId] route) edits the prompt AND re-renders,
// and the render page has its own SceneRerenderDialog. Do not re-add them
// to these cards — the old "Fix the prompt" here also silently
// un-delivered the project as a side effect, which is a large thing to do
// from a card in a grid.
//
// On that last one: reordering here is FREE. It only ever rewrites
// `scenes.idx` and re-concats whatever clips already exist in the new
// order — no render is ever submitted, so dragging clips around costs
// nothing. Re-assembly works by deleting the `final` asset
// (reassembleProject, actions/deliver.ts); there is no other trigger — the
// Go worker's assemble loop picks the project back up on its own 30s poll
// and rebuilds `final` in the new order.
//
// This used to end "with fresh captions", which stopped being true when
// caption burning was deleted with fal (loop/assemble.go's captionOrFallback
// and friends; there is no replacement transcription vendor). A rebuild is a
// re-concat and nothing else now. A reorder now
// fires that itself (see applyReorder), so the gesture is the whole
// gesture: the operator does not have to notice a warning and click a
// second button to make the mp4 match the grid they are looking at. The
// stale notice below stays as the RECOVERY path, not the normal one — it is
// still reachable when the follow-up reassemble fails, or when another tab
// (or an older build) reordered without one. And this calls `reorderCut`,
// NOT `reorderScenes`
// (actions/brief.ts): every clip on this page is already a rendered
// ('done' or 'failed') scene, and reorderScenes's assertLockedOrderPreserved
// guard exists specifically to refuse moving two rendered scenes relative
// to each other — it would reject 100% of reorders here, not as an edge
// case but as the only case. reorderCut is the sanctioned, narrowly-scoped
// exception to that guard (see its doc comment in actions/deliver.ts for
// why skipping it is safe there); don't "simplify" this back onto
// reorderScenes, and don't go looking for some other assembly trigger to
// wire up — there isn't one.

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { toast } from "sonner";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { restrictToParentElement } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { ChevronLeftIcon, ChevronRightIcon, GripVerticalIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import { AssembleDialog } from "@/components/assemble-dialog";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  getManifest,
  markDelivered,
  reassembleProject,
  reopenProject,
  reorderCut,
  type CutStatus,
} from "@/actions/deliver";
import { archiveFileCount, archiveFilename, sanitizeArchiveTitle } from "@/lib/archive";
import { toCsv } from "@/lib/csv";
import { cn } from "@/lib/utils";
import type { ProjectStatus } from "@/types/db";

export interface ClipGridClip {
  id: string;
  idx: number;
  isTalkingHead: boolean;
  /** scenes.duration_s — shown per card, next to the clip's position in the
   *  cut, so the grid answers "how long is shot 3" without arithmetic on a
   *  summed runtime. */
  durationS: number;
  /**
   * Which attempt this clip came from — scene_versions.n, shown as "v2".
   * Absent for a scene that has not rendered since 0058 and so has no
   * version row. Deliver is where an operator decides what ships, and
   * "which take is this" is part of that decision.
   */
  versionN?: number;
  videoUrl: string;
  // Best-effort — the worker's poster extraction can fail (logged and
  // swallowed there) and every clip asset created before extraction existed
  // has no poster row at all, so this is routinely absent. Optional
  // (`undefined`), never `""`: some browsers treat an empty poster
  // attribute as a failed image load rather than "no poster", so the page
  // building this only ever hands over a real URL or omits the key.
  posterUrl?: string;
  filename: string;
}

function RollBadge({ isTalkingHead }: { isTalkingHead: boolean }): JSX.Element {
  return (
    <Badge variant={isTalkingHead ? "default" : "secondary"}>
      {isTalkingHead ? "A-roll" : "B-roll"}
    </Badge>
  );
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

const CUT_CSV_HEADER = ["Scene", "Roll", "Duration (s)", "File"] as const;

/**
 * The cut as a spreadsheet: one row per clip, in the order the grid is
 * currently showing them.
 *
 * Columns mirror what this screen actually renders (position, roll, per-clip
 * duration, the filename the download hands over) — the same "match the
 * screen, not the table" rule lib/brief-csv.ts's own header sets out. Script
 * lines and video prompts deliberately stay out: that is the Brief page's
 * CSV, and repeating it here would make two files that disagree the moment
 * someone edits a prompt after delivery.
 *
 * Quoting/formula-injection handling comes from lib/csv.ts's toCsv rather
 * than a local join. Only `filename` can carry operator-authored text here
 * (it is derived from the project's own storage key), but a header row and
 * three numeric-ish columns are not a reason to hand-roll the one thing
 * that file exists to get right.
 *
 * Exported for its own test: the alternative is asserting on a Blob pulled
 * out of a stubbed URL.createObjectURL, which tests the download plumbing
 * rather than the document.
 */
export function buildCutCsv(
  rows: readonly {
    position: number;
    isTalkingHead: boolean;
    durationS: number;
    filename: string;
  }[],
): string {
  return toCsv(
    [...CUT_CSV_HEADER],
    rows.map((row) => [
      String(row.position),
      row.isTalkingHead ? "A-roll" : "B-roll",
      String(row.durationS),
      row.filename,
    ]),
  );
}

/** Same shape as lib/archive.ts's archiveFilename / lib/brief-csv.ts's
 *  briefCsvFilename, reusing the same sanitiser — a project title can be
 *  1444 characters and can contain path separators. */
export function cutCsvFilename(title: string): string {
  return `${sanitizeArchiveTitle(title)}-cut.csv`;
}

/** MB, one decimal — good enough for "still working" reassurance, not a
 * precise progress bar (we never know the archive's final size upfront,
 * since computing it exactly would mean sizing every clip before the first
 * byte is allowed to stream, which is the memory cost this feature exists
 * to avoid). */
function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** The ids of `fullOrder` that currently have a clip — i.e. the ones this
 * grid actually renders a card for, in reading order. */
function visibleOrder(fullOrder: readonly string[], clippedIds: ReadonlySet<string>): string[] {
  return fullOrder.filter((id) => clippedIds.has(id));
}

/**
 * Splices a new visible (clipped-only) order back into the full scene
 * order, leaving every non-clipped (failed) id exactly where it already
 * was relative to its neighbours. `reorderCut` requires the project's
 * COMPLETE scene set (actions/deliver.ts's doc comment) — a failed scene
 * has no clip and so never appears in this grid, but dropping its id from
 * the payload gets the whole reorder refused. Walking `fullOrder` and
 * substituting only the clipped slots, in order, from `newVisibleOrder` is
 * what keeps a failed scene's id in the payload without this grid ever
 * needing to guess where in the cut it "should" go.
 */
function mergeFullOrder(
  fullOrder: readonly string[],
  clippedIds: ReadonlySet<string>,
  newVisibleOrder: readonly string[],
): string[] {
  let i = 0;
  // Non-null: `i` only ever advances once per clipped id in `fullOrder`,
  // and `newVisibleOrder` is always that same set of ids (just possibly
  // reordered) — so it can never run out before `fullOrder` does.
  return fullOrder.map((id) => (clippedIds.has(id) ? newVisibleOrder[i++]! : id));
}

function SortableClipCard({
  clip,
  displayIdx,
  canReorder,
  isFirst,
  isLast,
  onMoveLeft,
  onMoveRight,
}: {
  clip: ClipGridClip;
  displayIdx: number;
  canReorder: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMoveLeft: () => void;
  onMoveRight: () => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: clip.id,
    disabled: !canReorder,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <Card ref={setNodeRef} style={style} className={cn(isDragging && "z-10 opacity-90 shadow-lg")}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {canReorder ? (
            // A dedicated handle, not whole-card drag: the card also hosts a
            // native <video controls> scrubber, and a draggable card would
            // fight every click/drag on that scrubber for the pointer.
            <button
              type="button"
              // touch-action none is required for dnd-kit's PointerSensor to
              // receive drag gestures on touch devices instead of the
              // browser treating it as a scroll.
              className="touch-none rounded-sm p-1 text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label={`Drag to reorder Scene ${displayIdx}`}
              {...attributes}
              {...listeners}
            >
              <GripVerticalIcon className="size-4" aria-hidden />
            </button>
          ) : null}
          <RollBadge isTalkingHead={clip.isTalkingHead} />
          {/* Which take this is. Deliver is where an operator decides what
              ships, and a project re-rendered a few times has several clips
              per scene now — "v2" is the difference between reviewing the
              take you meant and the one before it. */}
          {clip.versionN ? (
            <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">
              v{clip.versionN}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Position in the cut and this shot's own length — the two facts
              the grid exists to show. The sr-only word is what keeps it from
              being announced as a bare "1 dot 6 s": the visible text is
              deliberately terse, the accessible name should not be. */}
          <span className="text-xs tabular-nums text-muted-foreground">
            <span className="sr-only">Scene</span> {displayIdx} · {clip.durationS}s
          </span>
          {canReorder ? (
            <div className="flex items-center gap-0.5">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7"
                disabled={isFirst}
                onClick={onMoveLeft}
                aria-label={`Move Scene ${displayIdx} earlier`}
              >
                <ChevronLeftIcon className="size-3.5" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7"
                disabled={isLast}
                onClick={onMoveRight}
                aria-label={`Move Scene ${displayIdx} later`}
              >
                <ChevronRightIcon className="size-3.5" aria-hidden />
              </Button>
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <video
          controls
          preload="metadata"
          // Passing undefined here (see ClipGridClip.posterUrl) is
          // what keeps a missing poster silent: React omits the
          // attribute entirely rather than rendering poster="", so
          // the video just falls back to today's behaviour — blank
          // until preload="metadata" resolves — instead of a
          // browser-visible broken-image state.
          poster={clip.posterUrl}
          // Height-capped rather than width-driven. A 9:16 clip given the
          // full column width renders a tile taller than the viewport, so
          // three of them turn the Deliver page — the screen for comparing
          // clips against each other — into a page you can only scroll one
          // clip at a time. mx-auto keeps it centred once the cap makes it
          // narrower than its column.
          className="mx-auto max-h-[22rem] w-auto rounded-md bg-muted"
          src={clip.videoUrl}
        >
          Your browser does not support inline video playback.
        </video>
        {/* The one control left on a card. Kept even though the whole-cut
            downloads below cover the common case: /api/projects/[id]/archive
            and getManifest both go through requireProject, so for a
            read-only admin viewer (ClipGrid's readOnly prop) this link is
            the ONLY way to get a file off this page at all. */}
        <a
          href={clip.videoUrl}
          download={clip.filename}
          // text-accent-foreground, not text-primary: --primary is
          // gold, and gold is a surface colour in this theme (dark
          // ink on top), not something set directly as link text on
          // the page background — see config/themes/studio-light.css.
          className="text-sm font-medium text-accent-foreground underline-offset-4 hover:underline"
          aria-label={`Download Scene ${displayIdx}`}
        >
          Download
        </a>
      </CardContent>
    </Card>
  );
}

export function ClipGrid({
  projectId,
  projectTitle,
  clips,
  hasFinal,
  hasFinalVersion,
  buildInProgress,
  finalUrl,
  initialStatus,
  sceneOrder,
  allTerminal,
  allScenesDone,
  unfinishedSceneCount,
  cutStatus,
  readOnly = false,
}: {
  projectId: string;
  projectTitle: string;
  clips: readonly ClipGridClip[];
  /** Whether a playable file exists for the active cut. Drives the archive
   * file count, the reorder-triggered rebuild, and the panel's copy. */
  hasFinal: boolean;
  /**
   * Whether a final version row exists at all — which is NOT the same
   * question (0060_final_versions.sql). A version whose file has been pruned
   * to its recipe has no `hasFinal` and still has something to update, so
   * this is what decides whether the assemble dialog asks new-vs-update or
   * is a plain button.
   */
  hasFinalVersion: boolean;
  /**
   * Whether a version is already queued or being assembled right now.
   *
   * 0060 enforces at most one outstanding request per project (a partial
   * unique index), so a second press while one is pending does not queue a
   * second build — it fails on the constraint. A button that can only error
   * should not be pressable.
   */
  buildInProgress: boolean;
  /** Signed URL for the assembled `final` asset, or null when there isn't
   *  one yet. Drives the "Download mp4" button in the action row — the whole
   *  cut's download belongs next to the other delivery actions, not buried
   *  as a text link inside the player card. */
  finalUrl: string | null;
  initialStatus: ProjectStatus;
  /** Every scene id, in the project's current idx order — including scenes
   * with no clip (failed). This is the superset `clips` is drawn from;
   * `reorderCut` needs the whole thing (see mergeFullOrder above). */
  sceneOrder: readonly string[];
  /** Mirrors deliver/page.tsx's own `allTerminal` — reorderCut refuses
   * unless every scene is 'done' or 'failed'. Reorder controls are hidden
   * rather than offered-then-refused when this is false. */
  allTerminal: boolean;
  /**
   * Every scene is 'done' — deliver/page.tsx's own `incomplete`, negated,
   * and the same flag its red "this is not the full delivery" banner is
   * drawn from.
   *
   * This screen is a SOFT gate: it opens at 1/2, because seeing what has
   * finished is the whole reason to come here early. Mark delivered is the
   * one control that closes — delivery is a claim about a finished ad, and
   * the button that makes it should not be clickable while half the cut is
   * still rendering.
   *
   * Stricter than `allTerminal` on purpose: a failed scene leaves a hole in
   * the cut, so it blocks delivery too. That is a real corner — a scene the
   * vendor will not render leaves an operator unable to mark delivered until
   * they retry it or drop it from the brief — and it is the intended answer
   * rather than an oversight, because the alternative is a project marked
   * delivered with a shot missing and nothing on the record saying so.
   *
   * This is the CONVENIENCE half. markDelivered (actions/deliver.ts) makes
   * the same check itself and refuses, naming how many scenes are still
   * unrendered — a disabled button is never a boundary, since a Server
   * Action can be POSTed directly past whatever the browser would have
   * refused. This prop only spares the operator a click that would fail.
   */
  allScenesDone: boolean;
  /**
   * How many scenes are not 'done'. Needed alongside `allScenesDone`
   * because the two blocking reasons — a scene with no clip at all, and a
   * scene holding a clip that its current frame/prompt no longer matches —
   * are counted from different things and must not be described with each
   * other's number.
   */
  unfinishedSceneCount: number;
  /** From getCutStatus (actions/deliver.ts) — drives the stale-cut notice
   * and its Assemble button. */
  cutStatus: CutStatus;
  /**
   * True when the viewer is an admin looking at someone else's project
   * (requireProjectReadable's `isOwner: false` — see actions/guard.ts).
   * Hides Mark delivered/Reopen/reorder controls/Assemble (writes, refused
   * server-side by actions/deliver.ts regardless of this prop either way)
   * AND Download all/Download manifest — those two aren't writes, but both
   * route through requireProject (getManifest, and the strict,
   * deliberately-still-owner-only /api/projects/[id]/archive route), so
   * they would always fail for a non-owner too; hiding them avoids offering
   * a download that only errors.
   * Per-clip video playback/download AND the assembled mp4's own download
   * stay visible — those URLs are already resolved server-side on this page
   * via the session client, which RLS lets an admin read same as everything
   * else on this project. They are also the only files a read-only viewer
   * can get at all, since the zip and the manifest are both owner-only.
   */
  readOnly?: boolean;
}): JSX.Element {
  const [status, setStatus] = useState<ProjectStatus>(initialStatus);
  const [manifestPending, startManifestTransition] = useTransition();
  const [deliverPending, startDeliverTransition] = useTransition();
  const [reopenPending, startReopenTransition] = useTransition();
  const [reorderPending, startReorderTransition] = useTransition();
  const [reassemblePending, startReassembleTransition] = useTransition();
  const [archivePending, setArchivePending] = useState(false);
  const [archiveBytes, setArchiveBytes] = useState(0);
  const [order, setOrder] = useState<readonly string[]>(sceneOrder);
  const [liveMessage, setLiveMessage] = useState("");

  const delivered = status === "delivered";
  const isOwner = !readOnly;
  const canReorder = isOwner && !delivered && allTerminal;

  // Resync from the server's order whenever it actually changes (a fresh
  // page render after a successful reorderCut elsewhere, e.g. another tab)
  // — but never while a reorder we just made optimistically here is still
  // in flight, or the in-flight one would get stomped by the pre-mutation
  // value the server hasn't caught up to yet.
  //
  // Adjusted during render against a remembered key rather than in an
  // effect. An effect that calls setState in its body runs *after* the
  // browser has already been handed a frame built from the stale order, so
  // the corrected order lands as a second, visible render — and the
  // eslint rule that flags it (react-hooks/set-state-in-effect) is
  // pointing at exactly that cascade, not at a style preference. React
  // documents this render-time form for "adjusting state when a prop
  // changes": the re-render happens before anything is painted, so the
  // stale frame is never shown.
  //
  // The key is the joined ids, not sceneOrder itself, so a parent that
  // passes a fresh array with the same contents on every render doesn't
  // retrigger this.
  const sceneOrderKey = sceneOrder.join(",");
  const [syncedOrderKey, setSyncedOrderKey] = useState(sceneOrderKey);
  if (!reorderPending && syncedOrderKey !== sceneOrderKey) {
    setSyncedOrderKey(sceneOrderKey);
    setOrder(sceneOrder);
  }

  const clipById = new Map(clips.map((clip) => [clip.id, clip]));
  const clippedIds = new Set(clipById.keys());
  const visibleIds = visibleOrder(order, clippedIds);
  const displayIdxById = new Map(order.map((id, i) => [id, i + 1]));
  const orderedClips = visibleIds
    .map((id) => clipById.get(id))
    .filter((clip): clip is ClipGridClip => clip !== undefined);

  const fileCount = archiveFileCount(clips.length, hasFinal);

  function applyReorder(newVisibleOrder: readonly string[]): void {
    const previousOrder = order;
    const nextOrder = mergeFullOrder(previousOrder, clippedIds, newVisibleOrder);
    setOrder(nextOrder);
    startReorderTransition(async () => {
      const result = await reorderCut(projectId, nextOrder);
      if (result?.error) {
        setOrder(previousOrder);
        toast.error(result.error);
        return;
      }
      // The reorder IS the gesture — rebuilding the mp4 is not a second
      // decision the operator has to make, so it is not a second button they
      // have to find. reassembleProject deletes the `final` asset and the Go
      // worker's ~30s poll rebuilds it in the new order (see this file's
      // header); without this, the downloadable mp4 keeps the OLD order
      // while the grid shows the new one until someone notices the warning
      // banner. Skipped when there is no `final` yet (the action is a no-op
      // in that case anyway) — the worker assembles from the current order
      // when it first gets there.
      if (!hasFinal) return;
      // "new" — a drag leaves the previous cut playable rather than
      // overwriting it. It does mean a session of fiddling with the order
      // mints a version per drag; that is the cost of never destroying a cut
      // the operator did not ask to destroy, and the picker is ordered
      // newest-first so the noise stays out of the way.
      const reassembly = await reassembleProject(projectId, "new");
      if (reassembly?.error) {
        // Not fatal and not a lie: the reorder itself is saved. Say what did
        // not happen, and leave the stale notice above as the way to retry.
        toast.error(`Reordered, but re-assembling the video failed: ${reassembly.error}`);
      }
    });
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = visibleIds.indexOf(String(active.id));
    const newIndex = visibleIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    applyReorder(arrayMove(visibleIds, oldIndex, newIndex));
  }

  function moveClip(clipId: string, direction: -1 | 1): void {
    const index = visibleIds.indexOf(clipId);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= visibleIds.length) return;
    const next = [...visibleIds];
    // Non-null: both indices were just bounds-checked above.
    [next[index], next[target]] = [next[target]!, next[index]!];
    const clip = clipById.get(clipId);
    setLiveMessage(
      `${clip ? `Scene ${displayIdxById.get(clipId)}` : "Clip"} moved ${
        direction === -1 ? "earlier" : "later"
      }.`,
    );
    applyReorder(next);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const announcements: Announcements = {
    onDragStart({ active }) {
      const clip = clipById.get(String(active.id));
      return clip ? `Picked up Scene ${displayIdxById.get(clip.id)}.` : "";
    },
    onDragOver({ active, over }) {
      if (!over) return "";
      const activeLabel = displayIdxById.get(String(active.id));
      const overLabel = displayIdxById.get(String(over.id));
      return `Scene ${activeLabel} is now over position ${overLabel}.`;
    },
    onDragEnd({ active, over }) {
      if (!over) return "Reorder cancelled.";
      return `Scene ${displayIdxById.get(String(active.id))} dropped at position ${displayIdxById.get(String(over.id))}.`;
    },
    onDragCancel() {
      return "Reorder cancelled.";
    },
  };

  async function handleDownloadAll(): Promise<void> {
    setArchivePending(true);
    setArchiveBytes(0);
    try {
      const response = await fetch(`/api/projects/${projectId}/archive`);
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed to build archive (HTTP ${response.status}).`);
      }

      // Read manually (rather than response.blob()) so the button can show
      // real progress instead of sitting frozen for however long an
      // eighteen-clip archive takes to arrive.
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
        setArchiveBytes(total);
      }

      downloadBlob(
        archiveFilename(projectTitle),
        new Blob(chunks as BlobPart[], { type: "application/zip" }),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to download archive.");
    } finally {
      setArchivePending(false);
    }
  }

  // Built here, from what is already on screen, rather than through a
  // server action: every column comes from props this component is already
  // rendering, in the order it is currently rendering them, so the file and
  // the grid can never disagree about the cut.
  function handleExportCsv(): void {
    const csv = buildCutCsv(
      orderedClips.map((clip, index) => ({
        position: displayIdxById.get(clip.id) ?? index + 1,
        isTalkingHead: clip.isTalkingHead,
        durationS: clip.durationS,
        filename: clip.filename,
      })),
    );
    downloadBlob(
      cutCsvFilename(projectTitle),
      // charset=utf-8 declared: the filename column carries the project's
      // own storage-key-derived names, which can be non-ASCII.
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
  }

  function handleDownloadManifest(): void {
    startManifestTransition(async () => {
      try {
        const manifest = await getManifest(projectId);
        downloadJson("manifest.json", manifest);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to build manifest.");
      }
    });
  }

  function handleMarkDelivered(): void {
    startDeliverTransition(async () => {
      try {
        const result = await markDelivered(projectId);
        if (result?.error) {
          // The server refused — do NOT flip the grid into its delivered
          // state. That is the shape reopenProject was already fixed for:
          // the UI believing its own optimistic snapshot over the answer.
          toast.error(result.error);
          return;
        }
        setStatus("delivered");
        toast.success("Project marked delivered.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to mark delivered.");
      }
    });
  }

  // The way back out of 'delivered' — see reopenProject's own doc comment
  // (actions/deliver.ts) for why this is a separate, explicit control
  // rather than something an edit does implicitly: an operator may need to
  // fix the Character reference or a Brief prompt before touching any
  // scene's render state at all, and those steps stay locked
  // (lib/editable-guard.ts's header comment) until this runs.
  // reopenProject writes a plain, non-delivered status rather than any
  // client-computed value — see its doc comment for why "complete" is the
  // honest choice, not just a safe one — so the optimistic update here just
  // has to stop reading "delivered," not predict the real derived status.
  function handleReopen(): void {
    startReopenTransition(async () => {
      try {
        await reopenProject(projectId);
        setStatus("complete");
        toast.success("Project reopened — Character, Brief and Frames are editable again.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to reopen project.");
      }
    });
  }

  // reassembleProject INSERTS a final version with built_at null, which is
  // what the worker's ~30s assemble-loop poll claims (0060_final_versions.sql
  // — it no longer infers the request from a missing `final` asset). That
  // insert, plus this action's own revalidatePath call, is what turns
  // deliver/page.tsx's `assembling` flag true on the next render: no
  // client-side refresh is coded here on purpose, the same way
  // handleMarkDelivered/handleReopen above don't call router.refresh()
  // either — Next re-runs the Server Action's revalidated route
  // automatically once the action resolves.
  function handleAssemble(): void {
    startReassembleTransition(async () => {
      // "new" explicitly, not the default: this is the stale-cut shortcut,
      // and the cut it is replacing is the one the operator is being warned
      // about — keeping it pickable costs nothing and losing it silently
      // from a warning banner would be a surprise.
      const result = await reassembleProject(projectId, "new");
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Re-assembling the full video — this can take a minute or two.");
    });
  }

  const missingClipCount = sceneOrder.length - clips.length;

  return (
    <div className="flex flex-col gap-4">
      {/* The assemble control, always on screen rather than only when the
          cut has gone stale. It is the action this whole step exists for,
          and hiding it until a specific condition made "how do I build the
          video" a question with no visible answer. Disabled, with the count
          that is blocking it, says more than an absent button does. */}
      {isOwner && !delivered ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-4">
          <div className="flex flex-col">
            <span className="text-sm font-medium text-foreground">
              {hasFinal ? "Rebuild the assembled video" : "Assemble the final video"}
            </span>
            {/* Two different reasons this can be blocked, and saying the
                wrong one is worse than saying nothing. `allScenesDone` is
                STATUS-based while `missingClipCount` counts actual clips,
                and those disagree: regenerating a frame writes a rendered
                scene back to 'frame_ready' (actions/frames.ts), so a
                project can have every clip present and still not be ready.
                The old copy read that state as "0 of 8 scenes still has no
                clip", which is both false and unactionable. */}
            <span className="text-xs text-muted-foreground">
              {allScenesDone
                ? "Every scene has a clip. This stitches them in the order below."
                : buildInProgress
                  ? "A version is being assembled right now. It will appear here when it finishes."
                  : sceneOrder.length === 0
                    ? "This project has no scenes yet. Compile the script first — there is nothing to stitch."
                    : missingClipCount > 0
                      ? `${missingClipCount} of ${sceneOrder.length} scene${
                          sceneOrder.length === 1 ? "" : "s"
                        } still has no clip — finish those first.`
                      : `Every scene has a clip, but ${unfinishedSceneCount} ${
                          unfinishedSceneCount === 1 ? "is" : "are"
                        } not marked done — a failed scene, or one whose frame or prompt changed after it rendered. Re-render ${
                          unfinishedSceneCount === 1 ? "it" : "them"
                        } before building the cut.`}
            </span>
          </div>
          {/* A dialog rather than a button once a cut exists: "rebuild"
              has two meanings now (0060_final_versions.sql) — open another
              version beside this one, or replace the file this one points
              at — and only the operator knows which they mean. Before there
              was a version to lose, there is nothing to ask, and the dialog
              collapses back to a plain button. */}
          <AssembleDialog
            projectId={projectId}
            hasVersion={hasFinalVersion}
            disabled={!allScenesDone || buildInProgress}
            onDone={(): void => {
              toast.success("Assembling the full video — this can take a minute or two.");
            }}
          />
        </div>
      ) : null}

      {cutStatus.state === "stale" ? (
        // Calm, not an error: nothing is broken, the assembled video is
        // just one reorder behind. Uses --warning, not --destructive.
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
          {/* Two different ways a cut goes stale, and saying the wrong one
              sends the operator looking for a reorder that never happened.
              `reason` comes from getCutStatus (actions/deliver.ts): "order"
              is a reorder after the build, "recipe" is a scene that has
              moved onto a different version since — which is what replaced
              deleting the final on every re-render. */}
          <span>
            {cutStatus.state === "stale" && cutStatus.reason === "recipe"
              ? "The assembled video no longer matches the current clips — at least one scene has been re-rendered or switched to a different version since it was built."
              : "The assembled video no longer matches the current clip order — it was built before the most recent reorder."}
          </span>
          {isOwner && !delivered ? (
            <PendingButton
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAssemble}
              pending={reassemblePending}
            >
              Assemble
            </PendingButton>
          ) : null}
        </div>
      ) : null}

      {/* ONE label over the list, naming the section and its one non-obvious
          affordance in a line. Reordering is free — reorderCut only rewrites
          the sequence the assembler reads, no vendor request — but nothing
          else says it is possible, and a drag handle alone is a cue you only
          notice once you already suspect it. Always rendered when there are
          clips at all, including the single-clip and read-only cases, so the
          grid is never an unnamed wall of cards. */}
      {clips.length > 0 ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="text-sm font-medium text-foreground">Order</h2>
          {canReorder ? (
            <p className="text-xs text-muted-foreground">
              — drag a clip, or use the arrows on it. Reordering is free and rebuilds the video.
            </p>
          ) : isOwner && !delivered && !allTerminal ? (
            <p className="text-xs text-muted-foreground">
              — reordering unlocks once every scene has finished rendering, or failed and been
              retried.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Screen-reader-only: button-triggered moves don't go through
          DndContext, so they don't get its `announcements` for free. Drag
          reorders do (accessibility.announcements below) — this region only
          ever speaks for the button path, so the two never double-announce
          the same move. */}
      <div role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </div>

      {clips.length === 0 ? (
        <p className="text-sm text-muted-foreground">No clips have finished rendering yet.</p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToParentElement]}
          accessibility={{ announcements }}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={visibleIds} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {orderedClips.map((clip, index) => (
                <SortableClipCard
                  key={clip.id}
                  clip={clip}
                  displayIdx={displayIdxById.get(clip.id) ?? index + 1}
                  canReorder={canReorder}
                  isFirst={index === 0}
                  isLast={index === orderedClips.length - 1}
                  onMoveLeft={() => moveClip(clip.id, -1)}
                  onMoveRight={() => moveClip(clip.id, 1)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* One action row, after the clips: the cheap downloads on the left,
          the one consequential control on the right. It used to sit above
          the grid (and the final's own download was a text link inside the
          player card, somewhere else entirely) — an operator scrolls through
          the cut and then decides, so the decision belongs at the end of the
          thing being decided about. */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Outside the readOnly gate below, deliberately: this is a signed
              URL the server already resolved for whoever is allowed to see
              this page, not a route that will refuse a non-owner — same
              reasoning as the per-clip Download link on each card. The two
              buttons after it DO go through requireProject, which is why they
              are gated. */}
          {finalUrl ? (
            // asChild: a download is a link, not a button that fetches —
            // it wants the browser's own download path (and middle-click,
            // and "Save link as"), with the action row's weight.
            <Button asChild variant="outline">
              <a href={finalUrl} download={`${sanitizeArchiveTitle(projectTitle)}.mp4`}>
                Download mp4
              </a>
            </Button>
          ) : null}
          {/* Outside the gate too, and for the same reason as the download
              link above: handleExportCsv formats rows this viewer already
              has on screen, entirely in the browser. There is no request for
              a server to refuse, so hiding it from a read-only admin removed
              an affordance without protecting anything. The two controls
              below it DO call actions behind requireProject, which is what
              the gate is for. */}
          <Button variant="outline" onClick={handleExportCsv} disabled={clips.length === 0}>
            Export CSV
          </Button>

          {!readOnly ? (
            <>
              <PendingButton
                variant="outline"
                onClick={handleDownloadAll}
                pending={archivePending}
                disabled={clips.length === 0}
              >
                Download all ({fileCount} files)
              </PendingButton>
              {/* The label stays put while the zip streams (see
                  pending-button.tsx) — the progress it used to swallow the
                  label for lives here instead, where it can keep counting
                  without hiding which button is working. */}
              {archivePending ? (
                // Not a live region: this ticks on every streamed chunk, and
                // a polite region that re-announces a megabyte count several
                // times a second is worse than silence. The button's own
                // disabled+spinner state is what says "working" non-visually.
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatMegabytes(archiveBytes)}
                </span>
              ) : null}
              <PendingButton
                variant="outline"
                onClick={handleDownloadManifest}
                pending={manifestPending}
              >
                Download manifest
              </PendingButton>
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!readOnly ? (
            <>
              {/* Says why the one disabled control is disabled, next to it,
                  rather than leaving a dead button to be puzzled over. The
                  red banner at the top of the page carries the same fact and
                  the link to what is still in flight. */}
              {!delivered && !allScenesDone ? (
                <p className="text-xs text-muted-foreground">
                  Delivery unlocks once every scene has rendered.
                </p>
              ) : null}
              {status === "delivered" ? (
                <PendingButton variant="outline" onClick={handleReopen} pending={reopenPending}>
                  Reopen
                </PendingButton>
              ) : null}
              <PendingButton
                onClick={handleMarkDelivered}
                pending={deliverPending}
                // The soft gate's one hard edge — see the allScenesDone prop
                // doc above.
                disabled={delivered || !allScenesDone}
              >
                {delivered ? "Delivered" : "Mark delivered"}
              </PendingButton>
            </>
          ) : status === "delivered" ? (
            <Badge>Delivered</Badge>
          ) : null}
        </div>
      </div>
    </div>
  );
}
