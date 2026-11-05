import type { JSX } from "react";
import Link from "next/link";
import { PaginationControls } from "@/components/pagination-controls";
import { CharacterLibraryChooser } from "@/components/character-library-chooser";
import type { CharacterChoice } from "@/components/character-library-chooser";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { CharacterLibraryRow } from "@/lib/character-library-query";

/**
 * Every href this panel (and its trigger, character-library-trigger.tsx)
 * hands out into the URL, carrying `library=1` alongside whatever `q`/
 * `page` it already builds — see this repo's character-page task doc for
 * why: the Character Library now opens as a modal whose open/closed state
 * lives in THIS search param, not in `useState`. A search or a page link
 * built without `library=1` would navigate the operator to a real new
 * page — the library's search and pagination are genuine server
 * navigations, not client-side state flips — and that navigation would
 * carry no memory of "the modal was open," so the dialog would render
 * closed on the far side of the very click that's supposed to keep it
 * open. Every link this component renders (search Clear, "Show all",
 * Previous/Next) goes through this one function so that can't happen by
 * omission on a future edit.
 */
export function buildCharacterLibraryHref(projectId: string, q: string, page: number): string {
  const params = new URLSearchParams();
  params.set("library", "1");
  if (q) params.set("q", q);
  // Always written, even at page 1 — same reasoning as /library's
  // buildLibraryHref: `page` itself is this panel's signal for being in
  // browse mode, so omitting it at 1 would make Previous-ing from page 2
  // back to page 1 silently fall back to the peek instead of showing the
  // rest of the search/browse result.
  params.set("page", String(page));
  return `/projects/${projectId}/character?${params.toString()}`;
}

/** Opens the modal fresh — peek mode, no search, no page — e.g. the compact trigger row on the Character page. */
export function buildCharacterLibraryOpenHref(projectId: string): string {
  return `/projects/${projectId}/character?library=1`;
}

export interface CharacterLibraryPanelProps {
  projectId: string;
  /** Already sanitized — see lib/search-term.ts's sanitizeSearchTerm. */
  q: string;
  /** Same value whether this request was a peek or a browse page — see CharacterLibraryPage's own doc comment. */
  totalCount: number;
  characters: CharacterLibraryRow[];
  /** Signed thumbnail URLs, index-aligned with `characters` — signCharacterThumbnails degrades a bad row to `null` rather than throwing; see lib/character-thumbnails.ts. */
  imageUrls: (string | null)[];
  browsing: boolean;
  requestedPage: number;
  totalPages: number;
  peekCount: number;
  sourceCharacterId: string | null;
  /** Whether the PROJECT already has its own description typed — drives the "No description — add one in the Library" note per row. */
  projectHasDescription: boolean;
  fieldsLocked: boolean;
  /**
   * characters.id -> how many projects visible to this viewer currently
   * point at it (character/page.tsx counts them). A row missing from this
   * map reads as 0. See CharacterChoice.usageCount for what the number
   * does and does not claim.
   */
  usageCounts: Record<string, number>;
  /** True when this viewer may add library entries — library writes are admin-only (requireAdmin, actions/character-library.ts). Drives the grid's "+ New character" cell. */
  canCreate: boolean;
  /** Where Cancel in the chooser's footer goes — the bare Character route, same value the dialog closes to. */
  closeHref: string;
}

/**
 * The Character Library's search + grid + pagination — the modal's body.
 * Pulled out of character/page.tsx's Character card (same search form, same
 * peek/browse split, same orphaned-thumbnail degradation) so it can be unit
 * tested without standing up the whole Server Component page, and so the
 * page itself only has to decide WHETHER this renders (inside
 * CharacterLibraryDialog) rather than how.
 *
 * Stays a Server Component: the search form is a real GET and the paging
 * links are real navigations, and buildCharacterLibraryHref/…OpenHref below
 * are called from the Server Component page itself, which a "use client"
 * module's exports could not be. The one genuinely stateful part — picking
 * a card and confirming the replace — is the separate client component
 * CharacterLibraryChooser, handed already-signed URLs and already-resolved
 * flags.
 *
 * Deliberately does NOT own "the library has no characters at all" — that
 * gate lives one level up, in character/page.tsx, because it decides
 * whether to render a modal/trigger AT ALL (an empty library gets no
 * modal to open, per this feature's brief). This component only handles
 * "zero rows for the current search," which can happen to a non-empty
 * library and has to stay reachable from inside the modal.
 */
export function CharacterLibraryPanel({
  projectId,
  q,
  totalCount,
  characters,
  imageUrls,
  browsing,
  requestedPage,
  totalPages,
  peekCount,
  sourceCharacterId,
  projectHasDescription,
  fieldsLocked,
  usageCounts,
  canCreate,
  closeHref,
}: CharacterLibraryPanelProps): JSX.Element {
  const choices: CharacterChoice[] = characters.map((character, index) => ({
    id: character.id,
    name: character.name,
    description: character.description,
    imageUrl: imageUrls[index] ?? null,
    // Same field UseCharacterButton writes on click (source_character_id,
    // 0021_project_character_source.sql) — comparing against it here is what
    // makes this badge and the next click's "already in use" toast agree.
    inUse: sourceCharacterId === character.id,
    usageCount: usageCounts[character.id] ?? 0,
    // useCharacter (actions/character-library.ts) refuses exactly this
    // combination, so the card is not offered as a choice at all.
    usable: Boolean(character.description) || projectHasDescription,
  }));

  const navControls = (
    <>
      {/* Peek mode's exit: reveals the rest via real pagination instead of
          ever signing the whole library at once. */}
      {!browsing && totalCount > peekCount ? (
        <Button asChild variant="outline" className="self-center">
          <Link href={buildCharacterLibraryHref(projectId, q, 1)}>Show all ({totalCount}) →</Link>
        </Button>
      ) : null}

      {browsing ? (
        <PaginationControls
          page={requestedPage}
          totalPages={totalPages}
          previousHref={
            requestedPage > 1 ? buildCharacterLibraryHref(projectId, q, requestedPage - 1) : null
          }
          nextHref={
            requestedPage < totalPages
              ? buildCharacterLibraryHref(projectId, q, requestedPage + 1)
              : null
          }
        />
      ) : null}
    </>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* The "this replaces your description and photo" sentence is NOT here
          any more. It sat above the search box, a whole grid-scroll away
          from the buttons that did the replacing; it now sits in the
          chooser's footer, beside the confirm. */}

      {/* Plain GET form — same reasoning as /library's own search box: this
          page is already a full server render on every navigation. The
          `library` hidden field is what keeps this GET submit from reading
          as "navigate away" the instant the operator searches — without
          it, the very first thing anyone does in a library of any size
          would slam the modal shut. */}
      <form
        action={`/projects/${projectId}/character`}
        method="get"
        className="flex flex-wrap items-center gap-2"
      >
        <input type="hidden" name="library" value="1" />
        <Input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search characters…"
          aria-label="Search characters"
          className="max-w-xs"
        />
        <Button type="submit" variant="outline" size="sm">
          Search
        </Button>
        {q ? (
          // buildCharacterLibraryOpenHref, NOT buildCharacterLibraryHref(…,
          // "", 1) — the latter always writes `page`, which would flip
          // browsing mode back on at page 1 (BROWSE_PAGE_SIZE per page)
          // instead of actually resetting to the peek, same as this link
          // did before the library moved into a modal.
          <Button asChild variant="ghost" size="sm">
            <Link href={buildCharacterLibraryOpenHref(projectId)}>Clear</Link>
          </Button>
        ) : null}
      </form>

      {choices.length > 0 ? (
        <CharacterLibraryChooser
          projectId={projectId}
          choices={choices}
          locked={fieldsLocked}
          cancelHref={closeHref}
          createHref={canCreate ? "/library" : null}
        >
          {navControls}
        </CharacterLibraryChooser>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">No characters match &quot;{q}&quot;.</p>
          {navControls}
        </>
      )}
    </div>
  );
}
