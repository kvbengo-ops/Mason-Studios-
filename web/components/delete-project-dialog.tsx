"use client";

import { useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import { deleteProject } from "@/actions/project";

/**
 * Next's `notFound()` and `redirect()` both throw plain errors carrying a
 * `digest` string — that's how they signal "this is control flow, not a
 * failure" through render/action boundaries. Next doesn't publicly export a
 * predicate for the 404 case (only `unstable_rethrow`, which treats both
 * digests as "let it through unchanged"), so we match the digest prefix
 * ourselves: `notFound()` sets `NEXT_HTTP_ERROR_FALLBACK;404`, `redirect()`
 * sets a digest beginning `NEXT_REDIRECT`. Checking this first lets us
 * surface the 404 as a toast instead of letting it fall into
 * `unstable_rethrow`, which would rethrow it straight into the route's
 * error boundary and silently blank the page.
 */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")
  );
}

export function DeleteProjectDialog({
  open,
  onOpenChange,
  projectId,
  projectTitle,
}: {
  /**
   * Controlled, not self-contained — see components/account-menu.tsx's
   * header for why: this dialog's trigger is a DropdownMenu.Item in
   * components/project-row-actions.tsx, and Radix unmounts a menu's Content —
   * everything nested in it — the instant the menu closes, which happens on
   * the very click that would open a nested dialog. Owning its own open
   * state (the old `useState(false)` here) would have this torn down before
   * it ever got the chance to render. Rendering it as a SIBLING of the menu,
   * with `open` owned by the caller, is the documented Radix pattern for
   * "dialog opened from a menu item," not an improvised fix.
   */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectTitle: string;
}): JSX.Element {
  const [isPending, startTransition] = useTransition();

  function handleDelete(): void {
    startTransition(async () => {
      try {
        // deleteProject (actions/project.ts) always either throws (a real
        // DB failure) or redirect()s to /projects on success — it never
        // returns an ActionResult — so unlike every dialog with an inline
        // errorMessage state, there is nothing to surface but a thrown
        // error. Before this, that throw had no catch at all: an unhandled
        // rejection inside startTransition's async callback, which (absent
        // a redirect) surfaces as this project's own worst-case failure
        // mode — the whole route's error boundary replacing the page,
        // exactly what action-form.tsx exists to prevent everywhere else.
        await deleteProject(projectId);
      } catch (error) {
        // A successful delete redirect()s — that's a thrown NEXT_REDIRECT
        // control-flow error, not a failure — and requireProject can also
        // throw a notFound() (e.g. the row isn't owned by this user, or
        // was already deleted) which is control flow too but IS a failure
        // we need to tell the user about. Handle the 404 case first so it
        // surfaces as a toast; unstable_rethrow only sees genuine redirects
        // (and any other Next control-flow error) after that, same
        // reasoning as every other dialog wrapping a redirecting action
        // (see scene-rerender-dialog.tsx).
        if (isNotFoundError(error)) {
          toast.error("This project is no longer available, or isn't yours to delete.");
          return;
        }
        unstable_rethrow(error);
        toast.error(error instanceof Error ? error.message : "Failed to delete project.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete &ldquo;{projectTitle}&rdquo;?</DialogTitle>
          <DialogDescription>
            This permanently deletes the project, its scenes, and any generated assets. This cannot
            be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <PendingButton variant="destructive" onClick={handleDelete} pending={isPending}>
            Delete
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
