"use client";

// The Character Library, lifted from an always-expanded card on the
// Character page into a modal that opens on demand ("tapos mag click
// character library bubukas un modal na lang"). The one thing that makes
// this NOT a plain `useState` dialog: the library's search and pagination
// (character-library-panel.tsx's buildCharacterLibraryHref) are real
// server navigations — a GET form and <Link>s that change `?q=`/`?page=`
// on THIS route — not client-side state flips. A dialog whose open/closed
// state lived in local `useState` would slam shut the instant a real
// navigation landed, because the navigation remounts this component with
// its state reset. So `open` is a prop driven entirely by the `library`
// search param character/page.tsx reads server-side, and every link the
// panel hands out (search, Clear, Show all, Previous/Next) carries
// `library=1` forward so the modal stays open across all of them — see
// that file's own doc comment for the full list.
//
// `children` is server-rendered content (CharacterLibraryPanel), passed
// down from the Server Component page rather than fetched or rendered
// here — the library thumbnails are signed server-side by
// signCharacterThumbnails and must not move to the client.

import { useRouter } from "next/navigation";
import type { JSX, ReactNode } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function CharacterLibraryDialog({
  open,
  closeHref,
  count,
  children,
}: {
  open: boolean;
  /**
   * Where the ✕, Escape, or an overlay click send the operator — always
   * the bare `/projects/[id]/character` route, dropping `q`/`page` along
   * with `library`. Chosen over preserving them: `q`/`page` only exist to
   * drive THIS modal (nothing else on the Character page reads them), so
   * once the modal is closed they're dead state — leaving a stale
   * `?page=3` sitting in the closed URL would silently reopen the modal
   * mid-browse the next time the compact trigger is clicked (it would
   * carry those params forward), with no on-screen sign of why. Dropping
   * them means every open starts the same way the operator expects a
   * fresh click to: at the peek.
   */
  closeHref: string;
  count: number;
  children: ReactNode;
}): JSX.Element {
  const router = useRouter();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          router.push(closeHref);
        }
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {/* A real, visible title — not a visually-hidden afterthought —
            doubling as both the on-screen header and (via Radix's
            aria-labelledby wiring) the dialog's accessible name. */}
        <DialogHeader>
          <DialogTitle>Character Library</DialogTitle>
          <p className="text-sm text-muted-foreground">{count} saved</p>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
