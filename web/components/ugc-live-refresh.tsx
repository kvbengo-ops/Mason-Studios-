"use client";

// Keeps the /ugc console honest while a clip is rendering.
//
// This page is server-rendered and had nothing that re-fetched it. Pressing
// Generate revalidates once — so the new scene appears as `queued` — and then
// the screen stops. The render finishes 45-90s later (locally, through the
// reconcile poll; longer in production), and nothing tells the page. The
// operator watches a tile that says "queued" until they think to refresh.
//
// Realtime tells the page when one of its scenes changes, and a slow poll
// stands behind it. This used to be a 15s poll alone, and every tick re-ran
// the whole page's reads for every operator with a clip in flight. The poll
// stays, at 60s, for the reason render-progress.tsx's header gives: a carrier
// can drop the socket silently and the channel never recovers.
//
// It runs ONLY while something is actually in flight. A console showing
// nothing but finished clips makes no requests at all — this is a route an
// operator leaves open between sessions, and a permanent heartbeat against
// Supabase for a page nobody is waiting on is a cost with no reader.

import { type JSX, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useVisibleInterval } from "@/lib/use-visible-interval";

// Only reached when the socket is dead; a live one refreshes on the change.
const FALLBACK_POLL_MS = 60_000;
// Realtime rejects an `in` filter with more than 100 values.
const MAX_FILTER_IDS = 100;

/** `projectIds`: the projects that have a queued or rendering scene. Empty means nothing is in flight. */
export function UgcLiveRefresh({ projectIds }: { projectIds: string[] }): JSX.Element | null {
  const router = useRouter();
  // A string, so the effect below re-runs only when the set itself changes.
  const filterIds = projectIds.slice(0, MAX_FILTER_IDS).join(",");

  useEffect(() => {
    if (!filterIds) return;
    const supabase = createClient();
    const channel = supabase.channel(`ugc-scenes:${filterIds}`).on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "scenes",
        filter: `project_id=in.(${filterIds})`,
      },
      (): void => {
        // A hidden tab catches up on return, through the poll below.
        if (document.visibilityState !== "hidden") router.refresh();
      },
    );
    // Join only once the session token is loaded: an earlier join runs as
    // `anon`, which cannot read this table, and Realtime rejects the filter.
    let cancelled = false;
    const join = (): void => {
      if (!cancelled) channel.subscribe();
    };
    void supabase.realtime.setAuth().then(join, join);

    return (): void => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [filterIds, router]);

  // router.refresh() re-runs the Server Component and reconciles the result
  // into the existing tree, so the video element, the scroll position and
  // anything typed into the prompt box survive. A location.reload() would
  // take the operator's unsaved prompt with it, which on this screen is the
  // one thing they cannot get back.
  useVisibleInterval(() => router.refresh(), FALLBACK_POLL_MS, filterIds !== "");

  return null;
}
