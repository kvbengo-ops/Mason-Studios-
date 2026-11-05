"use client";

import type { JSX } from "react";
import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

// Root error boundary. Mirrors app/not-found.tsx's reasoning exactly: this
// is the fallback for anything that throws above (or outside) the
// authenticated shell — most importantly (app)/layout.tsx itself, since an
// error boundary never catches an error thrown by the layout it sits
// alongside (Next renders error.tsx as a *sibling* replacement for the
// segment's children, not a wrapper around that segment's own layout). If
// requireUser() throws inside (app)/layout.tsx, (app)/error.tsx below never
// sees it — this file does. So, like the root not-found page, it must not
// assume a session exists or render the sidebar shell.
//
// Client Component: error.tsx always is, and it's how `reset` (retry
// without a full navigation) gets to the page at all.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): JSX.Element {
  useEffect(() => {
    // Server Component / Server Action errors are already redacted to
    // "Minified React error #441…" by React itself in production before
    // they even reach here (see lib/action-result.ts's header) — logging
    // client-side just gets that same opaque string plus the digest, which
    // is enough to correlate against server logs without printing anything
    // an attacker could use. Never render error.message to the operator;
    // see the JSX below.
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium tracking-widest text-muted-foreground">ERROR</p>
        <h1 className="text-2xl font-medium text-foreground">Something went wrong</h1>
        {/* No error.message here — see the redaction note above and
            action-result.ts's header for why a raw thrown message must
            never reach the client in production. The digest is safe: it's
            a correlation id, not a description, so it's shown when present
            for anyone reporting the issue. */}
        <p className="max-w-md text-sm text-muted-foreground">
          An unexpected error occurred. Try again, or come back in a moment.
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
          <Link href="/">Go home</Link>
        </Button>
      </div>
    </main>
  );
}
