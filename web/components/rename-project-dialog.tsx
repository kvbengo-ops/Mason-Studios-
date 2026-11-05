"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { JSX } from "react";
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
import { Input } from "@/components/ui/input";
import { PendingButton } from "@/components/pending-button";
import { MAX_TITLE_LENGTH } from "@/lib/title-guard";
import { renameProject } from "@/actions/project";

/**
 * Rename, opened from the projects list's row-actions menu
 * (project-row-actions.tsx). Same controlled, sibling-of-the-menu shape as
 * DeleteProjectDialog, and for the same reason — see that component's own
 * header comment for why `open` has to be owned by the caller rather than
 * this dialog's own useState: Radix tears a menu's Content down (this
 * dialog included, if it were nested in it) the instant the menu closes,
 * which happens on the very click that would open it.
 *
 * The input, not a plain `<form>`+ActionForm: renameProject takes
 * `(id, title)` directly rather than FormData, because the two other
 * places a project's title is edited (RailTitleEdit, UgcTitle) are both
 * inline widgets sized to look like the heading they replace, and neither
 * shape fits a modal opened from a menu. This is closer in spirit to
 * DeleteProjectDialog's own confirm-in-a-dialog interaction than to either
 * of those.
 */
export function RenameProjectDialog({
  open,
  onOpenChange,
  projectId,
  projectTitle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectTitle: string;
}): JSX.Element {
  const [value, setValue] = useState(projectTitle);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-seed from the CURRENT title every time the dialog opens, not just on
  // mount — this dialog is a long-lived sibling of the menu (see the header
  // comment above), so it stays mounted across opens/closes and a stale
  // `useState(projectTitle)` would keep showing whatever title the row had
  // the first time this ever opened.
  useEffect(() => {
    if (!open) return;
    // Re-seeding on open IS this effect's purpose, and the early return above
    // means it runs once per open rather than cascading. React's
    // adjust-state-during-render alternative would have to key on `open`
    // alone, dropping projectTitle — so a title that changed while the dialog
    // was open would stop being picked up. The effect also has to stay for the
    // .select() below, a DOM call that belongs nowhere else.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    setValue(projectTitle);
    // Select the whole name, not place a caret: same reasoning
    // RailTitleEdit/UgcTitle already settled on — a rename is almost always
    // a full replacement ("New project" -> something real), so the fast
    // path is type-and-Enter over the selection, not clear-then-type.
    inputRef.current?.select();
  }, [open, projectTitle]);

  function handleRename(): void {
    startTransition(async () => {
      try {
        // renameProject never throws for an ordinary refusal (empty title,
        // unowned project) — those come back as an ActionResult, per
        // lib/action-result.ts's own reasoning: only a returned message
        // survives React's production error-redaction. A thrown error here
        // is a genuine failure (a Postgres error), same split every other
        // dialog in this file's family (delete-project-dialog.tsx) draws
        // between its ActionResult branch and its catch.
        const result = await renameProject(projectId, value);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        onOpenChange(false);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to rename project.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>Choose a new name for &ldquo;{projectTitle}&rdquo;.</DialogDescription>
        </DialogHeader>
        {/* No <form>: Enter is wired by hand below instead of relying on a
            submit event, since this isn't posting FormData (renameProject
            takes the title as a plain argument — see this file's header
            comment for why). Escape isn't handled here at all — Radix's
            DialogContent already closes on Escape regardless of which
            element inside it has focus, so a second handler here would
            just be a second implementation of the same rule to keep in
            sync. */}
        <Input
          ref={inputRef}
          value={value}
          maxLength={MAX_TITLE_LENGTH}
          aria-label="Project title"
          disabled={isPending}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleRename();
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <PendingButton onClick={handleRename} pending={isPending}>
            Rename
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
