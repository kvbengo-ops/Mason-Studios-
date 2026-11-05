"use client";

// Renders what lib/ugc-prompt-preview.ts computes — the actual string kie's
// `prompt` field will hold — so the /ugc composer's own README problem (an
// operator writes a prompt and cannot see what is actually submitted) has an
// answer. See that file's header for the two invisible transforms this is
// closing the loop on and why one of them (bindUITags' tag rewrite/deletion)
// is deliberately NOT reproduced here.
//
// Collapsed by default: the prompt box already has flex-1 and the settings
// row plus the Generate button are fixed-height controls that must stay
// reachable without scrolling (ugc-column.tsx's own comment on its ActionForm
// className). A second block of text sitting open under every keystroke would
// fight the box it is describing for the same space.

import { useState, type JSX } from "react";
import { ChevronDownIcon } from "lucide-react";
import { buildUgcPromptPreview } from "@/lib/ugc-prompt-preview";
import { cn } from "@/lib/utils";

export function UgcPromptPreview({
  prompt,
  elements,
  scriptLine,
  isTalkingHead,
  audioEnabled,
  durationS,
}: {
  prompt: string;
  elements: readonly { name: string; description?: string | null; aiDescription?: string | null }[];
  scriptLine: string | null;
  isTalkingHead: boolean;
  audioEnabled: boolean;
  durationS: number;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);

  // Nothing to preview yet. Matches the "Write a prompt to generate" line
  // below the button — an empty box is unstarted, not a preview of blank.
  if (!prompt.trim()) return null;

  const preview = buildUgcPromptPreview({
    prompt,
    // buildUgcPromptPreview reads `description`/`ai_description` per
    // descriptionFor's contract; ElementTag carries the same fact as
    // `aiDescription`, so it is remapped at the call boundary rather than
    // renaming the field either function uses internally.
    elements: elements.map((e) => ({
      name: e.name,
      description: e.description,
      ai_description: e.aiDescription,
    })),
    scriptLine,
    isTalkingHead,
    audioEnabled,
    durationS,
  });

  const hasWarning = !preview.tagBindingExact || (preview.dialogueAppended && preview.overBudget);

  return (
    <section className="flex flex-col rounded-lg border bg-card text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-left transition-colors",
          "hover:bg-accent/40",
          // A quiet amber dot rather than moving text around: the summary
          // row should read the same length open or closed, and "there is
          // something here worth reading before you press Generate" is a
          // signal, not a sentence, when the row is one line tall.
          hasWarning ? "text-warning" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <span className="flex items-center gap-1.5 font-medium">
          {hasWarning ? <span aria-hidden="true">⚠</span> : null}
          What actually gets sent
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 transition-transform", open ? "rotate-180" : "")}
        />
      </button>
      {open ? (
        <div className="flex flex-col gap-2 border-t px-3 py-2">
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-snug text-foreground">
            {preview.submitted}
          </pre>

          {/* THE HONESTY LABEL. bindUITags still runs server-side and this
              preview does not reproduce it (see ugc-prompt-preview.ts's
              header) — a live "@" tag past substitution means the worker
              WILL rewrite this text further, and saying nothing here would
              let the preview quietly lie, which is worse than not having
              one. */}
          {!preview.tagBindingExact ? (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">
              This still has an unresolved <code className="font-mono">@tag</code>. The worker
              rewrites a bound reference to <code className="font-mono">@image1</code>/
              <code className="font-mono">@image2</code> and deletes an audio tag outright before
              this reaches kie — the text above is what gets sent BEFORE that rewrite, not the
              final string.
            </p>
          ) : null}

          {/* Warn, never block — the operator may know something the word
              count does not (a fast-talking VO, a deliberate pause built
              into the shot), and a control that silently refuses is the bug
              class this project has already shipped more than once. */}
          {preview.dialogueAppended && preview.overBudget ? (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">
              {preview.scriptLineWordCount} spoken word
              {preview.scriptLineWordCount === 1 ? "" : "s"} for a {durationS}s clip — natural
              speech fits about {preview.wordBudget}. The model may rush, slur, or invent words to
              catch up.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
