"use client";

// The per-tile action menu, top-right, on both the version rail and the scene
// strip.
//
// It exists because the tiles themselves became controls. A version tile
// promotes on click and a scene tile selects on click, so every other action
// has to live somewhere that is NOT inside that control: an anchor or a button
// nested in another button is invalid, and browsers resolve it by making one
// of the two clicks unreliable — the scene strip has its own test for exactly
// that. A menu anchored beside the control keeps one tile to one primary
// gesture and puts the rest a chevron away.
//
// Rendered as a sibling of the tile's control, absolutely positioned, with
// stopPropagation on the trigger so opening the menu never fires the tile.

import { useState, type JSX } from "react";
import { ChevronDownIcon, DownloadIcon, Trash2Icon } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import { Spinner } from "@/components/spinner";
import { asAttachment } from "@/lib/download-url";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ActionResult } from "@/lib/action-result";

/**
 * Next's `notFound()` (requireProject, reached when deleteClipScene's or
 * deleteClipVersion's own requireScene->requireProject chain refuses a
 * stale scene/version id) and `redirect()` both throw a plain error
 * carrying a `digest` string — that's how Next signals "this is control
 * flow, not a failure." Next doesn't publicly export a predicate for the
 * 404 case (only `unstable_rethrow`, which treats both digests as "let it
 * through unchanged"), so this matches the digest prefix directly, same as
 * delete-project-dialog.tsx's identically-named helper: `notFound()` sets
 * `NEXT_HTTP_ERROR_FALLBACK;404`, `redirect()` sets a digest beginning
 * `NEXT_REDIRECT`. Checking this first lets a 404 surface as a toast
 * instead of falling into `unstable_rethrow`, which would rethrow it
 * straight into /ugc's own route error boundary and blank the whole
 * console over one tile's delete — a much worse failure than the delete
 * it was trying to report.
 */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")
  );
}

export interface UgcTileMenuProps {
  /** Names what the menu acts on, for screen readers: "v2", "scene 3". */
  label: string;
  downloadUrl?: string | null;
  filename?: string | null;
  /**
   * The delete action and the fields it needs, or omitted when this tile has
   * nothing to delete. Passing the action rather than a boolean keeps the
   * server action next to the fields it reads.
   */
  onDelete?: (formData: FormData) => Promise<ActionResult | void>;
  deleteFields?: Readonly<Record<string, string>>;
  /**
   * Why delete is unavailable, when it is. Shown as a disabled item rather
   * than hidden: an action that vanishes teaches nothing, and the reason is
   * the whole answer ("this is the current version").
   */
  deleteUnavailableReason?: string | null;
  /**
   * Asked via `window.confirm` before delete submits, when set. Omitted
   * entirely — not just left to return true — for a delete this menu already
   * guards enough server-side that a confirmation would only be theatre: the
   * version rail's own delete refuses the current and the last version, and
   * a prompt in front of a call that mostly just works reads as the app
   * asking permission for something it was always going to do anyway.
   */
  confirmMessage?: string;
}

export function UgcTileMenu({
  label,
  downloadUrl,
  filename,
  onDelete,
  deleteFields,
  deleteUnavailableReason,
  confirmMessage,
}: UgcTileMenuProps): JSX.Element | null {
  const [pending, setPending] = useState(false);

  if (!downloadUrl && !onDelete) return null;

  async function submitDelete(): Promise<void> {
    if (!onDelete || !deleteFields) return;
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setPending(true);
    try {
      const formData = new FormData();
      for (const [name, value] of Object.entries(deleteFields)) formData.set(name, value);
      const result = await onDelete(formData);
      // ActionResult is data, not a throw (see lib/action-result.ts) — awaiting
      // and discarding it is how "This clip is still rendering" used to reach
      // nobody: the delete refused, the menu just stopped spinning, and the
      // tile sat there looking like nothing had happened.
      if (result?.error) toast.error(result.error);
    } catch (err) {
      // The OTHER half of that same bug: deleteClipScene and
      // deleteClipVersion also THROW — a real DB failure, or requireScene's
      // AuthorizationError/requireProject's notFound() on a stale id —
      // rather than always returning an ActionResult, and this had no catch
      // at all. An unhandled rejection here left the chevron spinning (via
      // the `finally` below, which still ran), then stopped, with nothing
      // said — the exact silent-refusal shape the ActionResult branch above
      // already exists to prevent.
      if (isNotFoundError(err)) {
        toast.error("That's no longer available, or isn't yours to delete.");
        return;
      }
      // Neither action redirects today, so this is not expected to ever
      // actually rethrow — kept anyway, same reasoning every other dialog
      // in this codebase gives for keeping it even where the wrapped action
      // "never redirects today": so a future change that adds one isn't
      // silently swallowed by the toast below.
      unstable_rethrow(err);
      toast.error(err instanceof Error ? err.message : `Failed to delete ${label}.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${label}`}
          disabled={pending}
          // stopPropagation, not just preventDefault: the tile beneath this is
          // a submit button, and a click that bubbles would promote or select
          // the very thing the operator was only opening a menu on.
          onClick={(e) => e.stopPropagation()}
          className="absolute right-1 top-1 z-10 grid size-5 place-items-center rounded-full border bg-background/90 text-foreground shadow-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        >
          {/* A delete is a server round trip that ends in a page revalidate,
              and until now the only sign it was running was this control
              going grey — indistinguishable from a control that is disabled
              for some other reason. The standing rule is a spinner on any
              in-flight control, never a swapped label or nothing at all. */}
          {pending ? (
            <Spinner className="size-3 text-muted-foreground" />
          ) : (
            <ChevronDownIcon aria-hidden="true" className="size-3" />
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-40">
        {downloadUrl ? (
          <DropdownMenuItem asChild>
            <a href={asAttachment(downloadUrl, filename)} download={filename ?? undefined}>
              <DownloadIcon aria-hidden="true" className="size-3.5" />
              Download
            </a>
          </DropdownMenuItem>
        ) : null}

        {onDelete ? (
          <DropdownMenuItem
            variant="destructive"
            disabled={Boolean(deleteUnavailableReason) || pending}
            onSelect={(e) => {
              e.preventDefault();
              void submitDelete();
            }}
          >
            <Trash2Icon aria-hidden="true" className="size-3.5" />
            {deleteUnavailableReason ?? "Delete"}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
