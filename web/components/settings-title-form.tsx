"use client";

// The project's name. Its own tiny real <form> (not createSetupForm's
// shared empty-form pattern) — nothing else on settings/page.tsx interleaves
// with this one field, so a plain wrapping <form> is fine here, unlike
// Character/Product/Script where real upload/remove/regenerate forms sit
// physically between the fields.
//
// Deliberately its own write (actions/settings.ts's saveTitle, via
// actions/project.ts's updateProject) rather than folded into the
// Direction+Captions form on this same page: a title feeds no prompt, no
// render and no cost, so it never locks — see saveTitle's own doc comment.
// Bundling it with fields that DO lock would mean either a locked project
// can't rename itself (wrong — see character-setup-form.tsx's original
// TitleField history) or the lock check has to grow a per-field exception
// again, which is exactly the asymmetry moving Title to its own action was
// meant to remove.

import type { JSX } from "react";
import { saveTitle } from "@/actions/settings";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { PendingFieldset } from "@/components/pending-fieldset";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_TITLE_LENGTH } from "@/lib/title-guard";

export function TitleField({
  projectId,
  initialValue,
  readOnly = false,
}: {
  projectId: string;
  initialValue: string;
  /** requireProjectReadable's `isOwner: false` — a non-owning admin viewing this project. updateProject still refuses the write either way; this is cosmetic only. */
  readOnly?: boolean;
}): JSX.Element {
  return (
    <ActionForm
      action={saveTitle.bind(null, projectId)}
      fallbackErrorMessage="Failed to save project title."
      className="flex flex-col gap-2"
    >
      <PendingFieldset>
        <Label htmlFor="title" required>
          Project title
        </Label>
        <Input
          id="title"
          name="title"
          required
          maxLength={MAX_TITLE_LENGTH}
          defaultValue={initialValue}
          readOnly={readOnly}
          disabled={readOnly}
          placeholder="Q4 Launch — NeuroBlast SMN16-18"
        />
        {readOnly ? null : (
          <SubmitButton size="sm" className="self-start" pendingLabel="Saving…">
            Save title
          </SubmitButton>
        )}
      </PendingFieldset>
    </ActionForm>
  );
}
