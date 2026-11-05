import type { JSX } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * The Character Library entry point on the Character page. Clicking it opens
 * the CharacterLibraryDialog modal — via a real `<Link>` to a `library=1`
 * URL, not a button flipping local state, for the same reason the modal's
 * own open state lives in the URL (see CharacterLibraryDialog's doc
 * comment): this row has to survive being rendered from a Server Component
 * (character/page.tsx), and a function prop can't cross that boundary
 * anyway.
 *
 * Shaped as a button rather than a full-width bordered row because of where
 * it now sits: in the same row as "Rewrite my words", which is where the
 * design puts it. The two are the two answers to "this description isn't
 * good enough" — write a better one, or take one that already works — and
 * they have to be equally reachable. It was previously folded inside a
 * collapsed "Change character" disclosure, one click further away and
 * invisible until opened.
 */
export function CharacterLibraryTrigger({
  href,
  count,
  inUseName,
}: {
  href: string;
  count: number;
  /** The library character currently in use on this project, if any — shown so the operator doesn't have to open the modal just to see what's already picked. */
  inUseName: string | null;
}): JSX.Element {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href}>
        <span aria-hidden>↓</span>
        <span>Character Library</span>
        <span className="font-normal text-muted-foreground">
          {count} saved
          {inUseName ? ` · ${inUseName}` : ""}
        </span>
      </Link>
    </Button>
  );
}
