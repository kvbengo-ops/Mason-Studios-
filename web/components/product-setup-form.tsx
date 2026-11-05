"use client";

// The Product page's own empty-form + field-attachment pattern — see
// components/setup-form.tsx's header for why, and character-setup-form.tsx's
// header for where this file's fields used to live before the single
// Character Setup page split into Character/Product/Script routes.

import { useRef, useState, type ChangeEvent, type JSX } from "react";
import { createSetupForm } from "@/components/setup-form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { isThinDescription, wordCount } from "@/lib/description-quality";
import { InfoHint } from "@/components/info-hint";
import { DescribeFromPhotoButton } from "@/components/describe-from-photo-button";

const {
  formId: PRODUCT_SETUP_FORM_ID,
  SetupForm: ProductSetupForm,
  useSetupFormState: useProductSetupState,
  SaveButton,
} = createSetupForm("product-setup-form");

export { ProductSetupForm, SaveButton };

export function ProductNameField({
  initialValue,
  locked,
}: {
  initialValue: string;
  locked: boolean;
}): JSX.Element {
  const { pending, markDirty } = useProductSetupState();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="product_name">1. Product name</Label>
      <Input
        id="product_name"
        name="product_name"
        form={PRODUCT_SETUP_FORM_ID}
        defaultValue={initialValue}
        disabled={locked || pending}
        readOnly={locked}
        onChange={markDirty}
        placeholder="NeuroBlast SMN16-18"
      />
    </div>
  );
}

/**
 * Describes what the product looks like — plus the standing photo-vs-text
 * warning, "Describe from photo" (the direct fix for the green-pouch
 * incident: a
 * bright lime-green pouch was uploaded while this text said matte
 * kraft-paper — the compiler only ever reads this text, never the photo),
 * and a staleness banner for the character-with-product composite once
 * this text (or the character description) has changed since it was made.
 */
export function ProductAppearanceField({
  initialValue,
  locked,
  projectId,
  describeCostUsd,
  hasProductPhoto,
}: {
  initialValue: string;
  locked: boolean;
  projectId: string;
  /** applySceneCostUsd(compilerModel) — same rate CharacterDescriptionField's Improve control quotes. */
  /** The one paid call this field offers — describeProductFromPhoto, which now reads the photo AND the text the operator has written. There is no second AI button here any more, so there is no second price. */
  describeCostUsd: number;
  /** Whether a product reference photo exists at all — gates DescribeFromPhotoButton's live click. */
  hasProductPhoto: boolean;
}): JSX.Element {
  const { pending, markDirty } = useProductSetupState();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initialValue);
  const words = wordCount(value);
  const thin = isThinDescription(value);

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>): void {
    markDirty();
    setValue(e.target.value);
  }

  function handleAccept(suggestion: string): void {
    if (textareaRef.current) {
      textareaRef.current.value = suggestion;
    }
    setValue(suggestion);
    markDirty();
  }

  return (
    <div className="flex flex-col gap-2">
      {/* The label carries the rule, as the design does. "(optional)" was
          the only qualifier on it, which is true and useless — what matters
          about this field is not that you may skip it but that it is the
          ONLY thing the compiler reads. Saying so here means it is stated
          every time the field is looked at, and the loud box below stays
          reserved for the case where the photo and the text can actually
          disagree. */}
      <Label htmlFor="product_appearance" className="flex flex-wrap items-center gap-x-2">
        <span>3. Product appearance</span>
        <InfoHint>
          This is all the compiler sees. Write the form and material, the colour, and the label
          treatment — anything left out is invented fresh for every scene.
        </InfoHint>
      </Label>
      <Textarea
        id="product_appearance"
        ref={textareaRef}
        key={initialValue}
        name="product_appearance"
        form={PRODUCT_SETUP_FORM_ID}
        rows={3}
        defaultValue={initialValue}
        disabled={locked || pending}
        readOnly={locked}
        onChange={handleChange}
        placeholder="e.g. Bright lime-green foil pouch, matte finish, dark green wordmark centred, resealable zip top."
      />
      {/* Controls sit directly under the field they rewrite, and "Describe
          from photo" comes first and loudest: it is the one action that can
          END the disagreement this screen is about, by reading the photo the
          compiler will never read. Improve only polishes words that may
          already describe the wrong object. */}
      {locked ? null : (
        <div className="flex flex-wrap items-start gap-2">
          <DescribeFromPhotoButton
            projectId={projectId}
            costUsd={describeCostUsd}
            disabled={locked || pending}
            hasPhoto={hasProductPhoto}
            currentValue={value}
            onAccept={handleAccept}
          />
          {/* No second AI button. "Rewrite my words" used to sit here,
              and the pair was the confusion: same price, same field, and
              the operator had to decide which INPUT won — the photo or
              their own text. Describe from photo now receives both and
              reconciles them (lib/claude.ts's describePhotoAppearance),
              which is the job this screen exists for. Asked as: "what if 1
              button lang, tapos naka base sa image + product name +
              appearance text?" */}
        </div>
      )}
      {/* Permanent for as long as a photo exists — not only while the text
          is thin.
          It used to appear only when the description was thin or empty, on
          the theory that a full description meant the operator had already
          done the work. That is exactly backwards: the green-pouch incident
          WAS a full description — "matte kraft-paper pouch with a
          forest-green label", well past any word threshold — written about
          a bright lime-green pouch sitting right there in the upload. The
          old condition went quiet at the precise moment the two inputs had
          diverged the most, since length is not agreement. So while there is
          a photo to disagree with, this stays up.
          Still gated on the photo: with nothing uploaded there is no second
          input to contradict, and "the compiler never sees your photo" would
          be a warning about a photo that does not exist. The rule for that
          case is on the label above, where it is read every time. */}
      {hasProductPhoto ? (
        <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          <span aria-hidden="true">⚠</span>
          <p>
            <strong className="font-semibold">
              Claude writes the scene prompts from this text, never from the photo.
            </strong>{" "}
            Your photo is not wasted — it is what the combined character-with-product shot is built
            from. But the words are what every prompt says, so if the two disagree the prompt
            describes one product while the picture shows another, and nothing warns you again.
            {thin
              ? ` Right now this is ${words} word${words === 1 ? "" : "s"} — too thin to hold a product still. Add form and material, colour, and label treatment, or the compiler will invent packaging.`
              : ""}
          </p>
        </div>
      ) : null}
      {/* No photo, so nothing can disagree — but text this thin still leaves
          the compiler inventing the packaging, so say that much. Only while
          it is actually thin: a running word count on a description that is
          already good is a number with no decision attached to it. */}
      {!hasProductPhoto && thin && value.trim().length > 0 ? (
        <p className="text-xs font-medium text-warning">
          {`${words} word${words === 1 ? "" : "s"} — too thin. Add form and material, colour, and label treatment, or the compiler will invent packaging.`}
        </p>
      ) : null}
    </div>
  );
}
