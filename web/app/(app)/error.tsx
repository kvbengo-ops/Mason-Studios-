"use client";

import type { JSX } from "react";
import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

// The authenticated error boundary. Separate from app/error.tsx on purpose,
// same split as (app)/not-found.tsx vs app/not-found.tsx: this one is
// reached from a throw inside a page.tsx (or nested layout) *under*
// (app)/layout.tsx — the shell itself has already rendered successfully by
// the time this boundary can fire, so Next mounts this in place of just the
// failing page's slot, and the sidebar, budget readout, and nav stay put.
// An operator who hits a genuine bug on e.g. the render page is not thrown
// out of the app; they see the error inside the shell they were already in.
//
// (A throw from (app)/layout.tsx itself — requireUser() failing, most
// notably — does NOT land here; a layout's own error boundary can't catch
// its own layout's errors, so that case falls through to the root
// app/error.tsx instead. See that file's header.)
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): JSX.Element {
  useEffect(() => {
    // Same reasoning as app/error.tsx: error.message is already redacted by
    // React in production for Server Component/Action errors, so this logs
    // whatever actually reaches the client (opaque #441 text plus digest)
    // for correlation against server logs, not a leaked internal message.
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-6 px-6 py-24 text-center">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium tracking-widest text-muted-foreground">ERROR</p>
        <h1 className="text-2xl font-medium text-foreground">Something went wrong</h1>
        {/* Never error.message — see app/error.tsx's identical note. */}
        <p className="max-w-md text-sm text-muted-foreground">
          An unexpected error occurred loading this page. Try again, or head back to your projects.
        </p>
        {error.digest && (
          <p className="font-mono text-xs text-muted-foreground">Ref: {error.digest}</p>
        )}
      </div>

      <div className="flex gap-3">
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
        <Button asChild>
          <Link href="/projects">Back to projects</Link>
        </Button>
      </div>
    </div>
  );
}
