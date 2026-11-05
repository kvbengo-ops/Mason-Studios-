// What /ugc shows while the server is building it.
//
// This route is a Server Component that does real work per request: the
// account budget snapshot, every scene row and its versions, a signed URL per
// asset, the runs error read. Before this file existed the first load left an
// empty frame with no sign anything was happening.
//
// SCOPE, stated plainly so this is not mistaken for the whole fix: Next shows
// this on a navigation INTO the route. Moving between scenes inside it
// (`?scene=<id>`, the case that happens all day) is answered by
// LinkPendingOverlay on the tile that was clicked, which is per-link and
// leaves the strip on screen — an operator choosing between clips must not
// have the thing they are choosing from replaced by a skeleton.
//
// The shape mirrors page.tsx deliberately: same viewport-minus-top-bar
// non-scrolling shell, same 3:1 split, same strip along the bottom. A
// skeleton whose boxes land somewhere other than the real content makes the
// page appear to jump when it arrives, which reads as slower than nothing.

import type { JSX } from "react";

function Block({ className }: { readonly className?: string }): JSX.Element {
  // A single muted rectangle. No shimmer: `animate-pulse` on a dozen boxes at
  // once is motion the operator has to look past, and this screen is already
  // showing a spinner on the control they pressed.
  return <div className={`rounded-md bg-muted ${className ?? ""}`} />;
}

export default function Loading(): JSX.Element {
  return (
    <div
      className="flex h-[calc(100svh-4rem)] flex-col gap-4 overflow-hidden p-6"
      // The sentence a screen reader gets. The boxes below are decoration and
      // are hidden from it entirely — announcing nine empty rectangles tells
      // nobody anything.
      role="status"
      aria-live="polite"
      aria-label="Loading this project"
    >
      <Block className="h-7 w-56" />

      <div aria-hidden="true" className="flex min-h-0 flex-1 gap-4">
        {/* The prompt column and the result panel, at the 3:1 split the real
            page uses. */}
        <div className="flex min-h-0 w-full max-w-md flex-1 flex-col gap-3">
          <Block className="h-9 w-full" />
          <Block className="min-h-0 flex-1" />
          <Block className="h-14 w-full" />
          <Block className="h-10 w-full" />
        </div>
        <Block className="min-h-0 flex-1" />
      </div>

      {/* The scene strip. Four tiles at the real tile width, so the row lands
          at the height it will actually occupy. */}
      <div aria-hidden="true" className="flex shrink-0 gap-2 overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex w-[176px] shrink-0 flex-col gap-1 rounded-md border p-1.5">
            <Block className="h-24 w-full" />
            <Block className="h-3 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
