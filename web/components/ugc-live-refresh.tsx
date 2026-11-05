"use client";

// Keeps the /ugc console honest while a clip is rendering.
//
// This page is server-rendered and had nothing that re-fetched it. Pressing
// Generate revalidates once — so the new scene appears as `queued` — and then
// the screen stops. The render finishes 45-90s later (locally, through the
// reconcile poll; longer in production), and nothing tells the page. The
// operator watches a tile that says "queued" until they think to refresh.
//
// Deliberately a poll and not Realtime, which is the other half of what the
// scripted pipeline does. render-progress.tsx runs a Realtime subscription
// with a poll BEHIND it, and its own header explains why the poll is not
// optional: a carrier can drop the socket silently and the channel never
// recovers. That component is watching thirty scenes at once and the
// subscription earns its complexity there. Here there are rarely more than
// two clips in flight, and the poll alone is the part that was load-bearing
// anyway.
//
// It runs ONLY while something is actually in flight. A console showing
// nothing but finished clips makes no requests at all — this is a route an
// operator leaves open between sessions, and a permanent 10s heartbeat
// against Supabase for a page nobody is waiting on is a cost with no reader.

import { useEffect, type JSX } from "react";
import { useRouter } from "next/navigation";

/** Matches render-progress.tsx's POLL_INTERVAL_MS — same job, same cadence. */
const POLL_INTERVAL_MS = 10000;

export function UgcLiveRefresh({ inFlight }: { inFlight: boolean }): JSX.Element | null {
  const router = useRouter();

  useEffect(() => {
    if (!inFlight) return;

    // router.refresh() re-runs the Server Component and reconciles the result
    // into the existing tree, so the video element, the scroll position and
    // anything typed into the prompt box survive. A location.reload() would
    // take the operator's unsaved prompt with it, which on this screen is the
    // one thing they cannot get back.
    const interval = setInterval(() => {
      router.refresh();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [inFlight, router]);

  return null;
}
