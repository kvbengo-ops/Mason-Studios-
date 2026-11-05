"use client";

// The "Add a character" form (library/page.tsx). Problem 2: the old markup
// asked for Name + Description twice — once above an upload dropzone, once
// above a Generate button, separated only by an "OR" divider, with
// identical labels and identical placeholder text on both. Nothing on
// screen said which pair was live; it read as a duplicate-rendering bug.
//
// The actual choice an operator is making isn't "which pair of Name/
// Description fields" — it's "where does the reference photo come from":
// upload one, or spend $0.02 generating one from the description. So this
// component asks for Name and Description exactly once, then a two-way
// choice for the photo source, each option showing only the control that
// differs.
//
// `uploadAction` and `createCharacterFromUpload` and `generateAction` is
// `createCharacterFromDescription` — both real "use server" exports handed
// down from the page (a Server Component), the one kind of function safe
// to cross that boundary (see action-form.tsx's header). `handleSubmit`
// below is a plain closure, but it's defined and consumed entirely within
// this already-client component, so it never itself crosses server-to-
// client — only ordinary same-side prop passing to ActionForm.
import { useId, useState } from "react";
import type { JSX } from "react";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { PendingFieldset } from "@/components/pending-fieldset";
import { ReferenceDropzone } from "@/components/reference-dropzone";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action-result";
import { cn } from "@/lib/utils";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

type PhotoSource = "upload" | "generate";

export function AddCharacterForm({
  uploadAction,
  generateAction,
  generateCostUsd,
}: {
  uploadAction: (formData: FormData) => Promise<ActionResult | void>;
  generateAction: (formData: FormData) => Promise<ActionResult | void>;
  generateCostUsd: number;
}): JSX.Element {
  const [source, setSource] = useState<PhotoSource>("upload");
  const nameId = useId();
  const descriptionId = useId();
  const generateCostLabel = usdFormatter.format(generateCostUsd);

  async function handleSubmit(formData: FormData): Promise<ActionResult | void> {
    return source === "upload" ? uploadAction(formData) : generateAction(formData);
  }

  return (
    <ActionForm
      action={handleSubmit}
      fallbackErrorMessage="Failed to add character."
      className="flex flex-col gap-3"
    >
      <PendingFieldset className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor={nameId} required>
            Name
          </Label>
          <Input id={nameId} name="name" required placeholder="Jamie — Spokesperson" />
        </div>
        {/* Required on both paths — see createCharacterFromUpload's doc
            comment (actions/character-library.ts) on why a photo-only
            entry is no longer valid: without it, every project that later
            Uses this card compiles against a description Claude invents
            from the script instead of the person in this photo. */}
        <div className="flex flex-col gap-2">
          <Label htmlFor={descriptionId} required>
            Description
          </Label>
          <Textarea
            id={descriptionId}
            name="description"
            required
            rows={4}
            placeholder="e.g. A woman in her late 20s, shoulder-length dark hair, cream linen shirt, sunlit kitchen."
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Reference photo</Label>
          <div
            role="radiogroup"
            aria-label="Reference photo source"
            className="inline-flex w-fit rounded-md border border-border p-0.5"
          >
            <button
              type="button"
              role="radio"
              aria-checked={source === "upload"}
              onClick={() => setSource("upload")}
              className={cn(
                "rounded-sm px-3 py-1 text-sm font-medium transition-colors",
                source === "upload"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Upload
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={source === "generate"}
              onClick={() => setSource("generate")}
              className={cn(
                "rounded-sm px-3 py-1 text-sm font-medium transition-colors",
                source === "generate"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Generate ({generateCostLabel})
            </button>
          </div>

          {source === "upload" ? (
            <ReferenceDropzone name="file" />
          ) : (
            <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-4">
              <p className="text-xs text-muted-foreground">
                Generates a reference photo from the description above — costs {generateCostLabel},
                charged when you submit below.
              </p>
              {/* The cost also lives on the SubmitButton itself, not just
                  the tab and the sentence above — this project shows the
                  price at every paid control, right up to the button that
                  triggers the charge, not just somewhere upstream of it. */}
              <SubmitButton className="self-start" pendingLabel="Generating…">
                Generate reference photo ({generateCostLabel})
              </SubmitButton>
            </div>
          )}
        </div>
      </PendingFieldset>
    </ActionForm>
  );
}
