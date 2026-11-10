import type { JSX } from "react";
import { cn } from "@/lib/utils";

/**
 * A plain avatar for use inside a link or button. UserAvatar wraps the
 * picture in a lightbox button, which cannot nest inside interactive content.
 */
export function AvatarThumb({
  username,
  email,
  avatarUrl,
  className,
}: {
  username: string;
  email: string;
  avatarUrl?: string;
  className?: string;
}): JSX.Element {
  return (
    <span
      title={username || email}
      className={cn(
        "grid size-8 shrink-0 place-items-center overflow-hidden rounded-full border bg-muted text-xs text-muted-foreground",
        className,
      )}
    >
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed thumb URL, same as UserAvatar
        <img src={avatarUrl} alt="" className="size-full object-cover" />
      ) : (
        (username || email || "?")[0]?.toUpperCase()
      )}
    </span>
  );
}
