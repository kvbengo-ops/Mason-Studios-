"use client";

import { useEffect, useState } from "react";
import type { JSX } from "react";
import Link, { useLinkStatus } from "next/link";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Spinner } from "@/components/spinner";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface PaginationControlsProps {
  /** 1-indexed current page (see lib/pagination.ts's parsePage/pageRange). */
  page: number;
  totalPages: number;
  /** Builds the href for a given page number, carrying along whatever other search params (e.g. `q`) the caller already has. */
  /**
   * Href for the previous page, or null when there is none.
   *
   * Strings, NOT a `buildHref: (page: number) => string` callback. This
   * component calls useLinkStatus, which makes it a Client Component, and a
   * function cannot cross the Server/Client boundary — every page that
   * renders this pager is a Server Component, so passing one throws
   * "Functions cannot be passed directly to Client Components" at render
   * time and takes the whole route down. That is not hypothetical: it
   * shipped and broke /projects, /users and /allowances at once.
   *
   * Two hrefs rather than the page numbers plus a shared builder, because
   * the three callers each build their URLs differently (lib/projects-url
   * .ts, and their own local helpers) — the caller is the only place that
   * knows how, and a string is the one shape that survives the boundary.
   */
  previousHref: string | null;
  /** Href for the next page, or null when there is none. */
  nextHref: string | null;
}

/**
 * Reads THIS Link's own navigation status and reports it to the enclosing
 * PagerLink (below) via `onPendingChange`. `useLinkStatus` only resolves
 * against the nearest ancestor `<Link>` (its `LinkStatusContext.Provider`
 * lives inside next/link's own render — see
 * node_modules/next/dist/client/app-dir/link.js), so this has to be a
 * component actually mounted as a CHILD of that `<Link>`, not code that
 * runs alongside it — a hook called from PagerLink itself, outside the
 * Link's subtree, would just get the context's default value and never
 * see `pending` flip.
 *
 * Renders the visible label + icon (swapping the icon for a spinner while
 * pending — never both at once) and has no state of its own: `pending` is
 * lifted to PagerLink via a plain `useState` setter (a stable function
 * identity, so this is safe as an effect dependency without a `useCallback`
 * wrapper at the call site) so PagerLink can disable the *anchor itself*.
 * That has to happen one level up: `pointer-events-none` set here, on
 * something INSIDE the anchor, would not stop the anchor from receiving a
 * click — hit-testing just falls through the excluded child to the next
 * element behind it, which is the anchor. Only the anchor's own
 * pointer-events (and its own onClick guard) can actually block a second
 * click from queuing a second navigation.
 */
function PagerLinkBody({
  label,
  iconPosition,
  onPendingChange,
}: {
  label: string;
  iconPosition: "leading" | "trailing";
  onPendingChange: (pending: boolean) => void;
}): JSX.Element {
  const { pending } = useLinkStatus();

  // Effect, not a value read during render: this component's own render
  // output (label/spinner) is free to key off `pending` directly, but
  // *telling the parent* is a side effect (it calls a setState in a
  // different component's closure) and belongs in an effect for the same
  // reason any "notify a parent" pattern does — doing it during render
  // would mean two components writing state from the same render pass.
  useEffect(() => {
    onPendingChange(pending);
  }, [pending, onPendingChange]);

  const icon = pending ? (
    // motion-safe:, not unconditional — unlike status-icon.tsx's
    // spinner (an unguarded exception, argued explicitly in
    // that file's own header comment for a running RENDER an operator is
    // actively watching), this spinner marks a page navigation that takes
    // ~137ms median — reduced-motion users lose nothing load-bearing by
    // seeing a static circle instead of a spin for a sixth of a second.
    <Spinner className="motion-safe:animate-spin animate-none" />
  ) : iconPosition === "leading" ? (
    <ChevronLeftIcon aria-hidden />
  ) : (
    <ChevronRightIcon aria-hidden />
  );

  return iconPosition === "leading" ? (
    <>
      {icon}
      {label}
    </>
  ) : (
    <>
      {label}
      {icon}
    </>
  );
}

/**
 * One Prev/Next control. Wraps `next/link`'s `<Link>` — a normal soft
 * navigation, exactly as before this change — and adds only the missing
 * piece: visible feedback while that navigation is in flight, plus making
 * the control non-interactive for that window so a second click (or a
 * second Enter-key activation while the first is still pending) can't
 * queue a second navigation on top of it.
 *
 * `pending` itself lives here, lifted from PagerLinkBody (see that
 * component's header) — this is the ONE place both halves of "disable it"
 * meet: the className that removes it from hit-testing, and the onClick
 * that swallows a click event that slips through the small window before
 * that className has committed (React state updates from the child's
 * effect land one tick after the click that started them, not
 * synchronously with it).
 */
function PagerLink({
  href,
  label,
  iconPosition,
}: {
  href: string;
  label: string;
  iconPosition: "leading" | "trailing";
}): JSX.Element {
  const [pending, setPending] = useState(false);

  return (
    <Link
      href={href}
      aria-disabled={pending || undefined}
      // Keyboard activation (Enter/Space on a focused anchor) dispatches
      // the same click event a pointer click does, so this one handler
      // covers both a double click and a double Enter-press.
      onClick={(event) => {
        if (pending) {
          event.preventDefault();
        }
      }}
      tabIndex={pending ? -1 : undefined}
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        pending && "pointer-events-none opacity-70",
      )}
    >
      <PagerLinkBody label={label} iconPosition={iconPosition} onPendingChange={setPending} />
    </Link>
  );
}

/**
 * Prev/Next + "Page X of Y", shared by every list this pass paginated
 * (projects, the Character Library, /spend's runs table) so the three
 * don't grow three slightly different pagers. Plain `<Link>`s to a new
 * `?page=` — no client-side state, no fetch-on-click — because every page
 * that uses this is already a Server Component that reads `page` out of
 * `searchParams`; a normal navigation is the whole mechanism.
 *
 * That soft navigation was already client-side (Link fetches the RSC
 * payload and patches the tree — it was never a full page load), but
 * nothing on screen moved during the ~137ms median it takes, which reads
 * as a dead click followed by a jump. PagerLink (above) is the fix:
 * `useLinkStatus`, read from inside the clicked Link's own subtree, drives
 * a spinner + a temporarily-disabled control — still no fetch, no API
 * route, no state this component owns about the navigation itself.
 *
 * Renders nothing for a single-page result — a pager with both arrows
 * permanently disabled communicates "there's more, somehow not here,"
 * which is worse than no pager at all.
 */
export function PaginationControls({
  page,
  totalPages,
  previousHref,
  nextHref,
}: PaginationControlsProps): JSX.Element | null {
  if (totalPages <= 1) {
    return null;
  }

  const hasPrevious = previousHref !== null;
  const hasNext = nextHref !== null;

  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-between gap-4 border-t border-border pt-4"
    >
      {hasPrevious ? (
        <PagerLink href={previousHref} label="Previous" iconPosition="leading" />
      ) : (
        <Button variant="outline" size="sm" disabled>
          <ChevronLeftIcon />
          Previous
        </Button>
      )}

      <p className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </p>

      {hasNext ? (
        <PagerLink href={nextHref} label="Next" iconPosition="trailing" />
      ) : (
        <Button variant="outline" size="sm" disabled>
          Next
          <ChevronRightIcon />
        </Button>
      )}
    </nav>
  );
}
