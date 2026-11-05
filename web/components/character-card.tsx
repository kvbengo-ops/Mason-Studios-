"use client";

// One Character Library grid cell (library/page.tsx) — photo, name,
// description, and this row's edit/remove controls. Split out of the page
// itself because it needs local state the page (a Server Component) can't
// hold: whether this card's edit form is open, and whether its description
// is expanded past the 3-line clamp.
//
// Every function prop below is a real "use server" export (or a
// `.bind(null, id)` partial of one) handed down from library/page.tsx, the
// one kind of function safe to cross the Server->Client boundary — see
// action-form.tsx's header. Nothing here is a plain closure passed in from
// the server.
//
// Problem 1 (a saved description could never be corrected): every card
// gets this same edit form now, not just ones missing a description — the
// old page only rendered a description field in the no-description branch,
// which is how "nana" ended up permanently stuck on "an athletic woman"
// (demo/README.md's exact "vague description → different face every
// scene" failure). The no-description state stays visually distinct
// (destructive-bordered, no Cancel button — there's nothing to cancel back
// to) because useCharacter still refuses to hand that card to a project
// with no description of its own: it's a real blocker, not a preference.
//
// Problem 3 (grid noise): the old grid rendered an always-open name input,
// an always-visible Rename button, and a floating X on every one of up to
// eight cards at once — more UI chrome than photographs. This card instead
// shows a photo, a name, and a description by default; Edit and Remove
// only gain full opacity on hover/focus at the md breakpoint and up
// (matching nav-links.tsx's own md:group-hover pattern for its tooltip).
// Below md, hover doesn't exist as an input at all (this product's users
// are explicitly expected on mobile — AGENTS.md), so both controls render
// at full opacity there unconditionally rather than being undiscoverable
// behind a gesture touch can't perform.
import { useState } from "react";
import type { JSX } from "react";
import { PencilIcon } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { PendingFieldset } from "@/components/pending-fieldset";
import { RemoveReferenceButton } from "@/components/remove-reference-button";
import { CharacterThumbnail } from "@/components/character-thumbnail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action-result";
import { cn } from "@/lib/utils";

export function CharacterCard({
  name,
  description,
  imageUrl,
  updateCharacter,
  removeCharacter,
}: {
  name: string;
  description: string | null;
  imageUrl: string | null | undefined;
  updateCharacter: (formData: FormData) => Promise<ActionResult | void>;
  removeCharacter: () => Promise<ActionResult>;
}): JSX.Element {
  const hasDescription = Boolean(description);
  // Starts open when there's nothing to show yet — Problem 1 requires this
  // state to be immediately actionable, not one more click away.
  const [editing, setEditing] = useState(!hasDescription);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const showForm = editing || !hasDescription;

  return (
    <div className="group/card flex flex-col gap-2">
      <div className="relative">
        <CharacterThumbnail url={imageUrl} alt={name} className="border border-border" />
        <div className="opacity-100 transition-opacity md:opacity-0 md:group-hover/card:opacity-100 md:group-focus-within/card:opacity-100">
          <RemoveReferenceButton
            label={`library character "${name}"`}
            description="Projects that already picked this character keep their own copy of the photo and description — removing it here does not touch them."
            action={removeCharacter}
          />
        </div>
      </div>

      {showForm ? (
        <ActionForm
          action={async (formData) => {
            const result = await updateCharacter(formData);
            // A successful save has nothing left to correct — collapse
            // back to the read view. A failed one (ActionForm already
            // toasts the message) leaves the form open with what the
            // operator typed, exactly like every other ActionForm here.
            if (!result?.error) {
              setEditing(false);
            }
            return result;
          }}
          fallbackErrorMessage="Failed to save character."
          className={cn(
            "flex flex-col gap-2",
            !hasDescription && "rounded-md border border-dashed border-destructive/50 p-2",
          )}
        >
          <PendingFieldset className="flex flex-col gap-2">
            <Input
              name="name"
              required
              defaultValue={name}
              aria-label={`Name for ${name}`}
              className="min-w-0"
            />
            {!hasDescription ? (
              <p className="text-xs text-destructive">
                No description — projects without one of their own can&apos;t use this character
                yet.
              </p>
            ) : null}
            <Textarea
              name="description"
              required
              rows={4}
              defaultValue={description ?? ""}
              aria-label={`Description for ${name}`}
              placeholder="e.g. A woman in her late 20s, shoulder-length dark hair, cream linen shirt, sunlit kitchen."
            />
            <div className="flex gap-2">
              <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">
                Save
              </SubmitButton>
              {hasDescription ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </PendingFieldset>
        </ActionForm>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-medium text-foreground">{name}</p>
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={`Edit ${name}`}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground opacity-100 transition-opacity hover:bg-accent hover:text-accent-foreground md:opacity-0 md:group-hover/card:opacity-100 md:group-focus-within/card:opacity-100"
            >
              <PencilIcon className="size-3" aria-hidden />
              Edit
            </button>
          </div>
          {/* description is guaranteed non-null here — showForm covers the
              null case above. The toggle always renders regardless of
              whether 3 lines actually clip this particular description:
              the grid's column count (2 up, 3 from sm:) changes how much
              text 3 lines actually holds, so there's no reliable way to
              know from the string alone whether it clipped — and an inert
              toggle on a short description costs nothing, where a missing
              one on a long description is the exact bug this page shipped
              with (truncated with an ellipsis and no way to read the
              rest). */}
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <p className={descriptionExpanded ? "whitespace-pre-wrap" : "line-clamp-3"}>
              {description}
            </p>
            <button
              type="button"
              onClick={() => setDescriptionExpanded((expanded) => !expanded)}
              className="self-start text-[11px] font-medium text-foreground underline underline-offset-2"
            >
              {descriptionExpanded ? "Show less" : "Show full description"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
