"use client";

// Submit button for an ActionForm. Reads pending state from the nearest
// parent <form> via useFormStatus rather than taking it as a prop — a
// Server Component page can't hand this a function that reads local state,
// so the pending flag has to come from React's own form-status tracking,
// not prop-drilling. Doubles as the double-submit guard: disabled while
// pending means a second click can't fire a second (possibly paid) action
// call before the first one settles.
//
// The pending state renders the ring-plus-shimmer treatment rather than a
// bare swapped label. That treatment was built once and then reached only
// the upload path, so every ActionForm in the app — Compile, Recompile,
// Save — went dead-static the moment it was clicked, which is
// indistinguishable from a hung button on work that can legitimately run
// for tens of seconds. Keep this in step with upload-button.tsx (same
// ring + ShimmerText, for a form that submits itself on file pick) and
// pending-button.tsx (the same ring for actions that are not a form
// submit): one in-flight look, three entry points, and a fourth idiom
// would give the same state a fourth face.

import { useFormStatus } from "react-dom";
import { Spinner } from "@/components/spinner";
import type { ComponentProps, JSX, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ShimmerText } from "@/components/shimmer-text";

export interface SubmitButtonProps extends Omit<
  ComponentProps<typeof Button>,
  "type" | "disabled"
> {
  /** Label shown while the form's action is in flight. */
  pendingLabel: ReactNode;
  /**
   * Server-computed reason to disable the button even when idle (e.g. the
   * action has no valid input to act on yet). A boolean, not a closure, so
   * a Server Component can pass it down — see action-form.tsx's note on
   * why functions can't cross that boundary. ORed with the pending state,
   * never overrides it.
   */
  disabled?: boolean;
}

export function SubmitButton({
  children,
  pendingLabel,
  disabled,
  ...buttonProps
}: SubmitButtonProps): JSX.Element {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} {...buttonProps}>
      {pending ? (
        <span className="inline-flex items-center gap-2">
          {/* The GitHub Actions spinner, not dots. Asked for explicitly
              during the UI pass and asked for again after this button
              shipped with three bouncing dots: a ring is what people read
              as "a job is running", and three pulsing dots are what this
              app also draws for "nothing here yet", so the two states were
              wearing the same clothes.
              Unguarded by motion-safe:, same reasoning as status-icon.tsx —
              under reduced motion the disabled state still reads, but the
              spinner is the only thing that says WORKING rather than
              UNAVAILABLE. */}
          <Spinner />
          {typeof pendingLabel === "string" ? <ShimmerText label={pendingLabel} /> : pendingLabel}
        </span>
      ) : (
        children
      )}
    </Button>
  );
}
