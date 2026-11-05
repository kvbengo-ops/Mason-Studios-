"use client";

// The Deliver page's counterpart to scene-workbench.tsx's version dropdown,
// one level up: that one picks which attempt at a SCENE is shown and
// delivered, this one picks which assembled CUT is
// (0060_final_versions.sql). Same shape on purpose — an operator who has
// learned "v2 lives behind the little chevron" on one screen should not have
// to learn a second idiom on the other.
//
// The one thing this picker has to say that the scene picker does not: a
// final version is a RECIPE first and a file second. The mp4 is 10-30MB and
// may be pruned; the recipe that describes the cut is kept forever. So every
// row states which of the two it still has, and a row with only the recipe
// offers a rebuild instead of pretending it can play.

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDownIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import { reassembleProject, setActiveFinalVersion } from "@/actions/deliver";
import { dateTimeFormatter } from "@/lib/datetime";

export interface FinalVersionOption {
  id: string;
  /** Per-project 1, 2, 3 — the "v2" an operator says out loud, not a row id. */
  n: number;
  /** ISO. Null while this version is the outstanding build request. */
  builtAt: string | null;
  /** ISO. Null unless the worker gave up on this version. */
  failedAt: string | null;
  failureReason: string | null;
  /** Whether the mp4 still exists, as opposed to only the recipe for it. */
  hasFile: boolean;
}

/**
 * One line describing what a row still has. Deliberately three different
 * sentences rather than one with a blank in it: "not built yet", "the file
 * is gone" and "here is when it was built" are different enough that
 * collapsing them is how an operator ends up clicking a cut that cannot
 * play.
 */
function describeVersion(version: FinalVersionOption): string {
  if (version.failedAt !== null) return "failed";
  if (version.builtAt === null) return "building…";
  const built = dateTimeFormatter.format(new Date(version.builtAt));
  return version.hasFile ? built : `${built} · file pruned`;
}

export function FinalVersionPicker({
  projectId,
  versions,
  activeVersionId,
  /**
   * Owner-only, matching setActiveFinalVersion/reassembleProject's own
   * requireProject guard — a read-only admin viewer gets no control that the
   * server would refuse. The picker is still rendered for them: which cut
   * they are looking at is information, not an action.
   */
  canSwitch,
}: {
  projectId: string;
  versions: readonly FinalVersionOption[];
  activeVersionId: string | null;
  canSwitch: boolean;
}): JSX.Element | null {
  const router = useRouter();
  const [switching, startSwitchTransition] = useTransition();
  const [rebuilding, startRebuildTransition] = useTransition();
  const [open, setOpen] = useState(false);

  // A picker with one option is furniture — same rule as the scene picker.
  // Unlike that one, though, a single version can still need a rebuild
  // offered, so the caller (deliver/page.tsx) renders that separately rather
  // than relying on this dropdown being on screen.
  if (versions.length === 0) return null;

  const active = versions.find((version) => version.id === activeVersionId) ?? null;

  function handlePick(versionId: string): void {
    startSwitchTransition(async () => {
      try {
        const result = await setActiveFinalVersion(projectId, versionId);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to switch version.");
      }
    });
  }

  function handleRebuild(): void {
    startRebuildTransition(async () => {
      try {
        // "update", not "new": the operator is asking for THIS version's cut
        // back, not for another entry in the list. The row is re-queued in
        // place, so the number they were looking at is the number that comes
        // back.
        const result = await reassembleProject(projectId, "update");
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        toast.success("Rebuilding this cut — this can take a minute or two.");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to rebuild this cut.");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {versions.length > 1 ? (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canSwitch || switching}
              className="h-7 gap-1 px-2 text-xs font-medium"
            >
              v{active?.n ?? versions[0]?.n ?? 1}
              <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Cuts — one per assemble
            </DropdownMenuLabel>
            {versions.map((version) => (
              <DropdownMenuItem
                key={version.id}
                disabled={switching}
                onSelect={
                  version.id === activeVersionId ? undefined : (): void => handlePick(version.id)
                }
                className="justify-between gap-4"
              >
                <span className={version.id === activeVersionId ? "font-medium" : undefined}>
                  {version.id === activeVersionId ? "✓ " : ""}v{version.n}
                </span>
                <span className="text-right text-xs text-muted-foreground">
                  {describeVersion(version)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {/* Said next to the picker, not only inside it: the trigger shows one
          number and nothing else, so without this the state of the cut the
          operator is actually looking at would only be readable by opening a
          menu. */}
      {active ? (
        <span className="text-xs text-muted-foreground">{describeVersion(active)}</span>
      ) : null}

      {/* Only for a cut that WAS built and whose file is gone. A version that
          has never been built is not missing anything — it is queued, and the
          assembling placeholder is already saying so. Offering "rebuild"
          there would be a second button for work already in flight. */}
      {canSwitch && active !== null && active.builtAt !== null && !active.hasFile ? (
        <PendingButton
          type="button"
          size="sm"
          variant="outline"
          pending={rebuilding}
          onClick={handleRebuild}
        >
          Rebuild v{active.n}
        </PendingButton>
      ) : null}
    </div>
  );
}
