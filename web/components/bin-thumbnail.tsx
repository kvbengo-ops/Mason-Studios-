"use client";

// The picture inside a /bin card, and the only part of that card that needs
// to be a client component.
//
// A signed Storage URL carries a TTL (an hour, matching deliver/page.tsx).
// /bin is a page someone opens to decide whether they still want something
// back, so leaving the tab sitting open past that hour is ordinary use, not
// an edge case. Images are lazy, so a card below the fold does not even
// fetch until it is scrolled to — by which time the token may be dead.
//
// Server-side there is nothing to be done about that: the URL was valid when
// the page rendered. What the failure looks like is decided here. Without an
// onError an expired `<img>` shows the browser's own broken-image glyph, and
// an expired `<video>` is worse — it paints nothing at all, so it reads as
// "still loading" forever. Both fall back to the same designed placeholder
// the no-asset case already uses, so a dead link and an absent one look
// alike, because to the person looking they mean the same thing.

import { useState, type JSX } from "react";
import { ImageOffIcon } from "lucide-react";

export type BinThumbnail =
  | { kind: "image"; url: string }
  | { kind: "video"; url: string; posterUrl?: string | null }
  | { kind: "placeholder" };

export function BinThumbnail({
  thumbnail,
  itemLabel,
  badge,
}: {
  thumbnail: BinThumbnail;
  itemLabel: string;
  badge: string;
}): JSX.Element {
  const [failed, setFailed] = useState(false);

  if (thumbnail.kind === "placeholder" || failed) {
    return (
      <div
        role="img"
        aria-label={`${itemLabel}: no preview`}
        className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-muted-foreground"
      >
        <ImageOffIcon className="size-6" aria-hidden="true" />
        <span className="font-mono text-base font-medium tabular-nums">{badge}</span>
      </div>
    );
  }

  if (thumbnail.kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- signed URL, not a static import
      <img
        src={thumbnail.url}
        alt={itemLabel}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
    );
  }

  // Interactive inline video preview so admins (and owners) can play the clip
  // directly inside /bin to inspect the generation before restoring,
  // downloading, or permanently deleting it.
  return (
    <video
      src={thumbnail.url}
      poster={thumbnail.posterUrl ?? undefined}
      controls
      preload={thumbnail.posterUrl ? "none" : "metadata"}
      playsInline
      aria-label={itemLabel}
      onError={() => setFailed(true)}
      className="h-full w-full object-cover"
    />
  );
}
