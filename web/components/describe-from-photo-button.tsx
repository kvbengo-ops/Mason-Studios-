"use client";

// "Describe from photo" — the Product screen's direct fix for the
// green-pouch incident: a bright lime-green pouch was uploaded as the
// product reference photo while product_appearance's TEXT said a matte
// kraft-paper pouch with a forest-green label. The compiler never sees the
// photo, only the text, so every scene rendered the wrong product. The
// right answer was already sitting in the app, in the uploaded photo — this
// control reads it with actions/character.ts's describeProductFromPhoto
// instead of leaving a human to transcribe (and mis-transcribe) it by eye.
//
// Same preview-then-accept contract as ImproveDescriptionButton (this
// directory) — this never writes product_appearance itself, only returns a
// suggestion the operator explicitly accepts into the still-unsaved field,
// then saves via the page's own Save button.

import { useState } from "react";
import type { JSX } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import { describeProductFromPhoto } from "@/actions/character";
import { useRailBusyWhile } from "@/components/project-rail";
import { useAsyncAction } from "@/components/use-async-action";
import { RAIL_ENTRY_PRODUCT } from "@/lib/project-rail";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

export function DescribeFromPhotoButton({
  projectId,
  costUsd,
  disabled,
  hasPhoto,
  currentValue,
  onAccept,
}: {
  projectId: string;
  costUsd: number;
  /** Locked project OR non-owner viewer OR a pending save elsewhere — see ImproveDescriptionButton's identical prop for why this is the caller's job, not admin-gated. */
  disabled: boolean;
  /** Whether a product reference photo exists at all — with none, this offers a click that can only fail server-side, so the caller hides/disables it up front instead. */
  hasPhoto: boolean;
  /**
   * The CURRENT textarea value, read live from the field this sits under.
   *
   * The test here is not ImproveDescriptionButton's "did it change while you
   * were reading" — this suggestion is written from the PHOTO and never from
   * the text, so it has no older version of the text to be stale against.
   * Any words already in the field are at risk equally, whether they were
   * typed before the click or during it, because Accept replaces the whole
   * field either way. Someone who has written a careful appearance paragraph
   * and then clicks this out of curiosity should be told what Accept does
   * before they press it.
   */
  currentValue: string;
  onAccept: (suggestion: string) => void;
}): JSX.Element {
  // useAsyncAction, not useTransition: a pending transition holds the rail's
  // navigation until it settles, and this is a vision call against the
  // product photo — seconds, not milliseconds. See use-async-action.ts.
  const { pending: isPending, run: runAction } = useAsyncAction();
  // Same reason as the Improve control: the Product row spins while this
  // reads the photo, including after the operator has walked away.
  useRailBusyWhile(RAIL_ENTRY_PRODUCT, isPending);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function run(): void {
    setErrorMessage(null);
    runAction(async () => {
      try {
        const result = await describeProductFromPhoto(projectId);
        if ("error" in result) {
          setErrorMessage(result.error);
          return;
        }
        setSuggestion(result.suggestion);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to describe product photo.");
      }
    });
  }

  if (suggestion !== null) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
        <p className="text-xs font-medium text-foreground">Suggested from your photo</p>
        <p className="whitespace-pre-wrap text-sm text-foreground">{suggestion}</p>
        {currentValue.trim().length > 0 ? (
          <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-foreground">
            Accept replaces everything currently in the field, including what you already wrote.
            Discard keeps it.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Nothing is saved yet — Accept fills the field above, then press Save.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              onAccept(suggestion);
              setSuggestion(null);
            }}
          >
            Accept
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setSuggestion(null)}>
            Discard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      {/* Label holds still while the call runs — see the same note in
          improve-description-button.tsx: the spinner says "working", and the
          price is what the operator is waiting on. */}
      {/* Filled and full size, not the outline it shipped as. On the Product
          screen this is THE action: the compiler reads only the appearance
          text, and this is the one control that writes that text from the
          photo instead of from a human's memory of a photo. Rendered as an
          outline beside a filled "Rewrite my words", the screen nominated the
          weaker action — Improve can only polish a description that may
          already be about the wrong object.
          The price sits in its own de-emphasised span rather than inside the
          label's parentheses: the label says what happens, the amount says
          what it costs, and the amount is the part that must not read as
          part of the sentence. It stays inside the button either way, so the
          accessible name still carries it. */}
      <PendingButton
        type="button"
        className="self-start"
        pending={isPending}
        disabled={disabled || !hasPhoto}
        onClick={run}
      >
        <span aria-hidden="true">✦</span>
        {/* The label follows what the call now does. It was "Describe from
            photo" while it only ever read the image and discarded whatever
            was typed; it now receives the product name and the existing
            appearance text too, and corrects them against the photo rather
            than replacing them. "Describe" would understate that and, worse,
            would still read as "this will overwrite what I wrote". */}
        {currentValue.trim().length > 0 ? "Check against photo" : "Describe from photo"}
        <span className="text-xs opacity-75">{usdFormatter.format(costUsd)}</span>
      </PendingButton>
      {!hasPhoto ? (
        <p className="text-xs text-muted-foreground">Upload a product photo first.</p>
      ) : null}
      {errorMessage ? <p className="text-xs text-destructive">{errorMessage}</p> : null}
    </div>
  );
}
