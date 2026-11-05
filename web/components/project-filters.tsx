import Link from "next/link";
import type { JSX } from "react";
import { cn } from "@/lib/utils";
import type { OwnerFilter } from "@/lib/projects-url";
import type { ProjectStatus } from "@/types/db";

export interface ProjectFiltersProps {
  /**
   * Accepted but no longer rendered — nothing on this page can set it now.
   * Kept on the props so the page's own signature is unchanged and a
   * hand-written or bookmarked `?status=` still round-trips through
   * buildProjectsHref rather than 404ing; the owner toggle below clears it
   * on the first click, so a silently narrowed list cannot persist with no
   * control on screen admitting to it.
   */
  statusFilter?: ProjectStatus | null;
  ownerFilter: OwnerFilter;
  /** Gate on the same `isAdmin(profile)` check the page already computes as
   * `showOwnerColumn` — a non-admin's `projects_select` RLS policy
   * (0002_rls.sql) already restricts them to their own rows, so offering
   * this control would imply a choice that doesn't exist. */
  showOwnerFilter: boolean;
  /** Builds the href for a given (status, owner) pair, carrying `q`/`sort`/
   * `size` forward and resetting to page 1 — same contract every other
   * filter/sort control on this page follows (see buildProjectsHref,
   * lib/projects-url.ts). */
  buildHref: (statusFilter: ProjectStatus | null, ownerFilter: OwnerFilter) => string;
}

// Plain `<Link>`s to a new `?owner=`, not a `<select>` + onChange or a
// controlled toggle — same reasoning PageSizeControl's own header gives for
// the page-size picker: everything else on this page (search, sort, paging,
// page size) already navigates through a real GET request with no
// client-side JS in the loop, so this stays a plain Server Component and
// works identically with JS disabled.
//
// The status pills that used to sit beside this were removed along with the
// table's Status column: the six-state vocabulary they filtered on
// (Draft/Briefed/Framed/Rendering/Complete/Delivered) belongs to the
// scripted brief-to-cut pipeline, and a /ugc clip project passing through it
// reads as a stage it was never in.

export function ProjectFilters({
  ownerFilter,
  showOwnerFilter,
  buildHref,
}: ProjectFiltersProps): JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2">
      {showOwnerFilter ? (
        <div
          role="group"
          aria-label="Filter by owner"
          className="flex items-center gap-1 rounded-lg border border-border bg-background p-1 text-sm"
        >
          {(["mine", "everyone"] as const).map((owner) => (
            <Link
              key={owner}
              href={buildHref(null, owner)}
              aria-current={ownerFilter === owner ? "true" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 outline-none transition-[background-color,color,transform] duration-150 focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-95 motion-reduce:transition-none",
                ownerFilter === owner
                  ? "bg-secondary font-medium text-secondary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {owner === "mine" ? "Mine" : "Everyone"}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
