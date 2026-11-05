import type { JSX } from "react";
import Link from "next/link";

// Shared with all three split Setup pages (Character/Product/Script) —
// previously one copy of this pair of banners lived once on the single
// character/page.tsx; splitting the page without factoring this out would
// have meant three copies of the same two paragraphs quietly drifting apart.

export function SetupLockBanner({
  projectId,
  locked,
  hasCommittedScenes,
}: {
  projectId: string;
  /** project.status === "delivered" — the real write refusal. */
  locked: boolean;
  /** At least one scene has left draft/frame_ready — see character/page.tsx's original comment on this flag for the full reasoning; unchanged here. */
  hasCommittedScenes: boolean;
}): JSX.Element | null {
  if (locked) {
    return (
      <p className="rounded-md border border-border bg-muted/40 p-4 text-sm text-foreground">
        This project has already been delivered, so this step is read-only. Use{" "}
        <Link href={`/projects/${projectId}/deliver`} className="font-medium underline">
          Reopen
        </Link>{" "}
        on the Deliver page to make changes again.
      </p>
    );
  }
  if (hasCommittedScenes) {
    return (
      <p className="rounded-md border border-border bg-muted/40 p-4 text-sm text-foreground">
        This project has scenes that have already rendered (or are queued/rendering now). Editing
        anything below won&apos;t change those clips — they&apos;ll need to be re-rendered from the
        Brief or Render page for the change to show up.
      </p>
    );
  }
  return null;
}
