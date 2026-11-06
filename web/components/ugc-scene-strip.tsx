// The scene library — this project's clips, one tile each, scrolling
// sideways, and the selector for the whole screen.
//
// Not a history list and not a timeline. Every press of Generate appends a
// row to `scenes` in the operator's UGC project, and that is not an
// implementation detail dressed up as a feature: it is the reason the spend
// caps, allowance grants and RLS policies apply to this route at all, since
// every one of them hangs off `projects` and `scenes`. The rows already
// exist, in order, with their status and duration beside them, so this is a
// read rather than a new store.
//
// Selection lives in the URL (`?scene=<id>`) rather than in client state.
// Three separate things react to it — the column loads that scene's prompt,
// the result shows its current version, the rail lists its attempts — and a
// server-rendered param is the only version of that where all three cannot
// disagree with each other. It is also linkable, which matters the first time
// someone asks "which clip did you mean".
//
// Order carries no meaning — CapCut does the assembly — so tiles are numbered
// by when they were made.

import type { JSX } from "react";
import Link from "next/link";
import { LinkPendingOverlay } from "@/components/link-pending-overlay";
import { StatusIcon, STATUS_LABEL } from "@/components/status-icon";
import { UgcTileMenu } from "@/components/ugc-tile-menu";
import { UgcPendingSceneTile } from "@/components/ugc-pending-scene-tile";
import { UgcNewSceneTile } from "@/components/ugc-new-scene-tile";
import { deleteClipScene, deleteClipVersion } from "@/actions/ugc";
import type { SceneStatus } from "@/types/db";
import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/format-usd";

export interface UgcScene {
  id: string;
  idx: number;
  /**
   * Set on a TAKE tile: one rendered version of a scene that has several.
   * Takes replace the versions rail — every old version is a tile of its own.
   * Absent on a scene's single (or in-flight) tile.
   */
  versionId?: string | null;
  /** The version's number, shown as "v2" beside the scene number. */
  take?: number | null;
  /** True on the take that is the scene's current version (it cannot be deleted alone). */
  isCurrentTake?: boolean;
  duration_s: number;
  status: SceneStatus;
  /** How many attempts this scene has had. 1 unless it has been regenerated. */
  versionCount: number;
  /** Signed URL for this scene's ACTIVE clip, or null when it has none yet (queued/rendering/failed/never produced a clip). */
  downloadUrl: string | null;
  /** Deterministic download filename (lib/manifest.ts's filenameForClip) — null exactly when downloadUrl is null. */
  filename: string | null;
  /** Signed URL for this scene's active poster frame, or null when it has none. */
  posterUrl: string | null;
  /**
   * What this scene has actually been BILLED, summed across every attempt's
   * `runs.cost_usd` and converted to kie credits — never a live re-price at
   * current settings, which is the exact defect "Show the clip what it was
   * billed" (caec855) fixed for the scripted pipeline's own clip card. Null
   * means nothing has been billed yet (never rendered, or every attempt
   * failed before a vendor call completed).
   */
  usdBilled: number | null;
}

export function UgcSceneStrip({
  projectId,
  scenes,
  selectedSceneId,
  selectedVersionId = null,
  readOnly = false,
  vertical = false,
}: {
  /** From `?v=`. Picks the take within the selected scene. */
  selectedVersionId?: string | null;
  /**
   * A column beside the result instead of a row under it, so the result gets
   * the page's height. /ugc uses this; tiles fill the column's width.
   */
  vertical?: boolean;
  readonly projectId: string;
  readonly scenes: readonly UgcScene[];
  /** From `?scene=`. Null means the column is composing a NEW scene. */
  selectedSceneId: string | null;
  /**
   * True for an admin viewing someone else's project. deleteClipScene
   * refuses them in the server regardless; this stops the menu offering a
   * Delete that would only fail. Download stays: reading is the whole point
   * of the read-only view.
   */
  readOnly?: boolean;
}): JSX.Element {
  const totalSeconds = scenes.reduce((sum, scene) => sum + scene.duration_s, 0);
  const usdByScene = new Map<string, number>();
  for (const scene of scenes) {
    if (scene.usdBilled !== null) usdByScene.set(scene.id, scene.usdBilled);
  }
  const totalUsdBilled = [...usdByScene.values()].reduce((sum, usd) => sum + usd, 0);

  return (
    <section
      className={cn(
        "rounded-lg border bg-card",
        vertical && "flex min-h-0 w-full shrink-0 flex-col self-stretch xl:w-56",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-t-[7px] border-b bg-muted/60 px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
          Scenes — this project
        </h2>
        {/* Against the filled bar, not the card. /70 rather than a muted
            token: muted-foreground is mixed for the page ground and goes
            nearly invisible on the fill. */}
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {scenes.length} clip{scenes.length === 1 ? "" : "s"} · {totalSeconds}s
          {totalUsdBilled > 0 ? ` · ${formatUsd(totalUsdBilled)} billed` : ""}
        </span>
      </div>

      {/* THE PLACEHOLDER TILE ALWAYS GETS A CHANCE TO RENDER, even with zero
          real scenes — the very first Generate on a brand-new project is
          exactly the case this exists for. It renders null itself whenever
          nothing is pending (lib/ugc-generate-pending-store.ts), so this
          costs nothing on every other render; what it buys is one row that
          is never skipped just because the empty-state text used to occupy
          this spot alone.

          Scrolls in its own container regardless of state — the page body
          must never scroll sideways, and this strip grows without bound. */}
      <div
        className={cn(
          "flex gap-2 px-3 pb-3 pt-2.5",
          vertical
            ? "min-h-0 flex-1 flex-col overflow-y-auto p-2 [&>*]:!w-full [&>*]:min-h-24"
            : "overflow-x-auto",
        )}
      >
        {/* EMPTY IS A STATE, not a reason to disappear.
          This returned null with no scenes, so a new project showed nothing
          at all where the strip belongs — and the first person to see that
          asked where it had gone. The Versions rail beside it has always
          explained itself when empty ("Each render of a scene adds a version
          here"); the two were inconsistent, and the vanishing one was wrong.
          A control that is not there yet still has to say it exists, or the
          operator is left deciding whether the page is broken. */}
        {scenes.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Every clip you generate appears here, newest last.
          </p>
        ) : (
          <>
            {/* "+ New scene" first, then scene 1, 2, 3… — the page reads
                scenes newest-first, so they are re-sorted here. */}
            <UgcNewSceneTile projectId={projectId} selected={selectedSceneId === null} />
            {[...scenes]
              .sort((a, b) => a.idx - b.idx || (a.take ?? 0) - (b.take ?? 0))
              .map((scene) => {
                // A take is selected by scene AND version; a scene's single
                // tile (no versionId) by scene alone.
                const selected =
                  scene.id === selectedSceneId &&
                  (!scene.versionId || !selectedVersionId || scene.versionId === selectedVersionId);
                return (
                  // A `div`, not the `Link` itself, now that a tile carries TWO
                  // separate targets: the whole card still selects the scene, but
                  // the download control (bottom right) is its own `<a>` — an
                  // anchor nested inside another anchor is invalid HTML and would
                  // make one of the two clicks unreliable, so the selecting link
                  // wraps only the content and the download link sits beside it
                  // as a sibling, not a descendant.
                  <div
                    key={scene.versionId ?? scene.id}
                    className={cn(
                      "relative flex w-[176px] shrink-0 flex-col gap-1 rounded-md border p-1.5",
                      "hover:border-foreground/40",
                      // Selected is a ring around the whole tile — "what you are
                      // looking at". Deliberately a different signal from the
                      // version rail's "current", which is what a scene IS.
                      selected && "ring-2 ring-primary",
                      scene.status === "failed" && "border-destructive/60",
                    )}
                  >
                    <Link
                      href={`/ugc/${projectId}?scene=${scene.id}${scene.versionId ? `&v=${scene.versionId}` : ""}`}
                      scroll={false}
                      // PREFETCH, because this page is expensive to build and the
                      // operator's next click is nearly always another tile in
                      // this same strip. Next fetches the RSC payload on hover or
                      // viewport entry, so by the time the press lands the work is
                      // usually already done.
                      //
                      // The scenes are already listed here, so this prefetches a
                      // bounded, known set — not an open-ended crawl.
                      prefetch
                      aria-current={selected ? "true" : undefined}
                      className="flex flex-col gap-1 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {/* Says the press landed, on the tile that was pressed.
                    Without it the screen showed the previous scene, unchanged,
                    for the whole round-trip — and an operator who gets no
                    answer presses again. See LinkPendingOverlay for why this
                    is per-link rather than a page-wide loading state. */}
                      <LinkPendingOverlay />
                      {/* The clip itself, at a FIXED height rather than the 9:16
                    aspect this product delivers. A 9:16 box at this tile width
                    is 313px tall, which pushed the strip and the page past the
                    viewport; 96px is enough to recognise a take by.

                    Recognising it is the point. This strip is how an editor
                    picks which clip to work on, and a row of identical grey
                    rectangles makes that a matter of clicking each one to find
                    out — on the screen whose whole job is to save exactly that
                    trip. */}
                      {scene.posterUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={scene.posterUrl}
                          alt=""
                          className="h-24 w-full rounded-sm border object-cover"
                        />
                      ) : scene.downloadUrl ? (
                        // An older take has no poster of its own: its first frame.
                        <video
                          src={`${scene.downloadUrl}#t=0.1`}
                          muted
                          playsInline
                          preload="metadata"
                          className="h-24 w-full rounded-sm border object-cover"
                        />
                      ) : (
                        <div className="h-24 w-full rounded-sm bg-muted" />
                      )}
                      {/* Two lines, not five.

                    The tile used to stack index, status, duration, version
                    count and credits one under the other, which made a strip
                    of clips a wall of small print — and now that a poster is
                    showing, the picture is what an editor actually reads. The
                    number and the status stay on their own line because they
                    are what you look for; the three figures collapse into one
                    muted row, in the order you ask about them.

                    Shape first, colour second on the status glyph — the rule
                    status-icon.tsx states, and the one that keeps this legible
                    under reduced motion. */}
                      <span className="flex items-center gap-1.5 text-[11px]">
                        <span className="font-mono tabular-nums">{scene.idx}</span>
                        {scene.take ? (
                          <span className="font-mono tabular-nums text-muted-foreground">
                            v{scene.take}
                          </span>
                        ) : null}
                        <StatusIcon status={scene.status} showLabel={false} />
                        <span className="truncate text-muted-foreground">
                          {STATUS_LABEL[scene.status]}
                        </span>
                      </span>
                    </Link>

                    {/* Same menu as the version rail, for the same reason: the
                  tile itself selects the scene, so everything else has to sit
                  beside that control rather than inside it.

                  No Delete here yet. actions/brief.ts refuses to delete a
                  scene once it has rendered — "delete is only available before
                  a clip exists" — so a Delete on a clip tile would be an item
                  that always refuses. Better absent than always failing. */}
                    <UgcTileMenu
                      label={`scene ${scene.idx}`}
                      downloadUrl={scene.downloadUrl}
                      filename={scene.filename}
                      // Omitted entirely rather than disabled for a read-only
                      // viewer: UgcTileMenu renders nothing at all when it has
                      // neither a download nor a delete, and a disabled Delete on
                      // every tile would be a row of controls explaining a rule
                      // the banner above already states once.
                      // A take deletes as a version (deleteClipVersion), not as the
                      // whole scene, so its siblings stay.
                      onDelete={
                        readOnly ? undefined : scene.versionId ? deleteClipVersion : deleteClipScene
                      }
                      deleteFields={
                        readOnly
                          ? undefined
                          : scene.versionId
                            ? { sceneId: scene.id, versionId: scene.versionId }
                            : { sceneId: scene.id }
                      }
                      deleteUnavailableReason={
                        scene.status === "queued" || scene.status === "rendering"
                          ? "Still rendering"
                          : scene.versionId && scene.isCurrentTake
                            ? "This is the scene's current take"
                            : null
                      }
                      // Stronger than scene-workbench.tsx's own confirm: that one
                      // only takes an un-rendered scene's typing with it.
                      // deleteClipScene refuses just a queued or rendering scene,
                      // so this is deleting a FINISHED clip, and
                      // scene_versions.scene_id cascades — every attempt at it
                      // goes too, not only the one showing. NOT "cannot be
                      // undone", though — 0088_deleted_scenes.sql's BEFORE
                      // DELETE trigger archives the scene and every one of those
                      // rows one step ahead of the cascade, and this same page
                      // renders a "Recently deleted" section (ugc-deleted-scenes.tsx)
                      // with a Restore button for exactly this trash entry, so
                      // claiming otherwise would be false the instant this
                      // confirm is read.
                      confirmMessage={
                        readOnly
                          ? undefined
                          : scene.versionId
                            ? `Delete take v${scene.take} of scene ${scene.idx}?`
                            : `Delete scene ${scene.idx}? Every version of this clip goes with it. You can restore it from Recently deleted.`
                      }
                    />
                  </div>
                );
              })}

            {/* Left alone for a read-only viewer, deliberately: this creates
            nothing. New scene is a DESELECT — there is no draft row to
            create, since a scene only exists once something has been
            rendered. So "new" is
            the absence of a selection, and the empty result box is what says
            so. Last tile always: adding to the row belongs at the row's own
            end, because this strip IS the project. */}
            {/* Its own client component now (ugc-new-scene-tile.tsx): while a
            Generate press is in flight this tile has to lose the ring it
            wears when nothing is selected, and only the client-only pending
            store (lib/ugc-generate-pending-store.ts) knows that. */}
          </>
        )}
        {/* After the last scene, where the clip being queued will land. */}
        <UgcPendingSceneTile
          projectId={projectId}
          nextIdx={Math.max(0, ...scenes.map((scene) => scene.idx)) + 1}
          sceneIds={scenes.map((scene) => scene.id)}
        />
      </div>
    </section>
  );
}
