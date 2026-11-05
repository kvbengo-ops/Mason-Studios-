import * as React from "react";
import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">): React.JSX.Element {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">): React.JSX.Element {
  return (
    <thead
      data-slot="table-header"
      className={cn(
        // Sticky, not static: every long list this primitive backs
        // (/projects, /users, /allowances, the scene brief table) scrolls
        // inside <main> (app/(app)/layout.tsx's own md:overflow-y-auto
        // container), and losing the column labels the moment row 1
        // scrolls past the top is what actually made those tables hard to
        // read at any real row count — a mouse-over tooltip is not a
        // substitute for seeing "Cost to date" while looking at row 40.
        // `top-0` sticks against <main> (the nearest ancestor with its own
        // scrollbar), not the viewport, so this never fights the sidebar or
        // the mobile header bar for a stacking position.
        //
        // bg-background, not transparent: a `sticky` element with no fill
        // lets every row scrolled underneath it show straight through,
        // which reads as broken, not "sticky" — this is the opaque backing
        // the sticky positioning above needs to actually work. bg-background
        // (not bg-card) because every long, actually-scrolling table this
        // backs (/projects, /users, /allowances, the scene table) sits
        // directly on the page background, not inside a Card — the shorter,
        // bounded tables that DO live in a Card (profile's grants history,
        // /spend's per-user and top-ups tables) never grow tall enough to
        // scroll past their own header in the first place, so there is
        // nothing on screen for their header to stick against or mismatch.
        "sticky top-0 z-10 bg-background [&_tr]:border-b",
        className,
      )}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">): React.JSX.Element {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">): React.JSX.Element {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("bg-muted/50 border-t font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">): React.JSX.Element {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors",
        className,
      )}
      {...props}
    />
  );
}

// `numeric` — the one place the money/count convention is defined, instead
// of every consumer hand-writing `className="text-right tabular-nums"` (or,
// worse, some columns doing it and others forgetting to). `text-right`
// alone isn't enough: proportional digits (the default for most of this
// app's font) have per-digit widths, so two right-aligned amounts of the
// same number of digits still don't line up column-to-column — `tabular-
// nums` is what actually makes the ones place sit under the ones place.
// Bundled into one prop, rather than a documented className pairing,
// because a caller reaching for one half without the other (right-aligned
// but proportional, or tabular but left-aligned) produces a subtly wrong
// table that still looks plausible at a glance. `whitespace-nowrap` rides
// along too: now that wrapping is the column default (see TableHead/
// TableCell below), a dollar amount or a count is exactly the "genuinely
// needs it" case the task carves out — "$1,234.56" breaking across two
// lines mid-figure is never an improvement the way a wrapped product name
// can be, so a numeric column opts out of wrapping unconditionally rather
// than making every consumer remember to ask for both.
interface NumericProps {
  numeric?: boolean;
}

function TableHead({
  className,
  numeric,
  ...props
}: React.ComponentProps<"th"> & NumericProps): React.JSX.Element {
  return (
    <th
      data-slot="table-head"
      className={cn(
        // No default whitespace-nowrap: forcing every cell onto one line
        // was what pushed /projects' "Cost to date" column — the whole
        // point of a spend-capped team's project list — off-screen behind
        // the table's own overflow-x-auto wrapper. Wrapping is now the
        // default and `whitespace-nowrap` is opt-in per column, added back
        // explicitly wherever a two-line value (a date, a price, a status
        // pill, a short id) would look broken rather than just wide.
        //
        // h-11/px-3, not the old h-10/px-2: the previous density read as a
        // spreadsheet import, not a product surface — every one of the nine
        // tables this primitive backs packed columns edge-to-edge with barely
        // more headroom than the text itself needed. h-11 is chosen to
        // roughly match the taller px-3/py-3 body row below (TableCell), so
        // the header and body rows read as one consistent band instead of
        // the header looking noticeably thinner than the rows under it.
        "text-foreground h-11 px-3 text-left align-middle font-medium [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        numeric && "text-right tabular-nums whitespace-nowrap",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({
  className,
  numeric,
  ...props
}: React.ComponentProps<"td"> & NumericProps): React.JSX.Element {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        // See TableHead's comment above: wrapping is now the default here
        // too, for the same "Cost to date" reason — a cell can't opt out of
        // wrapping at the primitive level while its header forces the
        // column onto one line and vice versa.
        //
        // px-3/py-3, not the old flat p-2: an airier row is the whole point
        // of this pass — p-2 (8px all round) left almost no breathing room
        // between a row's text and its neighbours above/below, which is what
        // made every list here (projects, users, allowances, the scene
        // brief) read as a dense default table instead of a designed one.
        // Checked against scene-table.tsx specifically, the one consumer
        // whose cells hold Textareas/Selects/Buttons rather than plain text:
        // those controls carry their own fixed min-height (Textarea's
        // min-h-16/min-h-24) and every scene-table cell is already
        // `align-top`, so the extra padding this adds (4px -> 12px top,
        // matching bottom) is a small fixed margin around an already-tall
        // control, not a multiplier on it — those rows did not become
        // unreasonably tall.
        "p-3 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        numeric && "text-right tabular-nums whitespace-nowrap",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">): React.JSX.Element {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-muted-foreground mt-4 text-sm", className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
