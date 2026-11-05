"use client";

// "Rewrite my words" — the Character/Product screens' fix for description
// text too thin to hold a subject consistent across scenes (see
// lib/description-quality.ts's header for the incident: "an athletic
// woman" was the whole character description, so the compiler invented
// hair/clothing/lighting fresh per scene).
//
// PREVIEW, THEN ACCEPT OR DISCARD — never a silent write. This repo already
// shipped the opposite shape once: Apply used to silently overwrite an
// operator's hand-edited scene prompt with a fresh generation, no warning,
// the edit just gone (see actions/brief.ts's applyScenePrompt doc comment).
// This control calls actions/character.ts's improveDescription, which only
// ever RETURNS a suggestion — nothing is written to the database until
// Accept is clicked, and Accept only ever changes what's sitting in the
// (still-unsaved) textarea above, via `onAccept`. The operator still has to
// press the page's own Save button afterward, same as typing the text by
// hand would require — this control does not bypass that.
//
// The preview shows a WORD-LEVEL DIFF, not the suggestion on its own: see
// diffWords below for why "0 removed" has to be a checkable claim rather
// than a promise. Retry re-rolls in place, at the same price, so seeing a
// second suggestion does not require throwing the first one away first.

import { useState } from "react";
import type { JSX, ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import { improveDescription } from "@/actions/character";
import { useRailBusyWhile } from "@/components/project-rail";
import { useAsyncAction } from "@/components/use-async-action";
import { RAIL_ENTRY_CHARACTER, RAIL_ENTRY_PRODUCT } from "@/lib/project-rail";
import { wordCount } from "@/lib/description-quality";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

export interface DiffSegment {
  /** The words of this run, joined by single spaces. Never empty. */
  text: string;
  kind: "same" | "added" | "removed";
}

/**
 * How many words the DP table below is willing to compare on each side.
 * The table is O(before × after) cells; at 600 × 600 that is 360k numbers,
 * which is still nothing, and a description that long is far outside what
 * this screen is for. Past the cap the diff is skipped rather than run
 * slowly on the main thread — the caller falls back to showing the plain
 * suggestion, which is what it showed before this existed.
 */
export const DIFF_WORD_CAP = 600;

/**
 * Word-level diff between the description a suggestion was generated FROM
 * and the suggestion itself.
 *
 * The reason this is here at all, rather than the suggestion being printed
 * as a plain paragraph: Accept replaces the operator's whole description in
 * one click, and the one thing they need to know before pressing it is
 * whether the model QUIETLY DROPPED something they wrote. Two paragraphs of
 * near-identical prose side by side do not answer that — a human reads the
 * first line of each, sees they match, and accepts. Marking the additions
 * and the removals, and counting them, does answer it: "0 removed" is a
 * claim you can check at a glance, and a non-zero one puts the struck-out
 * words on screen instead of leaving them to be noticed after the compile.
 *
 * Plain LCS over whitespace-delimited words. Not a character diff (which
 * shreds prose into unreadable fragments mid-word) and not a sentence diff
 * (which flags a whole sentence as changed for one inserted clause — the
 * exact case this screen produces most).
 */
export function diffWords(before: string, after: string): DiffSegment[] {
  const a = before.trim().length === 0 ? [] : before.trim().split(/\s+/);
  const b = after.trim().length === 0 ? [] : after.trim().split(/\s+/);

  const push = (segments: DiffSegment[], kind: DiffSegment["kind"], words: string[]): void => {
    if (words.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) {
      last.text = `${last.text} ${words.join(" ")}`;
      return;
    }
    segments.push({ kind, text: words.join(" ") });
  };

  if (a.length > DIFF_WORD_CAP || b.length > DIFF_WORD_CAP) {
    // Past the cap the suggestion is shown plainly, unmarked — the same
    // thing this preview showed before the diff existed. Marking nothing is
    // honest here; claiming "0 removed" without having compared would not be.
    const segments: DiffSegment[] = [];
    push(segments, "same", b);
    return segments;
  }

  if (a.length === 0 || b.length === 0) {
    const segments: DiffSegment[] = [];
    push(segments, "removed", a);
    push(segments, "added", b);
    return segments;
  }

  // lcs(i, j) = length of the longest common subsequence of a[i:] and b[j:].
  const width = b.length + 1;
  const table = new Int32Array((a.length + 1) * width);
  const lcs = (x: number, y: number): number => table[x * width + y] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
    }
  }

  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(segments, "same", [a[i] ?? ""]);
      i++;
      j++;
    } else if (lcs(i + 1, j) >= lcs(i, j + 1)) {
      push(segments, "removed", [a[i] ?? ""]);
      i++;
    } else {
      push(segments, "added", [b[j] ?? ""]);
      j++;
    }
  }
  push(segments, "removed", a.slice(i));
  push(segments, "added", b.slice(j));
  return segments;
}

function countWords(segments: DiffSegment[], kind: DiffSegment["kind"]): number {
  return segments
    .filter((segment) => segment.kind === kind)
    .reduce((total, segment) => total + segment.text.split(" ").length, 0);
}

export function ImproveDescriptionButton({
  projectId,
  subject,
  description,
  costUsd,
  disabled,
  emphasis = "primary",
  onAccept,
  secondaryAction,
  onPreviewChange,
}: {
  projectId: string;
  subject: "character" | "product";
  /** The CURRENT textarea value, read live from the field this renders next to — not necessarily what's saved. */
  description: string;
  costUsd: number;
  /**
   * True whenever this control must not be offered a live click: locked
   * project, non-owner viewer, or a pending save elsewhere on the page.
   * Spending controls on this page are owner-only per its established
   * pattern (see e.g. RegenerateCharacterButton's admin-only gating one
   * layer up) — this one is gated by the caller passing `fieldsLocked`
   * (project-lock OR non-owner), not admin, since improving TEXT carries
   * none of the character-library brand-control restriction a photo
   * upload/generate does.
   */
  disabled: boolean;
  /**
   * How much weight this control carries relative to what sits beside it.
   *
   * On the Character screen it is the only AI control and takes the primary
   * treatment. On Product it sits next to "Describe from photo", which the
   * design calls the most important button on that screen — two filled
   * buttons side by side is no hierarchy at all, so this one steps back
   * there. The caller decides, because only the caller can see what else is
   * in the row.
   */
  emphasis?: "primary" | "secondary";
  /** Called with the accepted suggestion — writes it into the field's own (uncontrolled) textarea and marks the form dirty. Never called on Discard. */
  onAccept: (suggestion: string) => void;
  /**
   * Rendered in this control's own button row, to the right of Improve —
   * the design puts the Character Library pick beside Improve rather than a
   * click deeper, and this is the row it means. Dropped while a suggestion
   * is on screen: at that moment the row is Accept / Discard / Retry, and
   * an alternative route out of the screen sitting among them is a way to
   * lose the suggestion by misclick.
   */
  secondaryAction?: ReactNode;
  /**
   * Fires true when a suggestion goes on screen and false when it is
   * accepted or discarded, so the field around this control can say it has
   * an unapplied suggestion outstanding. Optional — the Product screen
   * passes no such thing and behaves exactly as before.
   */
  onPreviewChange?: (open: boolean) => void;
}): JSX.Element {
  // useAsyncAction, not useTransition: a pending transition holds the rail's
  // navigation until it settles, and this is a Claude call. The comment
  // below promises the operator can navigate away mid-call — which a
  // transition quietly made false. See components/use-async-action.ts.
  const { pending: isPending, run: runAction } = useAsyncAction();
  // The rail is the one thing on screen from every route, so a call started
  // here has to be visible after you navigate away from the screen that
  // started it. Without this the hook and the provider were plumbing nothing
  // called — the ring the design asks for existed and never turned.
  useRailBusyWhile(subject === "product" ? RAIL_ENTRY_PRODUCT : RAIL_ENTRY_CHARACTER, isPending);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  // What the textarea held at the moment this suggestion was requested. The
  // preview stays open while the field above remains fully editable, so an
  // operator can keep typing and then press Accept — which overwrites the
  // field wholesale with text generated from the OLDER version, silently
  // dropping everything they wrote in between. That is the same shape as the
  // Apply bug this control's own header cites, arriving through the one door
  // preview-then-accept leaves open. Accept is not blocked (their edit may
  // well be a typo fix they are happy to lose); it just stops being a
  // surprise.
  const [generatedFrom, setGeneratedFrom] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const editedSinceGenerated = generatedFrom !== null && description !== generatedFrom;

  function run(): void {
    setErrorMessage(null);
    const requestedWith = description;
    runAction(async () => {
      try {
        const result = await improveDescription(projectId, subject, description);
        if ("error" in result) {
          setErrorMessage(result.error);
          return;
        }
        setGeneratedFrom(requestedWith);
        setSuggestion(result.suggestion);
        onPreviewChange?.(true);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to improve description.");
      }
    });
  }

  function closePreview(): void {
    setSuggestion(null);
    setGeneratedFrom(null);
    onPreviewChange?.(false);
  }

  if (suggestion !== null) {
    const before = generatedFrom ?? "";
    const segments = diffWords(before, suggestion);
    const beforeWords = wordCount(before);
    const afterWords = wordCount(suggestion);
    // The diff bails out past DIFF_WORD_CAP and returns the suggestion
    // unmarked. Printing "0 added, 0 removed" off that would be a claim
    // nothing checked — so the counts are shown only when a real comparison
    // happened.
    const compared = beforeWords <= DIFF_WORD_CAP && afterWords <= DIFF_WORD_CAP;
    const addedWords = countWords(segments, "added");
    const removedWords = countWords(segments, "removed");

    return (
      <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
        <p className="text-xs font-medium text-foreground">Suggested by AI</p>
        {/* The additions marked and the removals struck through, in place,
            rather than a second paragraph to read against the first. See
            diffWords' own comment: the question Accept has to answer is
            "did it drop anything I wrote", and prose-beside-prose does not
            answer it. */}
        <p className="text-sm text-foreground">
          {segments.map((segment, index) => (
            <span key={index}>
              {index > 0 ? " " : null}
              {segment.kind === "added" ? (
                <mark className="rounded bg-success/15 px-0.5 text-success">{segment.text}</mark>
              ) : segment.kind === "removed" ? (
                <del className="text-destructive">{segment.text}</del>
              ) : (
                segment.text
              )}
            </span>
          ))}
        </p>
        {compared ? (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">
              {beforeWords} → {afterWords} words
            </span>
            <span
              className={removedWords > 0 ? "font-medium text-warning" : "text-muted-foreground"}
            >
              {addedWords} added, {removedWords} removed
            </span>
          </div>
        ) : null}
        {editedSinceGenerated ? (
          <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-foreground">
            You&apos;ve edited the description since this was generated. Accept replaces the whole
            field, so those edits will be lost — Discard keeps what you typed.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Nothing is saved yet — Accept fills the field above, then press Save.
        </p>
        {errorMessage ? <p className="text-xs text-destructive">{errorMessage}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={isPending}
            onClick={() => {
              onAccept(suggestion);
              closePreview();
            }}
          >
            Accept
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={closePreview}
          >
            Discard
          </Button>
          {/* Re-roll without losing the preview. Without this the only way
              to see a second suggestion is Discard then Improve again —
              which throws the first one away before you can compare, and
              costs the same money either way. */}
          <PendingButton
            type="button"
            size="sm"
            variant="outline"
            pending={isPending}
            disabled={disabled || description.trim().length === 0}
            onClick={run}
          >
            Retry ({usdFormatter.format(costUsd)})
          </PendingButton>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      {/* The label does NOT change to "Improving…" while this runs. The
          spinner already says that, and the price is the one thing an
          operator must still be able to read at the moment they are waiting
          to find out what they just agreed to spend. */}
      {/* Primary, not outline: in the design this is the one action on the
          screen, and the Library pick beside it is the alternative. Both
          rendered as outline read as equally weighted, which is not what the
          screen is for — a thin description is the failure this page exists
          to prevent. */}
      {/* One row, both routes: write it better, or take one you already
          have. The design puts them side by side because they are the two
          answers to the same question, and burying the second one behind a
          disclosure makes the library look like a rescue rather than the
          normal way to fill this field. */}
      <div className="flex flex-wrap items-center gap-2">
        <PendingButton
          type="button"
          size="sm"
          variant={emphasis === "secondary" ? "outline" : "default"}
          pending={isPending}
          disabled={disabled || description.trim().length === 0}
          onClick={run}
        >
          {/* Names its INPUT, not its ambition. Beside "Describe from
              photo" — which reads the image — a button called "Improve with
              AI" says nothing about where its words come from, and the pair
              read as two spellings of one action at the same price on the
              same field. Asked in exactly those terms: "diba dapat isa
              lang?" They are not one thing: one looks at the picture, this
              one rewrites what you typed. Saying so is cheaper than
              merging two genuinely different calls. */}
          Rewrite my words ({usdFormatter.format(costUsd)})
        </PendingButton>
        {secondaryAction}
      </div>
      {errorMessage ? <p className="text-xs text-destructive">{errorMessage}</p> : null}
    </div>
  );
}
