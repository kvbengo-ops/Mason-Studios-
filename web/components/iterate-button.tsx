"use client";

import type { JSX } from "react";
import { RotateCcw } from "lucide-react";
import { requestVideoIterate, type VideoIterateDetail } from "@/lib/video-iterate";

/**
 * Refills the prompt bar with this take's prompt, references, model and
 * length (lib/video-iterate.ts), so the next Generate is another take of it.
 * Nothing is replaced — Generate always makes a new clip.
 */
export function IterateButton({ detail }: { detail: VideoIterateDetail }): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => requestVideoIterate(detail)}
      className="inline-flex h-7 items-center gap-1.5 rounded-md bg-background px-2 text-[11px] font-semibold normal-case tracking-normal text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <RotateCcw aria-hidden="true" className="size-3" />
      Iterate
    </button>
  );
}
