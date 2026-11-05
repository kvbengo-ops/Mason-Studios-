"use client";

// The spinner that says "this tile is loading", scoped to the one link that
// was actually clicked.
//
// WHY THIS EXISTS. /ugc/[id] is a Server Component and scene selection lives
// in the URL (`?scene=<id>`), so every thumbnail press is a full server
// round-trip: budget snapshot, every scene row and version, a signed URL per
// asset, the runs error read. Until it returns, the screen kept showing the
// PREVIOUS scene with no sign anything had happened. That is not slowness,
// it is silence — the operator presses again, because nothing told them the
// first press landed.
//
// useLinkStatus (Next 15.3+) reports the pending state of the nearest
// enclosing <Link>. Per-link is the whole point: a page-wide loading state
// would blank the strip an operator is using to choose, and would not answer
// the only question they have, which is "did the one I clicked register".
//
// Deliberately NOT a route-level loading.tsx alone. That covers the first
// load of the route; this covers moving between scenes inside it, which is
// the case that actually happens all day.

import type { JSX } from "react";
import { useLinkStatus } from "next/link";
import { Spinner } from "@/components/spinner";
import { cn } from "@/lib/utils";

export function LinkPendingOverlay({ className }: { readonly className?: string }): JSX.Element | null {
  const { pending } = useLinkStatus();
  if (!pending) return null;

  return (
    <span
      // aria-hidden with a visually-hidden live region beside it: a spinner
      // is a picture, and a screen reader needs the sentence. role="status"
      // announces without stealing focus, which matters because the operator
      // is mid-click on a strip they are scanning.
      className={cn(
        "pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-background/60",
        className,
      )}
    >
      <Spinner aria-hidden="true" />
      <span className="sr-only" role="status">
        Loading scene
      </span>
    </span>
  );
}
