import type { JSX } from "react";
import { isOnline, lastSeenLabel } from "@/lib/presence";
import { cn } from "@/lib/utils";

/** Green when seen in the last 2 minutes, red otherwise; the tooltip says when. */
export function PresenceDot({
  lastSeenAt,
  now = new Date(),
  className,
  offlineClassName,
}: {
  lastSeenAt: string | null | undefined;
  now?: Date;
  className?: string;
  offlineClassName?: string;
}): JSX.Element {
  const online = isOnline(lastSeenAt, now);
  const label = lastSeenLabel(lastSeenAt, now);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        online ? "bg-green-500" : "bg-red-500",
        !online && offlineClassName,
        className,
      )}
    />
  );
}
