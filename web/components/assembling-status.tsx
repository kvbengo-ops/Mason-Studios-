"use client";

// Placeholder for the Deliver page's final-video slot (docs/architecture.md
// § "User flow" step 9) while the Go worker's assemble loop
// (worker/internal/loop/assemble.go) is still ffmpeg-concatenating this
// project's clips into a `final` asset. render-progress.tsx can watch
// `scenes` land via Supabase Realtime; `assets` is not in the
// supabase_realtime publication (only `scenes` is — see
// supabase/migrations/0006_realtime.sql), so there's no push channel to
// subscribe to here. Instead this polls hasFinalAsset a bounded number of
// times and then stops — a disabled/stalled feature polling the DB every
// few seconds forever is just noise, same reasoning as Assemble's own
// early-return when ASSEMBLE_ENABLED is off.

import { useEffect, useState } from "react";
import { Spinner } from "@/components/spinner";
import type { JSX } from "react";
import { useRouter } from "next/navigation";
import { hasFinalAsset } from "@/actions/deliver";

const POLL_INTERVAL_MS = 6000;
// 20 attempts * 6s = 2 minutes, matching the "a minute or two" the worker's
// ffmpeg concat typically takes. Past this, stop hammering the DB and tell
// the operator to check back rather than polling silently forever.
const MAX_ATTEMPTS = 20;

export function AssemblingStatus({ projectId }: { projectId: string }): JSX.Element {
  const router = useRouter();
  const [attempts, setAttempts] = useState(0);
  // Derived, not its own state: bumping `attempts` past MAX_ATTEMPTS is
  // enough to stop the effect below from scheduling another poll, so there
  // is no separate "give up" transition to setState for.
  const gaveUp = attempts >= MAX_ATTEMPTS;

  useEffect(() => {
    if (gaveUp) return;

    const timer = setTimeout(() => {
      void hasFinalAsset(projectId).then((found) => {
        if (found) {
          // Re-run the Deliver page's server component. It re-reads
          // `assets`, finds the `final` row, and renders the real
          // "Assembled video" card in this slot — no client-side
          // video-fetching/signed-URL logic needed here.
          router.refresh();
        } else {
          setAttempts((n) => n + 1);
        }
      });
    }, POLL_INTERVAL_MS);

    return (): void => clearTimeout(timer);
  }, [projectId, attempts, gaveUp, router]);

  // The spinner is shown only while this component is still polling. Once it
  // has given up it is not waiting on anything any more, and a spinner over
  // "refresh in a bit" would claim progress nobody is making — the same
  // reason status-icon.tsx reserves its animated LoaderCircle for work
  // actually in flight.
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      {gaveUp ? null : <Spinner />}
      {gaveUp
        ? "Still assembling the full video — refresh this page in a bit to check again."
        : "Assembling the full video from the finished clips — this takes a minute or two."}
    </p>
  );
}
