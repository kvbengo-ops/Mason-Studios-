import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ProjectStatus } from "@/types/db";

// Exported for reuse by the /projects list's status filter
// (components/project-filters.tsx) — same label an operator already reads
// off every row's status pill, so the filter's options read as "the exact
// values this column can show," not a second, differently-worded list.
export const STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: "Draft",
  briefed: "Briefed",
  framed: "Framed",
  rendering: "Rendering",
  complete: "Complete",
  delivered: "Delivered",
};

// One dedicated fill+ink pair per status (config/themes/studio-light.css's
// `--status-*` tokens), NOT the chart-N tokens this used to read. Those are
// a dead end for pill contrast on purpose: chart-N is a single hue used as
// BOTH the fill (at low alpha) and the text colour, and a same-hue pairing
// caps out well under 4.5:1 no matter how the alpha is tuned — checked the
// actual numbers (chart-1 in the light theme, this pill's old "rendering"
// colour, was ~4.0:1 at 10% fill and got WORSE at 20%/25%, not better). The
// `--status-*` tokens sidestep that by decoupling ink from fill entirely: a
// light, saturated fill (sampled off a reference dashboard for rendering/
// complete/delivered, matched in register for briefed/framed) paired with a
// dark, near-neutral ink, inverted to a dark-fill/light-ink pair in
// studio-dark.css. See studio-light.css/studio-dark.css's headers for the full measured
// contrast table — every pair clears 4.5:1 in both themes, most by a wide
// margin (7-14:1).
//
// `draft` deliberately does NOT get one of these pairs — "nothing has
// happened yet" reads better as the theme's plain neutral (bg-muted/
// muted-foreground, an existing matched pair) than as a manufactured pastel,
// and it keeps `draft` visually quietest among the six, which is the point.
//
// `delivered` moves off the old solid `bg-primary` fill (this task's whole
// premise is that gold/yellow belongs to the primary BUTTON, not scattered
// across a table of status pills) onto the peach `--status-delivered` pair
// instead — same register as every other pill now, so it no longer visually
// competes with the "New project" button for "the one bright thing on the
// page". Terminal-state emphasis is preserved a different way: `font-
// semibold` (every other status pill is font-medium, Badge's default) is
// the one visual property still exclusive to `delivered`, so it still reads
// as the heaviest/most-finished label in the status column even though it
// no longer stands alone in colour weight.
const STATUS_CLASS: Record<ProjectStatus, string> = {
  draft: "border-border bg-muted text-muted-foreground",
  briefed: "border-transparent bg-status-briefed text-status-briefed-foreground",
  framed: "border-transparent bg-status-framed text-status-framed-foreground",
  rendering: "border-transparent bg-status-rendering text-status-rendering-foreground",
  complete: "border-transparent bg-status-complete text-status-complete-foreground",
  delivered:
    "border-transparent bg-status-delivered text-status-delivered-foreground font-semibold",
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }): JSX.Element {
  return (
    // px-2.5/py-1, up from Badge's own default px-2/py-0.5 (twMerge in cn()
    // resolves the conflict, keeping this one) — the size increase "proper
    // pill, more presence" asked for that doesn't touch colour/contrast at
    // all. Badge is already rounded-full and font-medium by default, so
    // neither "pill-shaped" nor "medium weight" needed a change here.
    <Badge variant="outline" className={cn("px-2.5 py-1", STATUS_CLASS[status])}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}
