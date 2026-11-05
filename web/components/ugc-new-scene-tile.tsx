"use client";

// "+ New scene", pulled out of ugc-scene-strip.tsx into its own client
// component for one reason: while a Generate press is in flight, this tile
// has to lose the ring it normally wears when nothing is selected — the
// operator is about to be looking at the placeholder tile instead
// (ugc-pending-scene-tile.tsx), and a control that still looked selected
// while looking somewhere else was the exact confusion this whole change
// exists to remove. The store is the only thing that knows a press is in
// flight, and the store is client-only, so this tile has to be too.

import { useCallback, type JSX } from "react";
import { useSyncExternalStore } from "react";
import Link from "next/link";
import { LinkPendingOverlay } from "@/components/link-pending-overlay";
import { getSnapshot, subscribe } from "@/lib/ugc-generate-pending-store";
import { cn } from "@/lib/utils";

export function UgcNewSceneTile({
  projectId,
  selected,
}: {
  readonly projectId: string;
  /** True when nothing is selected (`?scene=` absent) — the server's own truth, computed exactly as it always was. */
  readonly selected: boolean;
}): JSX.Element {
  const subscribeToProject = useCallback(
    (listener: () => void) => subscribe(projectId, listener),
    [projectId],
  );
  const getProjectSnapshot = useCallback(() => getSnapshot(projectId), [projectId]);
  const getServerSnapshot = useCallback(() => null, []);
  const pending = useSyncExternalStore(subscribeToProject, getProjectSnapshot, getServerSnapshot);

  return (
    <Link
      href={`/ugc/${projectId}`}
      scroll={false}
      prefetch
      className={cn(
        "relative flex w-[176px] shrink-0 flex-col items-center justify-center gap-1.5",
        "rounded-md border border-dashed p-1.5 text-[11px] text-muted-foreground",
        "hover:border-foreground/40 hover:text-foreground",
        "focus-visible:outline-2 focus-visible:outline-ring",
        selected && !pending && "ring-2 ring-primary",
      )}
    >
      <LinkPendingOverlay />
      <span
        aria-hidden="true"
        className="grid size-7 place-items-center rounded-full border text-base leading-none"
      >
        +
      </span>
      New scene
    </Link>
  );
}
