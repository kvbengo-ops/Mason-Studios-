"use client";

import { useEffect, useRef } from "react";

/**
 * setInterval that skips ticks while the tab is hidden, and runs once on coming
 * back so the page catches up. Every router.refresh() poll re-runs a whole page's
 * DB reads and signed URLs; a background tab doing that every few seconds is
 * load nobody sees (it pinned the Nano database, 2026-11-10).
 */
export function useVisibleInterval(callback: () => void, ms: number, enabled: boolean): void {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  });

  useEffect(() => {
    if (!enabled) return;
    // Only an explicitly hidden tab skips; "prerender" and friends still tick.
    const visible = (): boolean => document.visibilityState !== "hidden";
    const timer = setInterval(() => {
      if (visible()) latest.current();
    }, ms);
    const onVisible = (): void => {
      if (visible()) latest.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms, enabled]);
}
