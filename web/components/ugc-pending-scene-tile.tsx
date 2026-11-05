"use client";

// The placeholder tile Generate -> Confirm shows the instant the operator
// confirms, before generateClip has even started — see
// lib/ugc-generate-pending-store.ts's own header for why an external store
// rather than a transition, and ugc-column.tsx's submit() for where the
// store is actually written to.
//
// FRONT OF THE STRIP, not the back — the tile order everywhere else in this
// file is "newest last", but a placeholder standing in for a clip nobody
// has looked at yet belongs where the operator's eyes already are: right
// beside the Generate button they just pressed, not scrolled off the far
// end of a strip that may already hold a dozen clips.

import { useCallback, useEffect, type JSX } from "react";
import { useSyncExternalStore } from "react";
import { Spinner } from "@/components/spinner";
import { STATUS_LABEL } from "@/components/status-icon";
import { clearGeneratePending, getSnapshot, subscribe } from "@/lib/ugc-generate-pending-store";

export function UgcPendingSceneTile({
  projectId,
  nextIdx,
  sceneIds,
}: {
  readonly projectId: string;
  /**
   * The number this scene will carry once it exists — one past the highest
   * idx currently in the strip, the same arithmetic generateClip itself
   * applies server-side (`idx = (last?.idx ?? 0) + 1`). Cosmetic only: the
   * real idx is assigned inside generateClip and this is never sent
   * anywhere, so the two cannot disagree in a way that matters — worst case
   * this guesses wrong for one placeholder frame if another tab queued a
   * scene in between, which corrects itself the moment the real tile lands.
   */
  readonly nextIdx: number;
  /** Every id currently in the real strip, so this tile can tell when ITS scene has actually arrived and step aside — see the effect below. */
  readonly sceneIds: readonly string[];
}): JSX.Element | null {
  const subscribeToProject = useCallback(
    (listener: () => void) => subscribe(projectId, listener),
    [projectId],
  );
  const getProjectSnapshot = useCallback(() => getSnapshot(projectId), [projectId]);
  // Never pending during SSR — the store is client-only, and the operator
  // cannot have pressed Generate before the page has finished loading.
  const getServerSnapshot = useCallback(() => null, []);
  const pending = useSyncExternalStore(subscribeToProject, getProjectSnapshot, getServerSnapshot);

  const arrived = pending?.sceneId != null && sceneIds.includes(pending.sceneId);

  useEffect(() => {
    // The real tile is in the strip now — this placeholder has done its job.
    // Clearing the store (not just letting `arrived` hide this render) means
    // the NEXT Generate press starts from a clean slate rather than finding
    // a stale resolved-but-uncleared entry.
    if (arrived) clearGeneratePending(projectId);
  }, [arrived, projectId]);

  if (!pending || arrived) return null;

  return (
    <div
      // Not a Link and not a menu, on purpose — this is not a scene yet, so
      // it must not be reachable as one, only a visible promise that the
      // press landed.
      className="relative flex w-[176px] shrink-0 flex-col gap-1 rounded-md border p-1.5 ring-2 ring-primary"
    >
      <div className="h-24 w-full rounded-sm bg-muted" />
      <span
        role="status"
        aria-label={STATUS_LABEL.queued}
        className="flex items-center gap-1.5 text-[11px] text-pending-strong"
      >
        <span className="font-mono tabular-nums text-foreground">{nextIdx}</span>
        {/* THE PROJECT'S SPINNER, not dots and not a swapped label — the
            same GitHub-Actions-style ring status-icon.tsx draws for
            "rendering", reused here because this tile represents an
            in-flight press the same way that glyph represents an in-flight
            render. */}
        <Spinner className="size-4" />
        <span aria-hidden="true" className="truncate text-muted-foreground">
          {STATUS_LABEL.queued}
        </span>
      </span>
    </div>
  );
}
