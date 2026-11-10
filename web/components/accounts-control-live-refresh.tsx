"use client";

import { useRouter } from "next/navigation";
import { useVisibleInterval } from "@/lib/use-visible-interval";

/** Accounts Control is a live spend view: re-read it every 30s while the tab is visible. */
const REFRESH_MS = 30_000;

export function AccountsControlLiveRefresh(): null {
  const router = useRouter();
  useVisibleInterval(() => router.refresh(), REFRESH_MS, true);
  return null;
}
