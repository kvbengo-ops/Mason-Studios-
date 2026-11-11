"use client";

import { useRouter } from "next/navigation";
import { useVisibleInterval } from "@/lib/use-visible-interval";

/**
 * Accounts Control and Users re-read every 60s while the tab is visible. Each
 * refresh re-runs every spend read on the page; 30s doubled that load for
 * figures that move on the worker's 30s cadence anyway.
 */
const REFRESH_MS = 60_000;

export function AccountsControlLiveRefresh(): null {
  const router = useRouter();
  useVisibleInterval(() => router.refresh(), REFRESH_MS, true);
  return null;
}
