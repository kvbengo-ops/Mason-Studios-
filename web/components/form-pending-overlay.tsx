"use client";

// The spinner that says "this tile is loading", for a tile whose control is
// a form submit rather than a <Link> — the useFormStatus counterpart to
// link-pending-overlay.tsx. Read that file first; the argument for an
// overlay over a content swap is the same, only the pending source differs.
//
// WHY THIS EXISTS. ugc-version-rail.tsx's version tile is a poster, a label
// and a current/superseded marker, wrapped in a SubmitButton. SubmitButton's
// own pending state (see its header) REPLACES `children` wholesale with a
// spinner and a short label — the right call for an ordinary button, where
// a word swapping for a spinner reads fine, and wrong for THIS tile: the
// poster is the one thing an operator is on this rail to compare, and the
// moment they clicked it, it vanished and was replaced by a small ring and
// the word "Setting" where the picture had been. The rail jumped and the
// take being compared disappeared mid-comparison.
//
// SubmitButton itself is not touched — Compile, Recompile and Save are all
// short labels the swap is correct for, and depend on it. Instead this
// renders as a SIBLING inside the same <form>: useFormStatus reports that
// form's pending state to any descendant of it, not only to the element
// that submits it, so this can sit on top of the tile's own always-rendered
// content without SubmitButton knowing it exists or changing what it does.
import type { JSX } from "react";
import { useFormStatus } from "react-dom";
import { Spinner } from "@/components/spinner";
import { cn } from "@/lib/utils";

export function FormPendingOverlay({
  label,
  className,
}: {
  /** Announced to a screen reader while pending — see role="status" below. */
  readonly label: string;
  readonly className?: string;
}): JSX.Element | null {
  const { pending } = useFormStatus();
  if (!pending) return null;

  return (
    <span
      // Same shape as link-pending-overlay.tsx, on purpose: the tile that
      // gets pressed here sits right beside the scene strip on the same
      // screen, and an operator should not be able to tell, by feel, which
      // of the two pending states they are looking at.
      //
      // aria-hidden with a visually-hidden live region beside it: a spinner
      // is a picture, and a screen reader needs the sentence. role="status"
      // announces without stealing focus, which matters because the
      // operator is mid-click on a rail they are comparing takes in.
      className={cn(
        "pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-background/60",
        className,
      )}
    >
      <Spinner aria-hidden="true" />
      <span className="sr-only" role="status">
        {label}
      </span>
    </span>
  );
}
