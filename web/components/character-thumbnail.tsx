import type { JSX } from "react";
import { ImageOffIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One character library grid cell's image — either the signed thumbnail, or
 * (when signCharacterThumbnails, lib/character-thumbnails.ts, couldn't sign
 * this row's storage_key) a placeholder that says so instead of leaving a
 * broken `<img>` or, worse, taking the whole grid down. Shared by /library
 * and every project's Character-step picker (character/page.tsx) — the two
 * surfaces that render this table as a grid — so the two can't quietly grow
 * two different placeholder treatments for the same failure.
 *
 * Deliberately just the image cell: the corner RemoveReferenceButton
 * overlay, the name/rename row, the description, and the pick/in-use
 * controls all differ enough between the two grids (library owns
 * rename/remove/edit-description; the picker owns pick/in-use) that folding
 * them into this component would mean threading half a dozen per-surface
 * props through it for no real sharing — each grid keeps composing those
 * itself around this cell.
 */
export function CharacterThumbnail({
  url,
  alt,
  className,
}: {
  /**
   * A signed URL, or `null`/`undefined` for a row whose storage object
   * couldn't be signed — `undefined` covers an out-of-range array index
   * under `noUncheckedIndexedAccess`, not a real third state; both render
   * the same placeholder.
   */
  url: string | null | undefined;
  alt: string;
  /** Extra classes layered onto the shared base — e.g. library's own border, which the picker's already-bordered card doesn't need. */
  className?: string;
}): JSX.Element {
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- signed URL, not a static import
      <img
        src={url}
        alt={alt}
        loading="lazy"
        decoding="async"
        className={cn("aspect-square w-full rounded-md object-cover", className)}
      />
    );
  }

  return (
    <div
      role="img"
      aria-label={`${alt}: image unavailable`}
      className={cn(
        "flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-muted text-muted-foreground",
        className,
      )}
    >
      <ImageOffIcon className="size-6" aria-hidden />
      <span className="text-[10px] font-medium uppercase tracking-wide">Image unavailable</span>
    </div>
  );
}
