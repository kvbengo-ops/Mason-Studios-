import type { JSX } from "react";

/**
 * The instant half of every navigation inside a project.
 *
 * Without a loading boundary the App Router has nothing to show while a
 * route's server component runs, so it holds the OLD page on screen,
 * frozen and unannotated, until the new one is ready. Every click read as
 * "nothing happened, then everything happened" — which is what "the app is
 * slow" meant here. The server was answering in ~140ms; there was simply no
 * point at which the UI admitted a navigation had started.
 *
 * This file is the fix, and it is also what makes <Link> prefetching worth
 * anything on these routes: a cookie-authenticated route is rendered
 * dynamically, so Next can only prefetch as far as the nearest loading
 * boundary. With no boundary there was nothing to prefetch to.
 *
 * It replaces the CONTENT column only. The rail lives in layout.tsx, above
 * this boundary, so it keeps its scroll position and its highlight across
 * the navigation instead of flashing — which is the whole reason the rail
 * was moved into the layout rather than rendered per page.
 *
 * Deliberately generic rather than a per-route replica. Five routes with
 * five hand-tuned skeletons is five more things to keep in sync with pages
 * that are still moving; a calm block that matches the page's rhythm reads
 * as "loading" without pretending to predict the layout.
 */
export default function Loading(): JSX.Element {
  return (
    <div className="p-6" aria-busy="true" aria-live="polite">
      {/* The only text here. A skeleton alone leaves a screen reader with
          nothing to announce — aria-busy marks the region, this names it. */}
      <span className="sr-only">Loading</span>

      <div className="motion-safe:animate-pulse space-y-6">
        <div className="space-y-2">
          <div className="h-3 w-24 rounded bg-muted" />
          <div className="h-7 w-64 max-w-full rounded bg-muted" />
          <div className="h-4 w-48 max-w-full rounded bg-muted" />
        </div>

        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="h-4 w-32 rounded bg-muted" />
          <div className="h-24 w-full rounded bg-muted" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-lg border border-border p-4 space-y-3">
              <div className="h-4 w-24 rounded bg-muted" />
              <div className="aspect-[9/16] max-h-52 w-full rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
