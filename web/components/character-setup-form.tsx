"use client";

// The Character page's own empty-form + field-attachment pattern — see
// components/setup-form.tsx's header for why this exists at all (real
// <form>s — upload, remove, regenerate — sit physically between and inside
// this page's Character card, so a single wrapping <form> is not an
// option) and why every Setup page now builds its OWN bundle via
// createSetupForm rather than sharing one.
//
// This file used to hold every field on the single, unsplit Character Setup
// page (title, script, shooting mode, character description, product name/
// appearance, direction, captions) behind one Save button. It now holds only
// the one field this route still owns: the character description. Title
// moved to settings/page.tsx (its own write, actions/project.ts's
// updateProject, never locks — see that field's own history for why).
// Script, Direction/Shooting-Mode, Product and Captions moved to
// script-setup-form.tsx, settings-direction-form.tsx and
// product-setup-form.tsx respectively — see actions/setup.ts's header for
// why the WRITE had to split the same way the page did.

import { useRef, useState, type ChangeEvent, type JSX, type ReactNode } from "react";
import { createSetupForm } from "@/components/setup-form";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { RailBusyWhileSubmitting } from "@/components/project-rail";
import { RAIL_ENTRY_CHARACTER } from "@/lib/project-rail";
import type { ActionResult } from "@/lib/action-result";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { isThinDescription, wordCount } from "@/lib/description-quality";
import { ImproveDescriptionButton } from "@/components/improve-description-button";
import { InfoHint } from "@/components/info-hint";
import { cn } from "@/lib/utils";

const {
  formId: CHARACTER_SETUP_FORM_ID,
  SetupForm: CharacterSetupForm,
  useSetupFormState: useCharacterSetupState,
  SaveButton,
} = createSetupForm("character-setup-form");

export { CharacterSetupForm, SaveButton };

/**
 * "Generate reference image", with the unsaved description carried into it.
 *
 * The button was `disabled={locked || !project.character_desc}` — gated on
 * the SAVED column. Type a description, and it stays dead until you press
 * Save: the field in front of you is full and the one control that acts on
 * it is greyed out, with nothing saying why.
 *
 * Same shape as script-setup-form.tsx's CompileAction, and for the same
 * reason: there is ONE control between typing and spending, and this is what
 * makes that honest rather than a lie about what the image is generated
 * from. When the form is dirty it saves the description first, then
 * generates — so the picture always comes from the words on screen.
 *
 * Lives in this file, not on the page, because it needs `dirty` from the
 * setup form's context and the page is a Server Component.
 */
export function GenerateReferenceAction({
  action,
  saveAction,
  label,
  dirtyLabel,
  pendingLabel,
  fallbackErrorMessage,
  locked,
  hasSavedDescription,
}: {
  action: (formData: FormData) => Promise<ActionResult | void>;
  /** saveCharacter bound to this project — run first when the form is dirty. */
  saveAction: (formData: FormData) => Promise<ActionResult | void>;
  label: string;
  dirtyLabel: string;
  pendingLabel: string;
  fallbackErrorMessage: string;
  locked: boolean;
  /** Whether the SAVED column has a description. Unsaved typing is covered by `dirty`. */
  hasSavedDescription: boolean;
}): JSX.Element {
  const { pending, dirty } = useCharacterSetupState();
  // Saved text, or unsaved typing. An operator who has cleared the field is
  // `dirty` with nothing in it — saveCharacter rejects that with a message,
  // which is a better answer than a button that looks broken.
  const hasDescription = hasSavedDescription || dirty;

  async function saveThenGenerate(formData: FormData): Promise<ActionResult | void> {
    if (dirty) {
      const form = document.getElementById(CHARACTER_SETUP_FORM_ID);
      if (form instanceof HTMLFormElement) {
        const saveResult = await saveAction(new FormData(form));
        // Stop on a save failure rather than generating from the OLD
        // description: the operator asked for a picture of what they typed,
        // and spending on the previous text is the expensive kind of
        // surprise. Same rule CompileAction states for the script.
        if (saveResult?.error) return saveResult;
      }
    }
    return action(formData);
  }

  return (
    <ActionForm action={saveThenGenerate} fallbackErrorMessage={fallbackErrorMessage}>
      {/* Generating is paid and takes several seconds, and the operator is
          free to walk to another Setup screen while it runs. */}
      <RailBusyWhileSubmitting entryId={RAIL_ENTRY_CHARACTER} />
      <SubmitButton
        className="self-start"
        pendingLabel={pendingLabel}
        // NOT gated on the saved column any more — only on an empty field,
        // a locked project, and a save already in flight.
        disabled={locked || !hasDescription || pending}
      >
        {dirty ? dirtyLabel : label}
      </SubmitButton>
    </ActionForm>
  );
}

/**
 * Describes the character — plus the word-count/thin-description warning
 * (spec incident: "an athletic woman" was the whole description, so the
 * compiler invented hair/clothing/lighting fresh per scene, and the same
 * person looked different in every clip) and the "Rewrite my words" preview
 * control.
 *
 * The portrait's staleness flag deliberately does NOT live here any more.
 * It used to render as a banner inside this block, below the portrait,
 * saying "the portrait below was generated…" — pointing the wrong way once
 * the two sit side by side, and sitting in a different block from the
 * regenerate button that acts on it. It is now drawn on the portrait card
 * itself (character/page.tsx), with the regen control in the same card.
 */
export function CharacterDescriptionField({
  initialValue,
  locked,
  projectId,
  improveCostUsd,
  libraryTrigger,
}: {
  initialValue: string;
  locked: boolean;
  /** projects.id — improveDescription is scoped to one project's spend caps/runs. */
  projectId: string;
  /** applySceneCostUsd(compilerModel) for this project — same rate applyScenePrompt (Apply) quotes for an equivalent single small Claude call. */
  improveCostUsd: number;
  /**
   * The Character Library entry point, rendered in the same button row as
   * Rewrite my words. Server-rendered and passed down (it is a <Link>, and
   * the count/in-use name on it are server data) rather than built here.
   */
  libraryTrigger?: ReactNode;
}): JSX.Element {
  const { pending, markDirty } = useCharacterSetupState();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Whether ImproveDescriptionButton currently has a suggestion on screen
  // that has not been accepted. The design says this at the panel header;
  // the header is a Server Component, so the nearest place that can react
  // to a client state change is this field's own label — which is also the
  // thing the unapplied suggestion is about.
  const [suggestionOutstanding, setSuggestionOutstanding] = useState(false);

  // Tracks the CURRENT (possibly unsaved) text for the live word count and
  // as ImproveDescriptionButton's input — same "uncontrolled field, mirrored
  // by a plain state value read from, never fed back into, the textarea's
  // own `value`" split this page's script field used before the split, for
  // the identical reason (React 19's post-submit uncontrolled-field reset).
  const [value, setValue] = useState(initialValue);

  // Re-synced when the SERVER sends a different description.
  //
  // The textarea below already handles this with `key={initialValue}`,
  // which remounts it so defaultValue re-applies — see its comment for the
  // stale-DOM-overwrite that fix exists to stop. But this state is a second
  // copy of the same fact, and it feeds the word count and the thin-
  // description warning. Without this, picking a library character showed
  // the new description in the field while the counter underneath still
  // judged the old one: "53 words · enough detail" sitting under text that
  // has neither.
  const [syncedTo, setSyncedTo] = useState(initialValue);
  if (initialValue !== syncedTo) {
    setSyncedTo(initialValue);
    setValue(initialValue);
  }

  const words = wordCount(value);
  const thin = isThinDescription(value);

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>): void {
    markDirty();
    setValue(e.target.value);
  }

  function handleAccept(suggestion: string): void {
    // Imperative DOM write: the textarea stays uncontrolled, so this is the
    // one way to change its displayed text from outside a keystroke. Accept
    // only ever fills the FIELD — it does not save; the operator still
    // presses this page's own Save button afterward, same as if they had
    // typed the suggestion by hand.
    if (textareaRef.current) {
      textareaRef.current.value = suggestion;
    }
    setValue(suggestion);
    markDirty();
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Same treatment as the Product field, and for the same reason: the
          compiler reads this text and nothing else, including when a
          portrait exists beside it. Stating that on the label puts it in
          front of the operator every time, instead of only once something
          has already gone wrong. */}
      <Label htmlFor="description" className="flex flex-wrap items-center gap-x-2">
        <span>1. Describe your character</span>
        <InfoHint>
          Required. A reference photo (picked from your library or uploaded) is optional on its own,
          but if you use one it needs a description too — an undescribed photo leaves the compiler
          to invent its own mismatched description of the person in it. Below 12 words the compiler
          invents whatever is missing — clothing, hair, distinguishing features, lighting — fresh
          for every scene, so the same character looks different each time. Write the clothing,
          hair, earrings, and light.
        </InfoHint>
        {suggestionOutstanding ? (
          <span className="text-xs font-normal text-warning">not applied yet</span>
        ) : null}
      </Label>
      <Textarea
        id="description"
        // Keyed on the value it was initialized from, not left keyless:
        // this is an uncontrolled field (defaultValue, not value), so
        // without a key change React treats a re-render with a new
        // `initialValue` as the SAME DOM node and leaves its current text
        // alone — the textarea keeps showing whatever the operator last
        // typed (or nothing) instead of the description useCharacter
        // (actions/character-library.ts) just copied in. Worse than
        // stale-looking: the next Save would submit that stale DOM value
        // and silently overwrite the just-copied description right back
        // out. Changing `key` forces React to unmount/remount the node,
        // which re-applies `defaultValue` fresh.
        key={initialValue}
        ref={textareaRef}
        name="description"
        form={CHARACTER_SETUP_FORM_ID}
        rows={4}
        defaultValue={initialValue}
        disabled={locked || pending}
        readOnly={locked}
        onChange={handleChange}
        placeholder="e.g. A woman in her late 20s, shoulder-length dark hair, cream linen shirt, sunlit kitchen."
      />
      {/* Count on the left, verdict on the right — the design's own split.
          Running them into one sentence buried the only part that is a
          judgement ("enough detail" / "too thin") inside a number nobody
          reads twice. Separated, the verdict is what the eye lands on, and
          it is the thing that decides whether the compiler invents a
          different person every scene. */}
      {/* Nothing at all until there is something to judge. An empty field is
          NOT "too thin" — it is unstarted, and the card above already says
          the description is required. Shouting a warning at a field the
          operator has not touched teaches them the warning is decoration,
          which is precisely what it must not be by the time it means
          something. (Made worse by splitting the count from the verdict:
          "0 words" ran quietly, "⚠ too thin" does not.) */}
      {value.trim().length > 0 ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">
            {words} word{words === 1 ? "" : "s"}
          </span>
          <span className={cn("font-medium", thin ? "text-warning" : "text-success")}>
            {thin ? "⚠ too thin" : "✓ enough detail"}
          </span>
        </div>
      ) : null}
      {locked ? null : (
        <ImproveDescriptionButton
          projectId={projectId}
          subject="character"
          // Secondary: the one gold button on this screen is "Generate
          // reference image", which is what actually moves the step forward.
          // Improve only polishes words that are already there.
          emphasis="secondary"
          description={value}
          costUsd={improveCostUsd}
          disabled={locked || pending}
          onAccept={handleAccept}
          secondaryAction={libraryTrigger}
          onPreviewChange={setSuggestionOutstanding}
        />
      )}
      {/* Locked (delivered project, or a viewer who is not the owner): the
          Improve control is gone, and with it the row the library trigger
          normally sits in. The library is still worth reaching — opening it
          is a read; its Use buttons are disabled by the same lock. */}
      {locked && libraryTrigger ? (
        <div className="flex flex-wrap items-center gap-2">{libraryTrigger}</div>
      ) : null}
    </div>
  );
}
