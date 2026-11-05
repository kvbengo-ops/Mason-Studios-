// The one card shape /bin renders, for both a deleted SCENE and a deleted
// clip VERSION. Built as a single component rather than two near-identical
// ones because the two used to disagree on where Restore/Delete permanently
// lived (a scene row put them on the right, a version row put them
// underneath) and that mismatch was half of why the page read as
// unfinished. page.tsx decides WHAT goes in each slot (a scene's version
// count, a version's lack of one; the two Restore/Delete forms, or a bare
// "Not yours"); this file only decides WHERE — so the two kinds of card can
// no longer drift apart from each other.

import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { BinThumbnail, type BinThumbnail as BinThumbnailValue } from "@/components/bin-thumbnail";

// Declared once, in the client tile that actually renders it, and re-exported
// here because page.tsx builds these values and thinks of them as the card's
// input. Two copies of this union would be two things to keep in step.
export type BinCardThumbnail = BinThumbnailValue;

export interface BinCardProps {
  /** "Scene #3" / "Version v1" — the thumbnail's accessible name. Kept apart
   * from `badge` because the visible chip is deliberately terser than a
   * good alt/aria-label needs to be. */
  itemLabel: string;
  /** "#3" / "v1" / "—" — shown both as the chip under the thumbnail and,
   * when there is no asset, as the numeral drawn inside the placeholder
   * tile itself. */
  badge: string;
  /** "4 versions" — a scene card's own version count riding into the bin
   * with it. A version card has none of its own and omits this entirely
   * (not an empty string), so nothing is rendered in its place. */
  meta?: string;
  promptFirstLine: string;
  deletedAtLabel: string;
  /** Optional countdown label for the 2-week bin retention window. */
  expiresLabel?: string | null;
  /** Optional owner identifier shown to admins reviewing cross-account bin items. */
  ownerLabel?: string | null;
  thumbnail: BinCardThumbnail;
  /** The Restore/Delete permanently pair, or a bare "Not yours" label —
   * always rendered in this same footer slot regardless of which the
   * caller passes, so a scene card and a version card read identically
   * either way. */
  actions: ReactNode;
}

export function BinCard({
  itemLabel,
  badge,
  meta,
  promptFirstLine,
  deletedAtLabel,
  expiresLabel,
  ownerLabel,
  thumbnail,
  actions,
}: BinCardProps): JSX.Element {
  return (
    // min-w-0: a grid item's default min-width is `auto`, which lets an
    // unbroken prompt word push the card wider than its column instead of
    // wrapping — the same fix truncate/line-clamp always need inside a
    // grid or flex row.
    <Card className="flex h-full min-w-0 flex-col gap-3 py-3">
      <CardContent className="flex flex-col gap-2 px-3">
        <div
          className={cn(
            // 9:16 — the same box shape frame-grid and deliver/page.tsx use
            // for this exact family of assets (a reference frame, a poster,
            // a clip), so a thumbnail here looks like it belongs to the
            // same app rather than introducing a second aspect ratio.
            "relative aspect-[9/16] w-full overflow-hidden rounded-md bg-muted",
            thumbnail.kind === "placeholder"
              ? "border border-dashed border-border"
              : "border border-border",
          )}
        >
          <BinThumbnail thumbnail={thumbnail} itemLabel={itemLabel} badge={badge} />
        </div>

        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="font-mono tabular-nums">
            {badge}
          </Badge>
          {meta ? <span className="text-[11px] text-muted-foreground">{meta}</span> : null}
        </div>

        <p className="line-clamp-2 text-sm leading-snug">{promptFirstLine}</p>
        {ownerLabel ? (
          <p className="truncate text-[11px] font-medium text-muted-foreground" title={ownerLabel}>
            By {ownerLabel}
          </p>
        ) : null}
        <p className="text-[11px] text-muted-foreground">
          Deleted {deletedAtLabel}
          {expiresLabel ? ` · ${expiresLabel}` : ""}
        </p>
      </CardContent>

      {/* mt-auto: pins the footer to the bottom of the h-full card no
          matter how many lines the prompt above actually used — same
          reasoning frame-grid's own CardFooter comment gives for its
          Regenerate button. */}
      <CardFooter className="mt-auto flex flex-wrap items-center gap-2 px-3">{actions}</CardFooter>
    </Card>
  );
}
