"use client";

// Re-renders the server tree when the tab comes back into view, so the
// sidebar budget picks up a grant/allowance an admin made elsewhere. The
// (app) layout never re-renders on soft navigation, and an admin's
// revalidatePath only refreshes the admin's own browser.
//
// ponytail: focus-only, throttled. An editor staring at one tab won't see a
// top-up until they look away and back; add an interval if that matters.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const MIN_INTERVAL_MS = 30_000;

export function RefreshOnFocus(): null {
  const router = useRouter();

  useEffect(() => {
    let last = Date.now();
    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < MIN_INTERVAL_MS) return;
      last = now;
      router.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [router]);

  return null;
}
