import Link from "next/link";
import type { JSX } from "react";
import { PAGE_SIZES, type PageSize } from "@/lib/pagination";
import { cn } from "@/lib/utils";

export interface PageSizeControlProps {
  size: PageSize;
  /** Builds the href for switching to a given page size. Callers reset `page` to 1 on the target href — see the pages' own comments for why. */
  buildHref: (size: PageSize) => string;
}

/**
 * "Rows: 10 20 50" — plain links to a new `?size=`, not a `<select>` with an
 * onChange handler. Everything else on these list pages (search, sort,
 * paging) already navigates through a real GET request with no client-side
 * JS in the loop; a `<select>` that needs `element.form.submit()` wired up
 * in a client component would be a second navigation mechanism for one
 * control, for no benefit — three links are already the entire UI a size
 * picker needs, and they work identically with JS disabled.
 *
 * Deliberately NOT gated behind `totalPages > 1` the way PaginationControls
 * is: shrinking the size can turn a one-page list into a multi-page one, so
 * this has to be reachable even when there's currently nothing to page
 * through.
 */
export function PageSizeControl({ size, buildHref }: PageSizeControlProps): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <span>Rows:</span>
      <div className="flex items-center gap-1">
        {PAGE_SIZES.map((option) => {
          const isActive = option === size;
          return (
            <Link
              key={option}
              href={buildHref(option)}
              aria-current={isActive ? "true" : undefined}
              // h-11 min-w-11 (44px): the accepted touch-target minimum this
              // app already builds around elsewhere (see
              // render-progress.tsx's retry button and
              // remove-reference-button.tsx's hit-area comments). Growing
              // the box itself rather than an invisible hit-area overlay is
              // fine here specifically because these are plain text/ghost
              // links with no artwork to keep small — unlike a photo-corner
              // icon button, a bigger tap target just reads as more
              // breathing room around a number, not as a new visual weight.
              // Still not "primary": no fill, no border, same secondary/
              // ghost coloring as before, just more of it.
              className={cn(
                "flex h-11 min-w-11 items-center justify-center rounded-sm px-2 tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                isActive
                  ? "bg-secondary font-medium text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
