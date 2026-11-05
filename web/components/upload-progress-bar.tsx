"use client";

// The visible half of upload-progress-store.tsx: a thin bar pinned to the
// top of the viewport, rendered once by app/(app)/layout.tsx so it is the
// same control regardless of which upload surface fed it — a bar that only
// showed up on /ugc and not on /elements (or vice versa) is the kind of
// inconsistency an operator learns to stop trusting within a week.
//
// FIXED TO THE VIEWPORT, NOT TO <main>. The progress it reports outlives the
// page an operator is standing on (that is the entire reason it exists —
// see upload-progress-store.tsx), so it has to stay visible across a
// navigation too, which a bar scoped to <main>'s own stacking context would
// not survive.
import type { JSX } from "react";
import { useUploadProgress } from "@/components/upload-progress-store";

export function UploadProgressBar(): JSX.Element | null {
  const progress = useUploadProgress();
  if (progress === null) return null;

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div
      // z-[60]: above SidebarShell's own content but the number itself isn't
      // load-bearing against anything specific — there is nothing else in
      // this app that pins itself to the viewport, so this only has to beat
      // ordinary in-flow stacking contexts.
      className="fixed inset-x-0 top-0 z-[60] h-1 bg-muted"
      role="status"
      aria-live="polite"
      aria-label={`Uploading ${progress.done} of ${progress.total}`}
    >
      <div
        // motion-reduce:transition-none, not a plain omission of the
        // transition — under reduced motion the bar still has to reach the
        // right width (that width IS the information), it just has to jump
        // there instead of sliding, same trade status-icon.tsx and
        // spinner.tsx each already make for their own animated pieces.
        className="h-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
