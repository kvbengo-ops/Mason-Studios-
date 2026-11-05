"use client";

import { useState, type JSX, type ReactNode } from "react";
import { Info } from "lucide-react";

/**
 * A small info glyph whose explanation appears on hover or focus.
 *
 * Standing guidance that an operator needs once — what a field is for, what
 * happens if it is left thin — used to sit as a paragraph under every field,
 * which pushed the actual controls down the page and turned instructions
 * into wallpaper. Behind a glyph it is still one gesture away and stops
 * competing with the work.
 *
 * Keyboard-reachable on purpose: the trigger is a real <button>, so the hint
 * opens on focus as well as hover, and its text is the button's accessible
 * description rather than a hover-only secret.
 */
export function InfoHint({ children }: { children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label="More information"
        aria-expanded={open}
        className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
      >
        <Info aria-hidden="true" className="size-4" />
      </button>
      {open ? (
        <span
          role="tooltip"
          className="absolute left-0 top-6 z-50 w-80 max-w-[min(20rem,calc(100vw-2rem))] rounded-md border border-border bg-popover p-3 text-xs font-normal leading-relaxed text-popover-foreground shadow-md"
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
