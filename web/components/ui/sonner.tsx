"use client";

import { Toaster as Sonner } from "sonner";
import type { ToasterProps } from "sonner";
import type { CSSProperties, JSX } from "react";

const Toaster = ({ ...props }: ToasterProps): JSX.Element => {
  return (
    <Sonner
      className="toaster group"
      // ABOVE THE DIALOG, SAID OUT LOUD. sonner ships its own
      // z-index: 999999999, which is already above a Radix overlay's z-50 —
      // but only while nothing between them opens a stacking context, and
      // that is one CSS `transform` on a wrapper away from silently
      // stopping. A refusal painted under the modal it belongs to is a
      // refusal nobody reads, which is the whole failure this replaced.
      style={
        {
          zIndex: 2147483647,
          // hsl() around each: the theme files store these tokens as bare
          // HSL triplets ("220 40% 99%"), which are not colours on their
          // own. Passed through raw, the toast's background resolved to
          // nothing and it rendered see-through — over an open dialog's
          // dimmed overlay it looked like it was sitting underneath it.
          "--normal-bg": "hsl(var(--popover))",
          "--normal-text": "hsl(var(--popover-foreground))",
          "--normal-border": "hsl(var(--border))",
        } as CSSProperties
      }
      // EXPANDED, because these arrive in batches. Dropping eight files can
      // raise three at once (two too big, one over the cap), and collapsed
      // sonner stacks them: the front one is readable and the rest are dimmed
      // slivers behind it. Every one of them names a different file.
      expand
      // COLOURED BY KIND. This app raises both — toast.success on a
      // delivery or a rebuild, toast.error on a refusal — and both were the
      // same neutral popover card with a small glyph. A refusal that looks
      // exactly like a confirmation gets dismissed as one.
      richColors
      {...props}
    />
  );
};

export { Toaster };
