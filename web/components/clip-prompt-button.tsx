"use client";

import type { JSX } from "react";
import { FileText } from "lucide-react";
import { ClipPromptSection } from "@/components/create-clip-wall";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { ElementTag } from "@/lib/elements";

/**
 * Opens the shown take's prompt on /ugc/[id], in the same card /create's clip
 * viewer uses. Read-only, so a non-owning admin gets it too.
 */
export function ClipPromptButton({
  prompt,
  referenceTags,
  elements,
}: {
  prompt: string;
  referenceTags: readonly string[];
  elements: readonly ElementTag[];
}): JSX.Element {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-background px-2 text-[11px] font-semibold normal-case tracking-normal text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FileText aria-hidden="true" className="size-3" />
          Prompt
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogTitle className="sr-only">Prompt</DialogTitle>
        <ClipPromptSection prompt={prompt} referenceTags={referenceTags} elements={elements} />
      </DialogContent>
    </Dialog>
  );
}
