import type { JSX } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

// Root 404. Without this file Next.js serves its own built-in page, which
// is unstyled black-on-white and carries none of this app's theme — on a
// mistyped URL that reads as "the site is broken" rather than "that page
// isn't here". Nothing about the default page is wrong; it just belongs to
// a different product.
//
// Deliberately NOT inside (app): this file catches unmatched routes at the
// root, where the visitor may well not be signed in, so it must not depend
// on (app)/layout.tsx's session or render its sidebar chrome. The
// authenticated case is handled separately by (app)/not-found.tsx, which
// keeps the shell so a signed-in operator doesn't get thrown out of the
// app for a bad project id.
export default function NotFound(): JSX.Element {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <div className="flex flex-col gap-2">
        {/* The number is the smallest, quietest element on purpose: "404"
            names the failure for anyone who already knows what it means and
            is noise to everyone else, so the sentence below it does the
            actual explaining. */}
        <p className="text-sm font-medium tracking-widest text-muted-foreground">404</p>
        <h1 className="text-2xl font-medium text-foreground">This page doesn&apos;t exist</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The link may be out of date, or the address may have a typo in it.
        </p>
      </div>

      {/* Home, not "go back": the browser's own back button already covers
          going back, and a visitor who arrived here from a stale link has
          nowhere useful behind them. */}
      <Button asChild>
        <Link href="/">Go home</Link>
      </Button>
    </main>
  );
}
