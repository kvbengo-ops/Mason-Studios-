"use client";

// The Runs pill both /create tabs share. It sits beside the Image/Video switch
// (#create-runs-control) and, while anything is unfinished, spins, pings and
// counts the unfinished ones — so pressing Generate has a visible destination.
// Pages without that slot (/image-generator) get it pinned top-right instead.

import type { JSX } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { History } from "lucide-react";
import { DialogTrigger } from "@/components/ui/dialog";
import { Spinner } from "@/components/spinner";
import { cn } from "@/lib/utils";

export function RunsTrigger({
  total,
  active,
  activeLabel,
  ariaLabel,
}: {
  total: number;
  active: number;
  /** What the pill says while something is unfinished, e.g. "Generating". */
  activeLabel: string;
  ariaLabel: string;
}): JSX.Element | null {
  // undefined until mounted: rendering before the slot is looked up would
  // flash the pinned fallback on /create.
  const [slot, setSlot] = useState<HTMLElement | null | undefined>(undefined);
  /* eslint-disable react-hooks/set-state-in-effect -- wait for the fixed Create header slot to mount. */
  useEffect(() => {
    setSlot(document.getElementById("create-runs-control"));
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */
  if (slot === undefined) return null;

  const busy = active > 0;
  const trigger = (
    <DialogTrigger asChild>
      <button
        type="button"
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-xl border bg-background/80 px-3 text-sm text-foreground shadow-lg backdrop-blur-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          busy ? "border-primary/60 ring-2 ring-primary/25" : "border-border",
          slot ? null : "fixed right-6 top-20 z-40",
        )}
        aria-label={ariaLabel}
      >
        {busy ? (
          <span className="relative flex size-4 items-center justify-center">
            <Spinner />
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 size-2 rounded-full bg-primary motion-safe:animate-ping"
            />
          </span>
        ) : (
          <History className="size-4" aria-hidden="true" />
        )}
        {busy ? activeLabel : "Runs"}
        <span
          className={cn(
            "text-xs tabular-nums",
            busy ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {busy ? active : total}
        </span>
      </button>
    </DialogTrigger>
  );
  return slot ? createPortal(trigger, slot) : trigger;
}
