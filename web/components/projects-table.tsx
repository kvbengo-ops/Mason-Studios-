"use client";

// The /projects table body (app/(app)/projects/page.tsx). The page itself
// stays server-rendered and does its own data fetching — this component
// receives the already-fetched, already-formatted rows as plain
// props and touches no Supabase/Next-server API of its own. Date/currency
// strings are pre-formatted server-side (page.tsx's dateTimeFormatter /
// formatUsd) rather than formatted here: Intl.DateTimeFormat's dateStyle/
// timeStyle resolve against the RUNNING PROCESS's timezone when no explicit
// `timeZone` is passed, so formatting on the client (during hydration,
// against the browser's local timezone) instead of the server (during SSR)
// could render a different string on the very first paint than the server
// sent down — a hydration mismatch. Formatting once, server-side, and
// passing the resulting string is what page.tsx already did before this
// split; nothing about the format itself changed.
import { useState } from "react";
import type { JSX } from "react";
import Image from "next/image";
import Link from "next/link";
import { InitialsAvatar } from "@/components/initials-avatar";
import { SortableTableHead } from "@/components/sortable-table-head";
import { ProjectRowActions } from "@/components/project-row-actions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { buildProjectsHref } from "@/lib/projects-url";
import type { OwnerFilter, SortColumn } from "@/lib/projects-url";
import type { PageSize } from "@/lib/pagination";

import type { ParsedSort } from "@/lib/sort-params";
import type { ProjectKind, ProjectStatus } from "@/types/db";
/**
 * Which console a project row opens.
 *
 * One switch rather than a nested ternary, because this is the branch
 * 0064_project_kind.sql exists for and 0084 added a third arm to: a kind with
 * no case here silently opens the wrong screen, and the wrong screen for an
 * image project is a six-step wizard it can never complete. An exhaustive
 * switch on ProjectKind makes the next kind a type error instead of a bug
 * someone finds by clicking.
 */
function projectHref(kind: ProjectKind, projectId: string): string {
  switch (kind) {
    case "clip":
      return `/ugc/${projectId}`;
    case "image":
      return `/images/${projectId}`;
    case "scripted":
      return `/projects/${projectId}`;
  }
}

export interface ProjectTableRow {
  id: string;
  title: string;
  ownerEmail: string | null;
  sceneCount: number;
  /** Which console the title link opens — see this file's own comment on
   * the `<Link>` below and 0064_project_kind.sql. */
  kind: ProjectKind;
  /** Pre-formatted server-side in the app's display credit unit. */
  costLabel: string;
  /** Controls whether the row's "…" menu offers Delete. */
  canDelete: boolean;
  thumbnailUrl: string | null;
  readySceneCount: number;
  updatedAtLabel: string;
  costSecondaryLabel: string | null;
}

function ProjectThumbnail({ title, url }: { title: string; url: string | null }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div
        aria-hidden="true"
        data-project-thumbnail-placeholder
        className="flex size-12 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors group-hover:border-primary/50"
      >
        {title.slice(0, 1) || "?"}
      </div>
    );
  }
  return (
    <Image
      src={url}
      alt=""
      width={48}
      height={48}
      unoptimized
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="size-12 shrink-0 rounded-md border border-border bg-muted object-cover transition-transform duration-200 group-hover:scale-[1.03] motion-reduce:transition-none"
    />
  );
}

export function ProjectsTable({
  projects,
  showOwnerColumn,
  sort,
  q,
  pageSize,
  statusFilter = null,
  ownerFilter = "mine",
}: {
  projects: ProjectTableRow[];
  showOwnerColumn: boolean;
  sort: ParsedSort<SortColumn>;
  q: string;
  pageSize: PageSize;
  /** Threaded through only so this table's own sort-header hrefs (buildHref
   * below) carry the active filters forward — the table doesn't render or
   * apply either filter itself (that's page.tsx + ProjectFilters). Defaults
   * match buildProjectsHref's own defaults ("no filter" / "mine") so
   * existing callers/tests that don't pass these still build the same
   * hrefs they did before filters existed. */
  statusFilter?: ProjectStatus | null;
  ownerFilter?: OwnerFilter;
}): JSX.Element {
  const buildHref = (next: ParsedSort<SortColumn>): string =>
    buildProjectsHref(q, 1, next, pageSize, statusFilter, ownerFilter);

  const displayOwnerColumn = showOwnerColumn && ownerFilter !== "mine";

  // Fixed, per-column percentage widths (table-fixed below) so a long
  // Title/Product/Owner truncates with an ellipsis instead of the table's
  // overflow-x-auto wrapper (components/ui/table.tsx) growing a horizontal
  // scrollbar and shoving Actions off-screen — `truncate` does nothing on a
  // column that's still free to grow, which is what the old auto-layout
  // table did.
  //
  // Not the flat "22/12/11/14/6/14/8/13" split this task started from:
  // both SortableTableHead's label AND its sort icon are forced
  // `whitespace-nowrap` unconditionally (see that component's own header
  // comment) — a header can't wrap the way a body cell can. At this page's
  // real rendered width (<main>'s `mx-auto max-w-6xl` minus the sidebar and
  // page padding — roughly 950-1100px on a typical laptop/desktop, per
  // app/(app)/layout.tsx and this page's own `p-6`), "Cost to date" plus
  // its icon needs on the order of 130-140px and "Scenes" plus its icon
  // needs on the order of 85-90px; the flat split's 8%/6% (~85-90px /
  // 65-75px at that width) undershoots both, which would overflow the
  // HEADER row, not just a body cell. Title gave up the difference (22% ->
  // 18%) rather than Owner/Status/Actions: Title already degrades
  // gracefully (truncate + title=), so a narrower share there is a
  // non-event, where a clipped sort-header is a real regression. Verified
  // by char-count/px arithmetic, not a real browser render (no
  // Playwright/Puppeteer in this repo) — flagged in this task's report as
  // an estimate, not a measurement.
  //
  // "Created" (below, whitespace-nowrap, NOT part of this table) is
  // deliberately left at its plain share and NOT rebalanced or truncated
  // here even though the same arithmetic says a full "Aug 25, 2026, 3:54
  // AM" is tight-to-overflowing at the narrow end of that range —
  // shortening what that column displays is a product call this task
  // explicitly reserved, not an engineering one to make unilaterally; see
  // this table's own PR description.
  // Product and Status are gone, and their 21-25% goes almost entirely to
  // Title — the column that was squeezed to 18% to make room for them and the
  // one that degrades worst when narrow. Owner, Scenes, Created and Cost keep
  // roughly what they had: each was sized against the width its own header
  // needs, and widening them buys nothing.
  const titleColWidth = displayOwnerColumn ? "w-[36%]" : "w-[47%]";
  const ownerColWidth = "w-[16%]";
  const scenesColWidth = displayOwnerColumn ? "w-[18%]" : "w-[21%]";
  const createdColWidth = displayOwnerColumn ? "w-[14%]" : "w-[16%]";
  const costColWidth = displayOwnerColumn ? "w-[9%]" : "w-[9%]";
  const actionsColWidth = "w-[7%]";

  return (
    <>
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <SortableTableHead
              column="title"
              label="Project"
              sort={sort}
              defaultDirection="asc"
              buildHref={buildHref}
              className={titleColWidth}
            />
            {displayOwnerColumn ? (
              <SortableTableHead
                column="owner"
                label="Owner"
                sort={sort}
                defaultDirection="asc"
                buildHref={buildHref}
                className={ownerColWidth}
              />
            ) : null}
            <SortableTableHead
              column="scenes"
              label="Progress"
              align="right"
              sort={sort}
              buildHref={buildHref}
              className={scenesColWidth}
            />
            <SortableTableHead
              column="updated"
              label="Updated"
              sort={sort}
              buildHref={buildHref}
              className={createdColWidth}
            />
            <SortableTableHead
              column="cost"
              label="Spend"
              align="right"
              sort={sort}
              buildHref={buildHref}
              className={costColWidth}
            />
            <TableHead className={cn("text-right", actionsColWidth)}>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((project) => {
            return (
              <TableRow key={project.id} className="group hover:bg-muted/60">
                {/* No `max-w-xs` any more — the column's own `table-fixed`
                    width (the header above) is what now constrains this
                    cell, and a separate, screen-size-independent max-width
                    on top of it either did nothing (column narrower than
                    20rem) or fought it (column wider than 20rem, wasting
                    the share this cell was just given). */}
                <TableCell>
                  {/* Branches on kind (0064_project_kind.sql /
                      0067_project_directory_kind.sql), not hard-coded to one
                      route: a clip project (createClipProject) opens the
                      clip console — the title is the row's main affordance
                      and it should land where the work happens, with
                      /projects/<id> and its six steps still reachable from
                      the Actions menu and from the console's own "Open the
                      full project" link — but a scripted project has no
                      /ugc/<id> route to open at all, so it keeps going to
                      the wizard's overview same as always. */}
                  <Link
                    href={projectHref(project.kind, project.id)}
                    title={project.title}
                    className="group flex min-w-0 items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <ProjectThumbnail title={project.title} url={project.thumbnailUrl} />
                    <span className="min-w-0 truncate font-medium text-foreground group-hover:text-primary">
                      {project.title}
                    </span>
                  </Link>
                </TableCell>
                {displayOwnerColumn ? (
                  // title= on the cell (not just the inner span) — the
                  // avatar sits in the same flex row, so hovering the
                  // couple of pixels between it and the email text should
                  // still surface the full address, not just hovering the
                  // text itself.
                  <TableCell
                    className="text-muted-foreground"
                    title={project.ownerEmail ?? undefined}
                  >
                    <div className="flex items-center gap-2">
                      <InitialsAvatar email={project.ownerEmail} />
                      {/* min-w-0: a flex item's default min-width is `auto`
                          (its content's intrinsic width), which overrides
                          `truncate` entirely — the classic flexbox truncation
                          trap. `flex-1` lets it actually claim the row's
                          remaining space instead of just its content width. */}
                      <span className="min-w-0 flex-1 truncate">{project.ownerEmail ?? "—"}</span>
                    </div>
                  </TableCell>
                ) : null}
                <TableCell>
                  <div
                    className="flex min-w-24 items-center gap-2"
                    aria-label={`Progress: ${project.readySceneCount} of ${project.sceneCount} scenes`}
                  >
                    <div
                      className="h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-muted"
                      aria-hidden="true"
                    >
                      <div
                        className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
                        style={{
                          width: `${project.sceneCount > 0 ? Math.min(100, (project.readySceneCount / project.sceneCount) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                      {project.readySceneCount}/{project.sceneCount}
                    </span>
                  </div>
                </TableCell>
                {/* truncate, not just nowrap. A full "Aug 25, 2026, 3:54 AM"
                    is the widest thing in this row and can exceed its share
                    of a table-fixed layout; left to spill it would push the
                    table past its container and bring back exactly the
                    horizontal scrollbar this whole pass exists to remove.
                    Ellipsising it is the same treatment Title and Product
                    already get, and the `title` below keeps the full
                    timestamp one hover away — so nothing is lost, unlike
                    shortening the format, which would decide for everyone
                    that the time of day does not matter. */}
                <TableCell
                  className="truncate whitespace-nowrap text-muted-foreground"
                  title={project.updatedAtLabel}
                >
                  <span className="block" title={project.updatedAtLabel}>
                    {project.updatedAtLabel}
                  </span>
                </TableCell>
                <TableCell numeric>
                  <span className="block">{project.costLabel}</span>
                  {project.costSecondaryLabel ? (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {project.costSecondaryLabel}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">
                  <ProjectRowActions
                    projectId={project.id}
                    projectTitle={project.title}
                    canDelete={project.canDelete}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
