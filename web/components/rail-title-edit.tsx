"use client";

// The project title in the rail header, renamed in place.
//
// Renaming used to need its own card on the /settings page — the only place
// in the app that could do it. That card is gone: the title is already ON
// SCREEN in the rail on every route, and a second copy of it in a panel
// below was a form competing with a label for the same fact. A pencil beside
// the name it edits is the shortest distance between seeing the wrong name
// and fixing it.
//
// Reads as a label until you reach for it: no box, no button, just the
// heading and a pencil that appears on hover or keyboard focus. The rail is
// navigation, and a permanently-drawn input in it would compete with the
// rows below for the eye.

import { useEffect, useRef, useState, type JSX } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { saveTitle } from "@/actions/settings";
import { MAX_TITLE_LENGTH } from "@/lib/title-guard";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/submit-button";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";

export function RailTitleEdit({
  projectId,
  title,
  readOnly = false,
}: {
  projectId: string;
  title: string;
  /** A non-owning admin. saveTitle refuses the write anyway; this only hides the control. */
  readOnly?: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    // Select the whole name, not just place a caret: renaming is almost
    // always replacing, and "test6" is faster to overwrite than to clear.
    inputRef.current?.select();
  }, [editing]);

  if (readOnly) {
    return <h2 className="font-semibold text-foreground">{title}</h2>;
  }

  if (!editing) {
    return (
      <div className="group flex items-center gap-1.5">
        <h2 className="min-w-0 break-words font-semibold text-foreground">{title}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Rename ${title}`}
          onClick={() => setEditing(true)}
          // Invisible until wanted, but never unreachable: focus-visible
          // brings it back for a keyboard, which opacity-0 alone would have
          // left permanently hidden while still being tab-focusable — a
          // control you can land on and cannot see.
          className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100 focus-visible:opacity-100"
        >
          <Pencil className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <ActionForm
      action={async (formData: FormData) => {
        const result = await saveTitle(projectId, formData);
        if (result?.error) {
          toast.error(result.error);
          return result;
        }
        setEditing(false);
        return result;
      }}
      fallbackErrorMessage="Failed to save project title."
      className="flex flex-col gap-1.5"
    >
      <Input
        ref={inputRef}
        name="title"
        required
        maxLength={MAX_TITLE_LENGTH}
        defaultValue={title}
        aria-label="Project title"
        className="h-8 text-sm"
        onKeyDown={(e) => {
          // Escape abandons the rename. Without it the only way out of the
          // field is to save something, which turns a misclick on the pencil
          // into a forced edit.
          if (e.key === "Escape") setEditing(false);
        }}
      />
      <div className="flex gap-1.5">
        <SubmitButton size="sm" className="h-7 px-2 text-xs" pendingLabel="Saving…">
          Save
        </SubmitButton>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setEditing(false)}
        >
          Cancel
        </Button>
      </div>
    </ActionForm>
  );
}
