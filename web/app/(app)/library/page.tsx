import Link from "next/link";
import { redirect } from "next/navigation";
import type { JSX } from "react";
import { requireAdmin } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import {
  createCharacterFromUpload,
  createCharacterFromDescription,
  updateCharacter,
  removeCharacter,
} from "@/actions/character-library";
import { AddCharacterForm } from "@/components/add-character-form";
import { CharacterCard } from "@/components/character-card";
import { PaginationControls } from "@/components/pagination-controls";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { estimatedRefFrameCostUsd } from "@/lib/models";
import { parsePage } from "@/lib/pagination";
import { sanitizeSearchTerm } from "@/lib/search-term";
import { fetchCharacterLibraryPage } from "@/lib/character-library-query";
import { signCharacterThumbnails } from "@/lib/character-thumbnails";
import { RenderTimer } from "@/lib/perf-log";

// Grid sizing: see the width:400/resize:"contain"/quality:70 doc comment
// further down for how these interact with this page's own max-w-2xl
// wrapper. PEEK_COUNT is a glance-sized default — enough to confirm "yes,
// the character I just added is in here" without signing the whole
// library — and BROWSE_PAGE_SIZE is the page size once an admin actually
// wants to look through it (via search or "Show all"). Both are bounded,
// unlike the old unconditional `rows.map(...)` over every row the table
// had, which at the spec's 120 characters meant 120 signing round-trips on
// every load of this page.
const PEEK_COUNT = 12;
const BROWSE_PAGE_SIZE = 24;

// Admin-only, gated the way /spend already is: requireAdmin (actions/guard.ts)
// throws AuthorizationError for a signed-in non-admin, and NavLinks
// (components/nav-links.tsx) never shows this link to one in the first
// place — same two-layer treatment (nav visibility + a server-side check
// that doesn't trust it) every admin surface in this app uses.
//
// This page owns "add" and "edit"/"remove"; "pick" lives on every
// project's own Character step (character/page.tsx's library grid) because
// every operator, not just admins, needs it there.

function buildLibraryHref(q: string, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  // Always written, even at page 1 — unlike buildProjectsHref, "page"
  // itself is this page's signal for being in browse mode (see `browsing`
  // below), so omitting it at 1 would make Previous-ing from page 2 back to
  // page 1 silently fall back to the 12-item peek instead of showing the
  // rest of the search/browse result.
  params.set("page", String(page));
  return `/library?${params.toString()}`;
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string | string[] }>;
}): Promise<JSX.Element> {
  // See lib/perf-log.ts for the flag this is gated behind and the safety
  // contract .step()/.finish() follow.
  const timer = new RenderTimer("/library");

  const { user } = await timer.step("require_admin", requireAdmin());

  const supabase = await createClient();

  const resolvedSearchParams = await searchParams;
  const q = sanitizeSearchTerm(resolvedSearchParams.q ?? "");
  const browsing = resolvedSearchParams.page !== undefined || q.length > 0;
  const requestedPage = parsePage(resolvedSearchParams.page);
  const pageSize = browsing ? BROWSE_PAGE_SIZE : PEEK_COUNT;

  // ilike over name/description — not a vector/embedding search, same
  // reasoning as the projects list (see lib/search-term.ts's header:
  // substring match on a short name/description gets nearly all the value
  // here for a fraction of the work). The query itself (peek-vs-browse,
  // range math, the `.or()` filter) lives in lib/character-library-query.ts,
  // shared with the Character Library grid on every project's Character
  // step (character/page.tsx) — see that file's header for why.
  const { rows, totalCount, totalPages } = await timer.step(
    "character_library_query",
    fetchCharacterLibraryPage(supabase, {
      q,
      browsing,
      requestedPage,
      peekCount: PEEK_COUNT,
      pageSize,
    }),
  );

  // Same stale-bookmark guard as /projects: a `?page=` past the real last
  // page would otherwise render an empty grid with pagination controls
  // that claim a later page exists. Peek mode has no such param to
  // overshoot (it always fetches the same fixed PEEK_COUNT), so this only
  // applies once browsing.
  if (browsing && requestedPage > totalPages && totalCount > 0) {
    redirect(buildLibraryHref(q, totalPages));
  }

  // This grid is grid-cols-2 sm:grid-cols-3 inside this page's own
  // max-w-2xl (672px) wrapper, with a Card (no horizontal padding) and
  // CardContent (px-6) around it: the box is ~131px CSS-wide on a 375px
  // mobile viewport (2 cols, minus 2*24px page padding, 2*24px card
  // padding, one 16px gap) and tops out at ~181px at the sm:3-col
  // breakpoint (this page never grows past its own 672px cap, so that's
  // the true max, not just "large viewport"). width:400 covers full DPR3
  // on mobile (131*3=393) and full DPR2 on desktop (181*2=362) with a
  // little headroom, and quality 70 (not this file's usual 80) measures
  // meaningfully smaller at this thumbnail size with invisible artifacts —
  // see lib/character-thumbnails.ts, which owns the exact transform and the
  // Promise.allSettled degrade-to-placeholder handling this shares with the
  // Character Library grid on every project's Character step.
  const imageUrls = await timer.step("thumbnail_signing", signCharacterThumbnails(rows, "library"));

  timer.finish({ userId: user.id });

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Admin</p>
        <h1 className="text-2xl font-medium text-foreground">Character Library</h1>
        <p className="text-sm text-muted-foreground">
          Characters added here can be picked on any project&apos;s Character step. Editors can
          pick; only admins can add, edit, or remove.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add a character</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <AddCharacterForm
            uploadAction={createCharacterFromUpload}
            generateAction={createCharacterFromDescription}
            generateCostUsd={estimatedRefFrameCostUsd()}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Library ({totalCount})</CardTitle>
          <CardDescription>
            {totalCount === 0 && !q
              ? "No characters yet — add one above."
              : rows.length === 0 && q
                ? `No characters match "${q}".`
                : null}
          </CardDescription>
        </CardHeader>
        {totalCount > 0 || q ? (
          <CardContent className="flex flex-col gap-4">
            {/* Plain GET form, same reasoning as the projects list's search
                box: this page is already a full server render on every
                navigation, and that navigation IS this app's loading
                affordance — no client-side search-as-you-type, no spinner
                to invent on top of it. Submitting drops any existing
                `page`, same as /projects: a search result set has its own
                page count, not the unfiltered library's. */}
            <form action="/library" method="get" className="flex flex-wrap items-center gap-2">
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
                <Button asChild variant="ghost" size="sm">
                  <Link href="/library">Clear</Link>
                </Button>
              ) : null}
            </form>

            {rows.length > 0 ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {rows.map((character, index) => (
                  // Orphaned row (storage_key no longer resolves to a real
                  // object — see lib/character-thumbnails.ts) degrades to
                  // CharacterThumbnail's placeholder instead of throwing:
                  // everything else (edit, remove) still targets
                  // `character.id`, which is still a perfectly good row, so
                  // those stay live regardless.
                  <CharacterCard
                    key={character.id}
                    name={character.name}
                    description={character.description}
                    imageUrl={imageUrls[index]}
                    updateCharacter={updateCharacter.bind(null, character.id)}
                    removeCharacter={removeCharacter.bind(null, character.id)}
                  />
                ))}
              </div>
            ) : null}

            {/* Peek mode's exit: reveals the rest via real pagination
                (BROWSE_PAGE_SIZE per page) instead of the unguarded
                sign-everything-at-once this replaces — see PEEK_COUNT's
                doc comment above. Only shown when there's actually more to
                reveal; browsing mode gets the real pager instead. */}
            {!browsing && totalCount > PEEK_COUNT ? (
              <Button asChild variant="outline" className="self-center">
                <Link href={buildLibraryHref(q, 1)}>Show all ({totalCount}) →</Link>
              </Button>
            ) : null}

            {browsing ? (
              <PaginationControls
                page={requestedPage}
                totalPages={totalPages}
                previousHref={requestedPage > 1 ? buildLibraryHref(q, requestedPage - 1) : null}
                nextHref={
                  requestedPage < totalPages ? buildLibraryHref(q, requestedPage + 1) : null
                }
              />
            ) : null}
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
