import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A placeholder in the shape of the thing being loaded.
 *
 * SHIMMER, NOT PULSE. shadcn ships this as `animate-pulse` — the whole box
 * fading in and out — which reads as "this element is idle/disabled" as
 * readily as "this is loading", and sits still-looking beside the rest of a
 * page that is already dimmed. A highlight travelling across the box has a
 * direction, so it reads as progress rather than as state.
 *
 * The sweep reuses `--animate-shimmer` / `@keyframes shimmer-sweep`, the
 * same pair components/shimmer-text.tsx uses for in-flight status labels —
 * one motion vocabulary for "work is running", whether it is a word or a
 * frame. The keyframes live once per theme file under config/themes/, per
 * that directory's convention, so this works under every theme.
 *
 * `bg-[length:200%_100%]` is what makes the sweep visible at all: the
 * gradient has to be wider than the box for moving its background-position
 * to move anything. Without it the animation runs and nothing appears to
 * happen — which looks exactly like a frozen page, the opposite of the
 * intent.
 *
 * NOT behind `motion-safe:`, and that was a bug for about ten minutes. The
 * reasoning "a suppressed sweep lands on a flat tinted box, which is a fine
 * static placeholder" was true when a spinner and a sentence sat beside it.
 * Both were removed the same afternoon, which made this the ONLY signal that
 * a paid call is running — so under reduced motion the screen went
 * completely quiet while $0.02 was being spent. shimmer-text.tsx reached the
 * same conclusion for the same reason; see its header. Reduced-motion is
 * aimed at large decorative movement, not at the one thing telling you work
 * is in progress.
 *
 * `bg-no-repeat` matters as much as the size: a 200%-wide gradient that
 * tiles has no edges to travel, so the sweep reads as a faint pulse instead
 * of a moving highlight.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "bg-accent rounded-md",
        // The highlight is muted-foreground/35, not /15. At /15 the band was
        // inside the noise of the base colour on a dark theme — the gradient
        // rendered, the animation ran, and it looked like a static box.
        "bg-gradient-to-r from-accent via-muted-foreground/35 to-accent",
        "bg-[length:200%_100%] bg-no-repeat animate-shimmer",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
