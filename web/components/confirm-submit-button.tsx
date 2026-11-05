"use client";

// The smallest possible confirm gate for an ActionForm submit.
//
// ActionForm (components/action-form.tsx) submits via a plain
// `<form action={fn}>` — there is no hook in it for "ask first," and giving
// it one would mean threading a confirm prompt through every call site that
// doesn't want it. A submit button already gets exactly one chance to stop
// the submission before it starts: the click event fires before the
// browser's native "submit this form" default action does. Calling
// preventDefault() on THAT click is the whole mechanism — no dialog state,
// no useTransition, nothing else for this component to own.
//
// window.confirm, not a styled dialog: this mirrors UgcTileMenu's own
// confirmMessage (components/ugc-tile-menu.tsx), which reaches for the same
// browser-native prompt for the identical reason — a modal here would be one
// more component owning open/close state for a question the operator answers
// in a single click either way.

import type { JSX, MouseEvent } from "react";
import { SubmitButton, type SubmitButtonProps } from "@/components/submit-button";

export interface ConfirmSubmitButtonProps extends SubmitButtonProps {
  /** Asked via window.confirm before the click is allowed to submit the form. */
  confirmMessage: string;
}

export function ConfirmSubmitButton({
  confirmMessage,
  onClick,
  ...props
}: ConfirmSubmitButtonProps): JSX.Element {
  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    if (!window.confirm(confirmMessage)) {
      // Stops the click's default action — submitting the enclosing form —
      // without touching the form itself. Nothing was submitted, so there is
      // nothing to undo.
      event.preventDefault();
      return;
    }
    onClick?.(event);
  }

  return <SubmitButton {...props} onClick={handleClick} />;
}
