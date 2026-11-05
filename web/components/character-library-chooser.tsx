"use client";

// The Character Library modal's grid, as a SELECT-then-CONFIRM control.
//
// It used to be a grid where every card carried its own "Use" button that
// fired on the first click. What that button does is not small: useCharacter
// (actions/character-library.ts) copies the library entry's photo AND its
// description over this project's own, replacing both. A single stray click
// in a grid of thumbnails — the densest, most mis-clickable layout on the
// screen — destroyed a description the operator may have spent real money
// improving, with no confirm and no undo.
//
// So the grid now only SELECTS, and the footer commits: the sentence naming
// what is about to be overwritten sits directly beside the button that does
// it, which is the one place it can't be scrolled away from (it used to be a
// line of small print above the search box, with the Use buttons a grid-
// scroll below it). Cancel is a real control there too, rather than leaving
// ✕/Escape/overlay-click as the only ways out.
//
// Client, unlike its server-rendered parent (character-library-panel.tsx):
// selection is local state. Everything it renders is passed down already
// resolved — the thumbnails are signed server-side by signCharacterThumbnails
// and arrive as URLs, never as storage keys.

import { useState } from "react";
import type { JSX, ReactNode } from "react";
import Link from "next/link";
import { CharacterThumbnail } from "@/components/character-thumbnail";
import { UseCharacterButton } from "@/components/use-character-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface CharacterChoice {
  id: string;
  name: string;
  /** The library entry's own description — the text Use copies over this project's. */
  description: string | null;
  /** Signed thumbnail URL, or null for a row whose storage object could not be signed. */
  imageUrl: string | null;
  /** `projects.source_character_id` already points at this row for this project. */
  inUse: boolean;
  /**
   * How many projects VISIBLE TO THIS VIEWER currently point at this
   * character. Under `projects_select` (0002_rls.sql) that is the viewer's
   * own projects, or every project for an admin — so it can undercount for a
   * non-admin in a multi-user install. It is also a CURRENT-use count, not a
   * lifetime one: source_character_id is blanked when the description is
   * edited (actions/setup.ts) or the photo removed. The wording below says
   * "in use", not "used", for exactly that reason.
   */
  usageCount: number;
  /**
   * False when neither this row nor the project has any description — the
   * combination useCharacter refuses outright. Selecting one of these would
   * only produce an error toast on confirm.
   */
  usable: boolean;
}

export function CharacterLibraryChooser({
  projectId,
  choices,
  locked,
  cancelHref,
  createHref,
  children,
}: {
  projectId: string;
  choices: CharacterChoice[];
  locked: boolean;
  /** Where Cancel goes — the bare Character route, which closes the modal. */
  cancelHref: string;
  /** The Character Library management page, or null for a viewer who can't add entries (library writes are admin-only — requireAdmin in actions/character-library.ts). */
  createHref: string | null;
  /**
   * Server-rendered controls that belong between the grid and the footer —
   * "Show all" and the pagination links. They live outside this component
   * (they are real <Link> navigations built by the panel) but must render
   * ABOVE the confirm footer, or the footer stops being the last thing on
   * screen and its sticky bottom edge sits over them.
   */
  children?: ReactNode;
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = choices.find((choice) => choice.id === selectedId) ?? null;

  return (
    <>
      <div className="max-h-96 overflow-y-auto rounded-md">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {choices.map((choice) => {
            const isSelected = choice.id === selectedId;
            return (
              <div key={choice.id} className="flex flex-col">
                <button
                  type="button"
                  aria-pressed={isSelected}
                  disabled={locked || !choice.usable}
                  onClick={() => setSelectedId(isSelected ? null : choice.id)}
                  className={cn(
                    "flex h-full flex-col gap-2 rounded-md border p-2 text-left transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                    isSelected
                      ? "border-primary ring-2 ring-primary"
                      : "border-border hover:bg-muted/50",
                  )}
                >
                  {/* Orphaned row (storage_key no longer resolves to a real
                      object — see lib/character-thumbnails.ts) degrades to
                      CharacterThumbnail's placeholder instead of throwing:
                      the name, the in-use badge and the id this card carries
                      are all still perfectly good. */}
                  <CharacterThumbnail url={choice.imageUrl} alt={choice.name} />
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {choice.name}
                    </span>
                    {choice.inUse ? (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                        In use
                      </span>
                    ) : null}
                  </span>
                  {/* The text that is about to be copied INTO the project,
                      not just the name of the row it comes from. Picking on
                      thumbnail and name alone means the description — the
                      only thing the compiler reads — arrives unseen. */}
                  {choice.description ? (
                    <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                      {choice.description}
                    </span>
                  ) : null}
                  <span className="mt-auto text-[10px] text-muted-foreground">
                    {choice.usageCount > 0
                      ? `in use in ${choice.usageCount} project${choice.usageCount === 1 ? "" : "s"}`
                      : "not in use anywhere"}
                  </span>
                </button>
                {/* Sits OUTSIDE the button: it contains a link, and a link
                    inside a button is neither clickable nor valid markup. */}
                {choice.usable ? null : (
                  <p className="p-2 pt-1 text-[10px] text-muted-foreground">
                    No description —{" "}
                    <a href="/library" className="underline">
                      add one in the Library
                    </a>{" "}
                    before this can be used.
                  </p>
                )}
              </div>
            );
          })}

          {/* The grid's own way to add one, so an operator who opens the
              library and finds nothing that fits is not left with only ✕. It
              LEAVES this screen for /library, which the design's in-modal
              "+ new" card does not — creating in place needs the library's
              own upload/describe form, which lives on that page. */}
          {createHref ? (
            <Link
              href={createHref}
              className="flex min-h-24 flex-col items-center justify-center rounded-md border border-dashed border-border p-2 text-center text-xs text-muted-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              + New character
            </Link>
          ) : null}
        </div>
      </div>

      {children}

      {/* Pinned to the bottom of the dialog's scroll: the sentence saying
          what is destroyed has to be readable at the moment of the click,
          not several grid rows above it. */}
      <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-background pt-3">
        <p className="mr-auto max-w-sm text-xs text-muted-foreground">
          {selected
            ? `Use replaces this project's description and photo with ${selected.name}'s copy of each.`
            : "Pick a character. Using one replaces this project's description and photo."}
        </p>
        <Button asChild variant="ghost" size="sm">
          <Link href={cancelHref}>Cancel</Link>
        </Button>
        {selected ? (
          // Width-capped: UseCharacterButton is w-full by default (it used to
          // be a card-wide control), which would stretch it across the footer.
          <div className="w-32">
            <UseCharacterButton
              projectId={projectId}
              characterId={selected.id}
              name={selected.name}
              inUse={selected.inUse}
              locked={locked}
              closeHref={cancelHref}
            />
          </div>
        ) : (
          <div className="w-32">
            <Button type="button" size="sm" variant="outline" disabled className="w-full">
              Use
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
