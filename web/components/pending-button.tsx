"use client";

import type { ComponentProps, JSX } from "react";
import { Spinner } from "@/components/spinner";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

export interface PendingButtonProps extends ComponentProps<typeof Button> {
  /**
   * In flight, for actions that are not a form submit — a fetch, a
   * useTransition, a dialog's own async handler.
   *
   * When omitted, the pending state comes from useFormStatus, which is the
   * right answer inside a <form action={...}>. When passed, it WINS: a caller
   * that has gone to the trouble of computing this has a reason, and silently
   * ignoring it in favour of a form status that is false is how a button ends
   * up spinning for nobody.
   */
  pending?: boolean;
}

/**
 * A button that spins and disables itself while its action is in flight.
 *
 * The point is the double-click, not the decoration. Every action this wraps
 * spends money — a compile is $0.12, a Seedance render is $1.89 and up — and
 * a button that looks identical before and after the click invites a second
 * one. Disabling is the load-bearing half; the spinner is what says why.
 *
 * `disabled` and `pending` are ORed, never chosen between. Real callers need
 * both at once and for different reasons — improve-description-button.tsx is
 * unclickable when the project is delivered, when the viewer isn't the owner,
 * when the textarea is empty, AND while its own call is in flight — so a
 * component that accepted only one of the two would push that OR back out to
 * every caller. Combining them here is also what makes the dangerous
 * combination unrepresentable: `disabled={false}` cannot re-enable a pending
 * button, so no caller can hand an operator a second click on a call that is
 * already running and already billing.
 *
 * The spinner's animation is unguarded by motion-safe:. Under
 * prefers-reduced-motion the disabled state still reads, but the spinner is
 * the only thing that says "working" rather than "unavailable", and dropping
 * it would leave those users with the two states looking the same.
 *
 * The label stays put while pending — swapping it for "Saving…" loses the one
 * word that says which button was pressed, which matters most on exactly the
 * screens that have several.
 */
function PendingButton({
  pending,
  disabled,
  children,
  ...buttonProps
}: PendingButtonProps): JSX.Element {
  // Safe to call unconditionally outside a form: useFormStatus returns
  // pending: false when there is no enclosing form action.
  const { pending: formPending } = useFormStatus();
  const isPending = pending ?? formPending;

  return (
    <Button disabled={disabled || isPending} {...buttonProps}>
      {isPending ? <Spinner /> : null}
      {children}
    </Button>
  );
}

export { PendingButton };
