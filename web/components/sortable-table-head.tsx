import Link from "next/link";
import type { JSX } from "react";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { toggleDirection } from "@/lib/sort-params";
import type { ParsedSort, SortDirection } from "@/lib/sort-params";

export interface SortableTableHeadProps<Column extends string> {
  /** This header's own column id (one of the caller's sort allowlist). */
  column: Column;
  label: string;
  /** The list's current sort, from parseSort(). */
  sort: ParsedSort<Column>;
  /** Builds the href for clicking this header: same column flips direction, a different column defaults to that column's own `defaultDirection`. */
  buildHref: (sort: ParsedSort<Column>) => string;
  /** Direction a click lands on when this column isn't already the active one. Defaults to "desc" (biggest/newest first is the more common first click on an unsorted numeric or date column). */
  defaultDirection?: SortDirection;
  align?: "left" | "right";
  /** Merged onto the rendered `<th>` alongside its own whitespace-nowrap/
   * align classes (cn() lets a caller's width class win over nothing here,
   * since this component sets no width of its own). Added for the
   * /projects table's table-fixed column widths (projects-table.tsx) —
   * optional and additive, so /users and /allowances (the other two
   * SortableTableHead callers, which don't pass it) render exactly as
   * before. */
  className?: string;
}

/**
 * A `<th>` whose entire content is a real link (not a click handler on the
 * cell) to the same page with `?sort=`/`?dir=` set — the accessible-control
 * requirement this page's spec calls out. `aria-sort` goes on the `<th>`
 * itself (the WAI-ARIA-documented place for it), only when this column is
 * the active one; the other columns simply omit the attribute rather than
 * spelling out `aria-sort="none"` on every inactive header.
 *
 * The direction icon is ALWAYS rendered — swapped between an up arrow, a
 * down arrow, and a neutral up-down glyph, never conditionally mounted —
 * so a column becoming active (or an active column flipping direction)
 * changes only which icon and how opaque it is, never the header's width.
 * A header that only grows an icon on click/hover reads as unsortable
 * until the moment it's clicked; this one hints at "sortable" (a muted,
 * always-present up-down glyph) before it's ever touched, per this page's
 * spec.
 */
export function SortableTableHead<Column extends string>({
  column,
  label,
  sort,
  buildHref,
  defaultDirection = "desc",
  align = "left",
  className,
}: SortableTableHeadProps<Column>): JSX.Element {
  const isActive = sort.column === column;
  // toggleDirection, not a second inline copy of the same flip: the rule
  // lives in lib/sort-params.ts beside parseSort, which is what reads the
  // direction back out of the URL this href writes.
  const nextDirection: SortDirection = isActive
    ? toggleDirection(sort.direction)
    : defaultDirection;
  const href = buildHref({ column, direction: nextDirection });

  const Icon = isActive
    ? sort.direction === "asc"
      ? ArrowUpIcon
      : ArrowDownIcon
    : ArrowUpDownIcon;

  return (
    <TableHead
      aria-sort={isActive ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
      // whitespace-nowrap: the label and the sort icon share one
      // `inline-flex` row (below) — a two-word label ("Cost to date",
      // "Requested at") wrapping would drop the icon onto its own line
      // instead of sitting beside the last word, which is a worse
      // regression than a column staying a little wide.
      className={cn("whitespace-nowrap", align === "right" && "text-right", className)}
    >
      <Link
        href={href}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
          align === "right" && "flex-row-reverse",
          isActive && "text-foreground",
        )}
      >
        {label}
        <Icon
          className={cn("size-3.5 shrink-0", isActive ? "opacity-100" : "opacity-40")}
          aria-hidden
        />
      </Link>
    </TableHead>
  );
}
