import type { JSX, ReactNode } from "react";
import { ImageLightbox } from "@/components/image-lightbox";
import { cn } from "@/lib/utils";

export function UserAvatar({
  username,
  email,
  avatarUrl,
  className,
  children,
}: {
  username: string;
  email: string;
  avatarUrl?: string;
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <span
      title={username || email}
      className={cn(
        "relative flex size-9 shrink-0 items-center justify-center rounded-full border bg-muted text-sm text-muted-foreground",
        className,
      )}
    >
      {avatarUrl ? (
        <ImageLightbox
          src={avatarUrl}
          alt={`${username || email}'s profile picture`}
          className="size-full rounded-full object-cover"
          showIcon={false}
        />
      ) : (
        username?.[0]?.toUpperCase() || email?.[0]?.toUpperCase() || "?"
      )}
      {children}
    </span>
  );
}
