"use client";

// The ✕ overlay on a character/product reference thumbnail
// (character/page.tsx). Not an ActionForm: there is no surrounding <form>
// for a button that sits on top of an <img>, so pending state can't come
// from useFormStatus (see action-form.tsx's header on that boundary) —
// this uses useAsyncAction instead, the same pattern as
// delete-project-dialog.tsx and render-confirm-dialog.tsx for exactly the
// same reason.
//
// Confirmed via a dialog rather than firing on click: a removed reference
// is not free to redo — a generated one costs real money to regenerate
// (lib/models.ts's REF_FRAME_COST_USD — see each caller's `description`
// prop for the actual dollar figure, sourced from there, not hardcoded
// here), and an uploaded one requires finding the file again — so a stray
// click on a small corner target must not be able to silently delete it.

import { useState } from "react";
import type { JSX } from "react";
import { XIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import { useRailBusyWhile } from "@/components/project-rail";
import { useAsyncAction } from "@/components/use-async-action";
import type { ActionResult } from "@/lib/action-result";

/**
 * Entry id used when the caller names no rail row. Matches nothing the rail
 * ever draws, so the hook (which must be called unconditionally) stays a
 * no-op rather than lighting some other screen's row.
 */
const NO_RAIL_ENTRY = "__no-rail-entry__";

export function RemoveReferenceButton({
  label,
  description,
  action,
  railEntryId,
}: {
  /** e.g. "character reference" / "product reference" — used in the dialog copy and aria-label. */
  label: string;
  /** Extra sentence about what's lost, e.g. the regeneration cost (REF_FRAME_COST_USD). */
  description: string;
  action: () => Promise<ActionResult>;
  /**
   * Rail row to spin while the removal runs, when this button sits on a
   * screen that owns one — RAIL_ENTRY_CHARACTER on the Character screen,
   * RAIL_ENTRY_PRODUCT on Product. Optional because the caller is the only
   * thing that knows: the same button removes a character photo, a product
   * photo, and the combined shot.
   */
  railEntryId?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // useAsyncAction, not useTransition: a pending transition holds the
  // rail's navigation until it settles. See components/use-async-action.ts.
  const { pending: isPending, run } = useAsyncAction();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useRailBusyWhile(railEntryId ?? NO_RAIL_ENTRY, railEntryId !== undefined && isPending);

  function handleConfirm(): void {
    setErrorMessage(null);
    run(async () => {
      try {
        const result = await action();
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        setOpen(false);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Failed to remove the reference.");
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Only the Cancel/✕ buttons in the dialog itself should be able to
        // close it while a delete is in flight — dismissing mid-request
        // (e.g. an accidental outside click) shouldn't hide whether it
        // actually succeeded.
        if (!isPending) {
          setOpen(next);
        }
      }}
    >
      <DialogTrigger asChild>
        {/* Visible circle stays size-6 (24px) — enlarging it would look
            clumsy sitting on a photo thumbnail on desktop. The touch target
            is instead grown with an invisible ::before that extends 10px
            past the button's own box on every side (24 + 10 + 10 = 44px,
            the accepted minimum), which is the standard expand-the-hit-area-
            not-the-artwork technique. It needs no `relative` of its own —
            the button is already `absolute`, which makes it the containing
            block its own pseudo-element positions against. Offset from the
            corner is right-3/top-3 (12px), not right-2/top-2, specifically
            so the 10px expansion has room to clear the corner without
            spilling past it: this button lives inside `overflow-hidden`
            image wrappers on some callers (character/page.tsx), and a hit
            area extending past that boundary would get silently clipped. */}
        <button
          type="button"
          aria-label={`Remove ${label}`}
          className="absolute right-3 top-3 flex size-6 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm transition-colors before:absolute before:-inset-2.5 before:content-[''] hover:bg-destructive hover:text-destructive-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {label}?</DialogTitle>
          <DialogDescription>
            This deletes the stored photo. {description} This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <PendingButton variant="destructive" onClick={handleConfirm} pending={isPending}>
            Remove
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
