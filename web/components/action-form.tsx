"use client";

// Shared wrapper for every `<form>` in web/app/(app)/ whose action is a
// Server Action. Plain `<form action={serverAction}>` has no client-side
// error boundary of its own — when the action throws (e.g. a validation
// error), Next's route error boundary replaces the *entire page* with "This
// page couldn't load." That is catastrophic for something as routine as
// "you forgot to pick a file." This component intercepts the submission,
// awaits the action itself, and turns a thrown error into a toast instead
// — same pattern as components/frame-grid.tsx, just generalised to a form.
//
// IMPORTANT: this is a Client Component, but most of its call sites are
// Server Components (character/page.tsx, brief/page.tsx, etc). Only two
// kinds of function may cross that server->client prop boundary: a "use
// server" Server Action (React serialises it as a reference), or nothing
// at all. A plain closure (e.g. a per-field validator, or a render-prop
// `children` function) is NOT serialisable and throws at request time —
// "Functions cannot be passed directly to Client Components" — even though
// tsc and eslint are both silent about it.
//
// Pending state and disabling: rather than a `pending` value threaded
// through props (same server/client boundary problem — the caller can't
// pass a function that reads it), this uses the native
// `<form action={fn}>` + `useFormStatus()` mechanism. `action` here is a
// plain async client function (not a Server Action reference), which React
// still tracks via useFormStatus in any descendant — see
// components/pending-fieldset.tsx and components/submit-button.tsx.

import type { JSX, ReactNode } from "react";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import { stageFiles } from "@/lib/stage-files";
import type { ActionNotice, ActionResult } from "@/lib/action-result";

export interface ActionFormProps {
  /**
   * The Server Action (or a `.bind(null, ...)` partial of one) this form
   * submits to. `Promise<ActionResult | void>` rather than
   * `Promise<ActionResult>` so actions that have nothing to guard against
   * (and so still just return `Promise<void>`) remain valid callers too —
   * see lib/action-result.ts for why a guard failure has to come back as
   * data instead of being thrown.
   */
  action: (formData: FormData) => Promise<ActionResult | ActionNotice | void>;
  className?: string;
  /** Shown when a thrown error has no `.message` (e.g. a non-Error throw). */
  fallbackErrorMessage?: string;
  children: ReactNode;
}

export function ActionForm({
  action,
  className,
  fallbackErrorMessage = "Something went wrong.",
  children,
}: ActionFormProps): JSX.Element {
  async function handleAction(formData: FormData): Promise<void> {
    try {
      await stageFiles(formData);
      const result = await action(formData);
      // A guard failure (locked settings, over budget, wrong scene status,
      // …) comes back as data, not a throw — see lib/action-result.ts. A
      // successful call that doesn't redirect returns undefined.
      if (result && "error" in result && result.error) {
        toast.error(result.error);
      } else if (result && "notice" in result && result.notice) {
        // NOT toast.error. The action worked; this is a fact about what it
        // did, and dressing it as a failure would teach an operator to
        // distrust a render that is fine apart from one missing reference.
        // Longer than the default because it names something to go and fix.
        toast(result.notice, { duration: 8000 });
      }
    } catch (err) {
      // redirect()/notFound() work by throwing an error tagged with a
      // NEXT_REDIRECT/NEXT_NOT_FOUND digest — that's Next's control-flow
      // mechanism, not a failure. unstable_rethrow re-throws exactly
      // those and lets them fall through to Next's navigation handling;
      // anything else (a real thrown error) continues past it to the
      // toast below. Without this, a successful action that redirects
      // (e.g. approveBrief, compileScript, createProject) would have its
      // navigation swallowed here and get misreported as a failure.
      unstable_rethrow(err);
      toast.error(err instanceof Error ? err.message : fallbackErrorMessage);
    }
  }

  return (
    <form action={handleAction} className={className}>
      {children}
    </form>
  );
}
