"use client";

// The "Regenerate" control under the Character card's reference photo
// (character/page.tsx). Ordinarily a plain one-click action — same
// useAsyncAction pattern as remove-reference-button.tsx, for the same
// reason: no surrounding <form> around a photo overlay, so pending state
// can't come from useFormStatus.
//
// Gated behind a confirmation dialog only when the current photo was
// picked from the Character Library (`source_character_id` set — see the
// "Picked from your library as X" provenance line this control sits under).
// Regenerate silently overwrote a deliberately-chosen library character
// with a freshly generated, unrelated photo — no warning, and the
// provenance line vanished with it (correctly, per useCharacter's doc
// comment: the label is only honest while the photo matches, and
// regenerating breaks that). An operator lost their chosen character this
// way within a minute of the card shipping. A plain regenerate of a
// photo the operator generated themselves is not destructive in the same
// sense — nothing chosen is lost, just money re-spent — so that path stays
// a single click, unchanged.

import { useState } from "react";
import type { JSX } from "react";
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
import { RAIL_ENTRY_CHARACTER } from "@/lib/project-rail";
import type { ActionResult } from "@/lib/action-result";

export function RegenerateCharacterButton({
  action,
  disabled,
  costLabel,
  /** Name of the library character this project's photo was picked from, or null if the photo isn't from the library (e.g. uploaded or previously generated). */
  libraryCharacterName,
}: {
  action: () => Promise<ActionResult>;
  disabled: boolean;
  /** Pre-formatted, e.g. "$0.02" — usdFormatter.format(REF_FRAME_COST_USD) from the caller. */
  costLabel: string;
  libraryCharacterName: string | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // useAsyncAction, not useTransition: a pending transition blocks the rail's
  // own navigation, which is exactly what the comment below promises does
  // NOT happen. See components/use-async-action.ts.
  const { pending: isPending, run } = useAsyncAction();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // The Character rail row spins for as long as this runs — the image call
  // is paid and takes several seconds, and the operator is free to walk to
  // another Setup screen while it does. The button's own ring stops the
  // second click; the rail is what still says "running" once this card is
  // no longer on screen. Clears on unmount, so navigating away mid-call
  // does not strand the row (see useRailBusyWhile).
  useRailBusyWhile(RAIL_ENTRY_CHARACTER, isPending);

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
        // The action's own errors are this component's to show — see the
        // hook's ERRORS ARE THE CALLER'S note. Previously a throw here
        // escaped the transition as an unhandled rejection and the card
        // said nothing at all.
        setErrorMessage(err instanceof Error ? err.message : "Failed to regenerate the character.");
      }
    });
  }

  // Non-library photo: the control this always was — one click, no gate.
  if (!libraryCharacterName) {
    return (
      <div className="flex flex-col items-start gap-1">
        <PendingButton
          type="button"
          variant="outline"
          size="sm"
          pending={isPending}
          disabled={disabled}
          onClick={handleConfirm}
        >
          {`Regenerate (${costLabel})`}
        </PendingButton>
        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
      </div>
    );
  }

  // Library photo: destructive-styled trigger and a confirmation naming
  // exactly what's lost, rather than reading as an ordinary refresh.
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!isPending) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="destructive" size="sm" disabled={disabled}>
          Replace {libraryCharacterName} ({costLabel})
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replace {libraryCharacterName} with a new photo?</DialogTitle>
          <DialogDescription>
            This photo was picked from your Character Library as {libraryCharacterName}.
            Regenerating replaces it with a freshly generated image, and this project stops being{" "}
            {libraryCharacterName}&apos;s photo. It costs {costLabel} and cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <PendingButton variant="destructive" onClick={handleConfirm} pending={isPending}>
            Replace
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
