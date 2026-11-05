"use client";

// Disables every input/textarea/button inside an ActionForm while its
// action is in flight, via the native <fieldset disabled> behaviour rather
// than threading a `disabled` prop through each field by hand. `pending`
// comes from useFormStatus (see submit-button.tsx for why it can't be a
// prop). `display: contents` (Tailwind `contents`) keeps the fieldset from
// affecting layout — its default border/padding/box never renders, so the
// children lay out exactly as if this wrapper weren't here.
import { useFormStatus } from "react-dom";
import type { JSX, ReactNode } from "react";

export function PendingFieldset({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const { pending } = useFormStatus();
  return (
    <fieldset disabled={pending} className={className ? `contents ${className}` : "contents"}>
      {children}
    </fieldset>
  );
}
