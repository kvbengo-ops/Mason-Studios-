import type { JSX } from "react";
import { cn } from "@/lib/utils";

// Shared "in-flight" text treatment: a soft highlight gradient swept across
// a status label, the way Claude animates its own working text. Same
// accessible-name contract as status-icon.tsx (role="status" wrapper +
// sr-only label) so the two components read the same way to a screen
// reader — the visible, shimmering copy is aria-hidden and a plain-text
// duplicate carries the meaning instead, which also means the DOM text
// content never has a transparent gradient run through what a screen
// reader (or a "find in page") would see.
//
// Getting `background-clip: text` to respect the caller's colour (tiles are
// colour-coded per status via STATUS_CLASS in render-progress.tsx, e.g.
// `text-chart-1`) takes more than `text-transparent bg-gradient-to-r`:
// Tailwind's `text-transparent` sets the `color` property itself to
// transparent, and `currentColor` inside a gradient on that *same* element
// resolves against that same `color` value — so the gradient would be built
// from transparent and never show anything. The fix is to leave `color`
// alone (so `currentColor` still resolves to the real, inherited status
// colour) and instead blank out only the glyph ink via
// `-webkit-text-fill-color: transparent`, which is a separate paint
// property from `color`. What's left behind is a transparent hole in the
// shape of the letters, and the background — the gradient built from that
// same untouched `currentColor` — shows through it.
//
// The sweep deliberately does NOT sit behind `motion-safe:`, for the same
// reason status-icon.tsx's ring doesn't — see that file's header. A
// gradient travelling across a short status label is small, in place, and
// the only thing distinguishing "this action is running" from "this label
// is stuck"; reduced-motion is aimed at large decorative movement, not at
// essential progress feedback.
//
// That removal also deletes a trap: `motion-safe:` alone was never enough
// here, because a suppressed animation lands on its *static first frame* —
// the transparent trough of the gradient — not the resting legible state,
// so an explicit `motion-reduce:` had to put the fill back to
// `currentColor`. With the sweep always running, neither guard is needed,
// and there is no longer a frozen-mid-fade state to defend against. Keep
// the two in step: if the sweep is ever put back behind `motion-safe:`,
// the `motion-reduce:` fill override has to come back with it.
export function ShimmerText({
  label,
  animated = true,
  className,
}: {
  label: string;
  // false renders plain, static text — same "waiting vs. in-flight"
  // distinction status-icon.tsx draws between its `queued` glyph and its
  // spinning `rendering` one: only work actually running gets the shimmer,
  // not "loading" in general.
  animated?: boolean;
  className?: string;
}): JSX.Element {
  return (
    // aria-label, not just the sr-only child's text content: ARIA's
    // accessible-name computation for role="status" is "name from author"
    // only (unlike e.g. a button, it does not fall back to concatenating
    // visible content) — a sr-only span alone here would render, correctly,
    // to an *empty* accessible name. status-icon.tsx has this exact shape
    // for the same reason.
    <span role="status" aria-label={label} className="inline-flex">
      <span
        aria-hidden="true"
        className={cn(
          animated && [
            "bg-clip-text [-webkit-background-clip:text] [-webkit-text-fill-color:transparent]",
            "bg-no-repeat animate-shimmer",
          ],
          className,
        )}
        style={
          animated
            ? {
                backgroundImage:
                  "linear-gradient(90deg, currentColor 35%, color-mix(in oklab, currentColor 45%, transparent) 50%, currentColor 65%)",
                backgroundSize: "200% 100%",
              }
            : undefined
        }
      >
        {label}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
