"use client";

import Link from "next/link";
import { Pause, Play } from "lucide-react";
import { useState } from "react";
import type { JSX } from "react";

const ANNOUNCEMENT = "Seedream 5.5 is now available";

export function CreateAnnouncementTicker(): JSX.Element {
  const [paused, setPaused] = useState(false);

  return (
    <aside
      aria-label="Announcement"
      data-paused={paused}
      className="seedream-ticker relative flex h-10 shrink-0 items-center overflow-hidden border-b border-white/10 px-2 text-white sm:h-11 sm:px-4"
    >
      <span className="sr-only">{ANNOUNCEMENT}</span>
      <div className="seedream-ticker-window min-w-0 flex-1 overflow-hidden pr-2">
        <p className="seedream-ticker-static truncate pr-20 text-center text-xs font-medium sm:text-sm">
          {ANNOUNCEMENT}
        </p>
        <div className="seedream-ticker-track" aria-hidden="true">
          {[0, 1].map((group) => (
            <div key={group} className="seedream-ticker-group">
              {[0, 1, 2, 3].map((repeat) => (
                <span key={repeat} className="seedream-ticker-item">
                  {ANNOUNCEMENT}
                  <span className="seedream-ticker-separator">•</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="absolute right-2 z-10 flex items-center gap-1 sm:right-4 sm:gap-2">
        <button
          type="button"
          aria-label={paused ? "Resume announcement motion" : "Pause announcement motion"}
          aria-pressed={paused}
          title={paused ? "Resume motion" : "Pause motion"}
          onClick={() => setPaused((current) => !current)}
          className="seedream-ticker-pause inline-flex size-8 items-center justify-center rounded-md text-white/75 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-violet-300"
        >
          {paused ? <Play aria-hidden="true" className="size-3.5" /> : <Pause aria-hidden="true" className="size-3.5" />}
        </button>
        <Link
          href="/image-generator"
          className="inline-flex h-7 items-center rounded-md bg-violet-500 px-3 text-xs font-semibold text-white shadow-sm outline-none transition-colors hover:bg-violet-400 focus-visible:ring-2 focus-visible:ring-violet-200 focus-visible:ring-offset-2 focus-visible:ring-offset-[#17151e] sm:h-8 sm:px-3.5 sm:text-sm"
        >
          Try it
        </Link>
      </div>
    </aside>
  );
}
