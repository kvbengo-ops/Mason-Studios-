"use client";

// Character Library card control (character/page.tsx's Character Library
// card). Not a plain ActionForm/SubmitButton pair like the rest of this
// page: the bug this exists to fix is that clicking Use gave no feedback at
// all, and the grid can be scrolled away from the reference photo/
// description fields that actually change below it — a toast is the only
// feedback guaranteed to be seen regardless of scroll position, and
// ActionForm only toasts on *failure* (action-form.tsx), so a distinct
// success path is needed here.

import { useTransition } from "react";
import type { JSX } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PendingButton } from "@/components/pending-button";
// Aliased on import: eslint's react-hooks rule pattern-matches any
// `use*`-named call and treats it as a hook, which a Server Action named
// useCharacter (character-library.ts) trips even though it is an ordinary
// async function called from inside useTransition below, not a hook.
import { useCharacter as callUseCharacter } from "@/actions/character-library";

export function UseCharacterButton({
  projectId,
  characterId,
  name,
  inUse,
  locked,
  closeHref,
}: {
  projectId: string;
  characterId: string;
  name: string;
  /** Whether `projects.source_character_id` already points at this card — see 0021_project_character_source.sql. */
  inUse: boolean;
  locked: boolean;
  /**
   * Route to land on once the copy has happened — the bare Character page,
   * which is what closes the library dialog.
   *
   * Navigating INSIDE the same transition is what keeps the button's
   * spinner turning until the new page is actually ready: the dialog used
   * to sit there looking idle while the copy ran, and then stay open over
   * a page that had already changed underneath it.
   */
  closeHref?: string;
}): JSX.Element {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleClick(): void {
    if (inUse) {
      // A silent no-op here is the exact bug this button exists to fix,
      // just in a new shape: the operator clicks Use on the card that's
      // already in use and, once again, nothing visibly happens. Saying so
      // is cheap and honest; re-running the copy would not be — it costs a
      // real Storage copy and a new `assets` row for a photo the project
      // already has, and the in-use badge below already shows this state.
      toast.success(`${name} is already in use.`);
      if (closeHref) router.replace(closeHref);
      return;
    }

    startTransition(async () => {
      try {
        const result = await callUseCharacter(projectId, characterId);
        if (result?.error) {
          toast.error(result.error);
        } else {
          toast.success(`Using ${name}.`);
          // Only on success: a failed copy must leave the dialog open with
          // the selection still made, so the operator can read the toast and
          // try again without hunting for the card a second time.
          if (closeHref) router.replace(closeHref);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to use character.");
      }
    });
  }

  return (
    <PendingButton
      type="button"
      size="sm"
      variant="outline"
      pending={pending}
      disabled={locked}
      onClick={handleClick}
      className="w-full"
    >
      Use
    </PendingButton>
  );
}
