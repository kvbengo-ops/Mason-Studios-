import type { JSX, ReactNode } from "react";

/**
 * A mock switch that's easy to flip on in production is easy to forget —
 * and the failure it invites is quiet and expensive in the wrong direction:
 * an operator hands a client a delivered "ad" built from a canned fixture,
 * believing it's real. Every page whose content a given mock switch fakes
 * must say so, specifically — which flag, not just "mock mode" — so this
 * takes the sentence as `children` rather than rendering a generic message
 * itself. Styled after the "not every scene has finished rendering" notice
 * on deliver/page.tsx — this codebase's existing pattern for "read this
 * before you trust what's below it."
 */
export function MockModeBanner({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p
      role="status"
      className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
    >
      {children}
    </p>
  );
}
