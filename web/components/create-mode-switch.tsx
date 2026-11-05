import Link from "next/link";
import type { JSX } from "react";
import { ImageIcon, VideoIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** The Image | Video switch on /create and inside a clip project. Links, not state. */
export function CreateModeSwitch({
  video,
  imageHref,
  videoHref,
}: {
  video: boolean;
  imageHref: string;
  videoHref: string;
}): JSX.Element {
  return (
    <nav aria-label="Create mode" className="flex shrink-0 gap-1 rounded-xl border border-border bg-background/80 p-1 text-foreground shadow-lg backdrop-blur-md">
      {(
        [
          { href: imageHref, label: "Image", icon: ImageIcon, active: !video },
          { href: videoHref, label: "Video", icon: VideoIcon, active: video },
        ] as const
      ).map(({ href, label, icon: Icon, active }) => (
        <Link
          key={label}
          href={href}
          aria-current={active ? "page" : undefined}
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors",
            active
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
