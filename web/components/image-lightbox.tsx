"use client";

import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Maximize2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export function ImageLightbox({
  src,
  alt,
  className,
  showIcon = true,
  aside,
  onOpen,
  fullSrc,
  onFullSize,
  onThumbSize,
}: {
  /** The tile picture's natural pixel size, once it has loaded. */
  onThumbSize?: (size: { width: number; height: number }) => void;
  src: string;
  alt: string;
  className?: string;
  showIcon?: boolean;
  /** A details panel beside the picture (right on desktop, below on mobile). */
  aside?: ReactNode | ((close: () => void) => ReactNode);
  onOpen?: () => void;
  /** A higher-resolution picture for the open viewer; `src` shows until it arrives. */
  fullSrc?: string;
  /** The viewer picture's natural pixel size, once it has loaded. */
  onFullSize?: (size: { width: number; height: number }) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // A thumbnail that finished loading BEFORE React hydrated never fires
  // onLoad (the server-rendered <img> was already complete), so the wall would
  // never learn its shape. Read it here if it is already done.
  const thumbRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = thumbRef.current;
    if (img?.complete && img.naturalWidth > 0) {
      onThumbSize?.({ width: img.naturalWidth, height: img.naturalHeight });
    }
    // Once per picture; onThumbSize is a state setter in every caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  function handleOpenChange(nextOpen: boolean): void {
    setOpen(nextOpen);
    if (nextOpen) onOpen?.();
  }
  return (
    <>
      <button
        type="button"
        className="group relative block h-full w-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        aria-label={`View ${alt.toLowerCase()} full size`}
        onClick={() => handleOpenChange(true)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- signed image URL */}
        <img
          ref={thumbRef}
          src={src}
          alt={alt}
          className={className}
          loading="lazy"
          decoding="async"
          onLoad={(event) =>
            onThumbSize?.({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
        />
        {showIcon ? (
          <span
            className="absolute right-2 top-2 rounded-md bg-background/85 p-1.5 text-foreground opacity-80 shadow-sm transition-opacity group-hover:opacity-100"
            aria-hidden="true"
          >
            <Maximize2 className="size-4" />
          </span>
        ) : null}
      </button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none flex-col gap-2 overflow-hidden p-2 sm:max-w-none md:flex-row">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <div className="flex min-h-0 flex-1 items-center justify-center rounded-md bg-muted/40">
            {/* eslint-disable-next-line @next/next/no-img-element -- signed image URL */}
            <img
              src={fullSrc ?? src}
              alt={alt}
              className="h-full w-full object-contain"
              onLoad={(event) => {
                if (!fullSrc) return;
                const img = event.currentTarget;
                onFullSize?.({ width: img.naturalWidth, height: img.naturalHeight });
              }}
            />
          </div>
          {aside ? (
            <aside className="flex max-h-[45%] min-h-0 shrink-0 flex-col overflow-hidden rounded-xl bg-card md:max-h-none md:w-[22rem]">
              {typeof aside === "function" ? aside(() => handleOpenChange(false)) : aside}
            </aside>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
