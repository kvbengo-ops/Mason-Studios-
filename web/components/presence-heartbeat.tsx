"use client";

import { useEffect } from "react";
import { touchPresence } from "@/actions/presence";
import { PRESENCE_INTERVAL_MS } from "@/lib/presence";

/** Renders nothing. Pings touchPresence on mount and every 60s while the tab is visible. */
export function PresenceHeartbeat(): null {
  useEffect(() => {
    const ping = (): void => {
      if (document.visibilityState === "visible") void touchPresence().catch(() => {});
    };
    ping();
    const timer = setInterval(ping, PRESENCE_INTERVAL_MS);
    document.addEventListener("visibilitychange", ping);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", ping);
    };
  }, []);
  return null;
}
