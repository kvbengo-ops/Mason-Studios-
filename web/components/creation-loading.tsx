import type { JSX } from "react";
import { Skeleton } from "@/components/ui/skeleton";

export function CreationLoading({
  kind,
  status,
}: {
  kind: "image" | "video";
  status: string;
}): JSX.Element {
  const label =
    status === "Queued"
      ? `Queued ${kind}`
      : kind === "image"
        ? "Generating image"
        : "Rendering video";

  return (
    <div
      role="status"
      aria-label={`${status} ${kind}`}
      className="relative isolate flex h-full w-full items-center justify-center overflow-hidden bg-card"
    >
      <Skeleton aria-hidden="true" className="absolute inset-0 z-0 rounded-none" />
      <span className="relative z-10 rounded-full border border-border bg-background/85 px-3 py-1 text-sm font-medium text-foreground shadow-sm backdrop-blur-sm">
        {label}
      </span>
    </div>
  );
}
