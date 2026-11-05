import type { JSX } from "react";
import { cn } from "@/lib/utils";

/**
 * The GitHub Actions in-progress ring: a pale full TRACK with one solid arc
 * of fixed length turning on top of it.
 *
 * Fixed length is the correction. This started as a Material-style
 * indeterminate sweep — an arc that grows and shrinks as it rotates — which
 * is a different spinner from a different design system, and it read as
 * wrong next to the real thing: the stroke visibly stretched and collapsed
 * instead of holding its shape while it turned.
 *
 * So the only motion is rotation. The track is what makes the arc read as
 * "part of a ring, going round" rather than as a broken C; without it the
 * arc alone has nothing to travel against.
 *
 * `animate-spin` stays on the <svg>: it is the whole animation now, and it
 * is also the selector every existing test and call site already matches.
 * Unguarded by motion-safe:, same argument as status-icon.tsx — this is the
 * only thing distinguishing WORKING from a dead control.
 *
 * The circumference at r=9 is ~56.5, so "16 41" leaves a little under a
 * third of the ring filled.
 */
export function Spinner({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cn("size-4 shrink-0 animate-spin", className)}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        opacity="0.3"
      />
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="16 41"
      />
      {/* The dot GitHub puts at the centre of its in-progress badge. It sits
          on the rotation axis, so it is unaffected by the spin — it reads as
          a still centre the ring turns around, which is what stops the whole
          glyph from looking like an empty hoop. */}
      <circle cx="12" cy="12" r="4.5" fill="currentColor" />
    </svg>
  );
}
