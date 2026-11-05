"use client";

// Locks a whole block of server-rendered forms while something is running
// for a scene.
//
// The project settings sidebar (Shooting Mode, Direction, Captions) is a
// Server Component: it cannot read the rail's busy store, and it has no
// per-control pending state to thread down. Its existing `frozenReason`
// covers the WORKER owning the scene, which the server can see in
// scenes.status — but not a $0.02 frame regeneration the operator started a
// second ago, which lives only in the browser.
//
// A <fieldset disabled> is what makes this one wrapper rather than a prop on
// every field: the disabled attribute is inherited by every form control
// inside it, buttons included, natively and without this component knowing
// what those controls are. Server-rendered children stay server-rendered.
//
// Why lock them at all: these three fields shape the prompt, and the prompt
// is what a frame is generated from. Changing Shooting Mode while a frame is
// being generated produces a frame from the OLD one and a settings row that
// claims otherwise — the same mismatch the scene settings panel and the
// $1.89 render button were just closed against.

import type { JSX, ReactNode } from "react";
import { useRailEntryBusy } from "@/components/project-rail";
import { cn } from "@/lib/utils";

export function SceneBusyFieldset({
  sceneId,
  children,
}: {
  sceneId: string;
  children: ReactNode;
}): JSX.Element {
  const busy = useRailEntryBusy(sceneId);

  return (
    <fieldset
      disabled={busy}
      // min-w-0 because a fieldset's default min-width is min-content, which
      // in a narrow sidebar column makes it refuse to shrink and pushes the
      // layout wider than the rail it sits beside.
      className={cn("min-w-0 border-0 p-0", busy && "opacity-60")}
    >
      {busy ? (
        <p className="mb-4 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          Something is still running on this scene. These shape the prompt a frame is generated
          from, so they come back when it finishes.
        </p>
      ) : null}
      {children}
    </fieldset>
  );
}
