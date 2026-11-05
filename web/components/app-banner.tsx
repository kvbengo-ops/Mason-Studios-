"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import type { JSX } from "react";
import { ArrowRight, Sparkles, X } from "lucide-react";
import type { AppBannerConfig } from "@/lib/app-banner";

const DISMISSED_PREFIX = "app-banner:dismissed:";
const dismissedInSession = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function isDismissed(id: string): boolean {
  if (dismissedInSession.has(id)) return true;
  try {
    return window.localStorage.getItem(`${DISMISSED_PREFIX}${id}`) === "1";
  } catch {
    return false;
  }
}

function dismissBanner(id: string): void {
  dismissedInSession.add(id);
  try {
    window.localStorage.setItem(`${DISMISSED_PREFIX}${id}`, "1");
  } catch {
    // The in-memory dismissal still covers this browser session.
  }
  for (const listener of listeners) listener();
}

export function AppBanner({ config }: { config: AppBannerConfig }): JSX.Element | null {
  // The server snapshot starts hidden, avoiding a hydration mismatch and a
  // flash of a campaign this browser already dismissed. React reads the
  // localStorage-backed client snapshot immediately after hydration.
  const dismissed = useSyncExternalStore(
    subscribe,
    () => isDismissed(config.id),
    () => true,
  );

  if (dismissed) return null;

  return (
    <aside
      role="status"
      aria-label={config.text}
      className="relative isolate flex min-h-12 shrink-0 items-center overflow-hidden bg-gradient-to-r from-violet-700 via-fuchsia-600 to-orange-500 px-3 py-2 text-white shadow-[0_8px_28px_-18px_rgba(217,70,239,0.95)] sm:px-6"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -left-16 top-1/2 size-36 -translate-y-1/2 rounded-full bg-white/20 blur-3xl"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 w-1/3 -translate-x-[140%] skew-x-[-20deg] bg-gradient-to-r from-transparent via-white/35 to-transparent motion-safe:animate-[app-banner-shine_900ms_ease-out_1] motion-reduce:hidden"
      />

      <div className="relative mx-auto flex min-w-0 flex-1 flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-sm sm:flex-nowrap">
        <span className="inline-flex min-w-0 items-center gap-2 font-semibold">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/20 ring-1 ring-white/30 backdrop-blur-sm">
            <Sparkles aria-hidden="true" className="size-3.5" />
          </span>
          <span>{config.text}</span>
        </span>

        <Link
          href={config.href}
          className="group inline-flex shrink-0 items-center gap-1 rounded-full bg-white px-3 py-1 text-xs font-bold text-fuchsia-700 shadow-sm outline-none transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-fuchsia-600 motion-reduce:transition-none"
        >
          {config.cta}
          <ArrowRight
            aria-hidden="true"
            className="size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
          />
        </Link>
      </div>

      <button
        type="button"
        onClick={() => dismissBanner(config.id)}
        aria-label="Dismiss announcement"
        className="relative ml-2 inline-flex size-8 shrink-0 items-center justify-center rounded-full text-white/80 outline-none transition-[background-color,color,transform] hover:bg-white/15 hover:text-white active:scale-90 focus-visible:ring-2 focus-visible:ring-white motion-reduce:transition-none"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </aside>
  );
}
