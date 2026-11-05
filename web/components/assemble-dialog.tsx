"use client";

// The project-level twin of scene-rerender-dialog.tsx's version question,
// asked before an assemble instead of before a render (0060_final_versions.sql).
//
// Why it is a dialog at all, given that assembling costs nothing: the
// question is not about money, it is about what happens to the cut that
// already exists. "Update this version" replaces the mp4 the current version
// points at — the one an operator may have already sent someone a link to —
// and that is not undoable. A one-click button cannot ask that, and picking
// a default on the operator's behalf gets it wrong half the time: a genuine
// second cut deserves its own number, and a re-run after fixing one clip
// deserves not to fill the picker with v4, v5, v6 of the same idea.
//
// No price block, unlike the render dialogs: assembling calls no vendor. The
// dialog is doing one job here, and inventing a $0.00 figure to look
// consistent with them would just be noise.

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import { cn } from "@/lib/utils";
import { reassembleProject } from "@/actions/deliver";

export function AssembleDialog({
  projectId,
  /**
   * Whether there is an active version to update. False on a project that
   * has never been assembled — there is no choice to make there, so the
   * dialog does not pretend to offer one and the trigger is the whole
   * gesture. Same reasoning as SceneRerenderDialog's `kind="first"`.
   */
  hasVersion,
  disabled = false,
  onDone,
}: {
  projectId: string;
  hasVersion: boolean;
  disabled?: boolean;
  onDone?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  /**
   * Where this build lands. "new" is the default because it is the one that
   * cannot lose anything — "update" replaces the file the current version
   * points at.
   */
  const [versionMode, setVersionMode] = useState<"new" | "update">("new");
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function run(mode: "new" | "update"): void {
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = await reassembleProject(projectId, mode);
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        setOpen(false);
        onDone?.();
      } catch (error) {
        // reassembleProject does not redirect today, but it lives in an
        // actions file that does — unstable_rethrow stays here so a future
        // redirect() isn't silently eaten by this catch, same reasoning as
        // scene-rerender-dialog.tsx.
        unstable_rethrow(error);
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to assemble the final video.",
        );
      }
    });
  }

  // Nothing to choose between: skip the dialog entirely rather than showing
  // a radio group with one option in it.
  if (!hasVersion) {
    return (
      <PendingButton
        type="button"
        pending={isPending}
        disabled={disabled}
        onClick={(): void => run("new")}
      >
        Assemble video
      </PendingButton>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" disabled={disabled}>
          Rebuild video
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rebuild the assembled video?</DialogTitle>
          <DialogDescription>
            This stitches the clips again in the order below, with fresh captions. The individual
            clips are not re-rendered and nothing is charged.
          </DialogDescription>
        </DialogHeader>

        {/* Asked here rather than decided for them — the same question, the
            same two answers and the same default as a scene re-render
            (scene-rerender-dialog.tsx). Only the second is destructive, and
            it says so. */}
        <div role="radiogroup" aria-label="Where this build lands" className="flex flex-col gap-2">
          {(
            [
              {
                value: "new" as const,
                title: "Create a new version",
                detail: "Keeps the current cut. You can switch back to it any time.",
              },
              {
                value: "update" as const,
                title: "Update this version",
                detail: "Replaces the file in this version. The current cut is deleted.",
              },
            ] satisfies readonly { value: "new" | "update"; title: string; detail: string }[]
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={versionMode === option.value}
              disabled={isPending}
              onClick={(): void => setVersionMode(option.value)}
              className={cn(
                "rounded-md border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                versionMode === option.value
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-accent",
              )}
            >
              <span className="block text-sm font-medium text-foreground">{option.title}</span>
              <span className="block text-xs text-muted-foreground">{option.detail}</span>
            </button>
          ))}
        </div>

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={(): void => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <PendingButton onClick={(): void => run(versionMode)} pending={isPending}>
            Confirm
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
