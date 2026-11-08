"use client";

import { useEffect, useSyncExternalStore, type JSX, type MouseEvent, type ReactNode } from "react";
import Link, { useLinkStatus } from "next/link";
import { ImageIcon, VideoIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { tileBox, WALL_CLASS } from "@/lib/tile-box";
import { cn } from "@/lib/utils";

type CreateMode = "image" | "video";

const SKELETON_TILE_RATIOS: readonly number[] = [
  3 / 4,
  9 / 16,
  4 / 3,
  3 / 4,
  9 / 16,
  1,
  3 / 4,
  9 / 16,
];

let pendingCreateMode: CreateMode | null = null;
const pendingListeners = new Set<() => void>();

function setPendingCreateMode(next: CreateMode | null): void {
  if (pendingCreateMode === next) return;
  pendingCreateMode = next;
  for (const listener of pendingListeners) listener();
}

function subscribePendingCreateMode(listener: () => void): () => void {
  pendingListeners.add(listener);
  return (): void => {
    pendingListeners.delete(listener);
  };
}

function getPendingCreateModeSnapshot(): CreateMode | null {
  return pendingCreateMode;
}

function getServerPendingCreateModeSnapshot(): CreateMode | null {
  return null;
}

function usePendingCreateMode(): CreateMode | null {
  return useSyncExternalStore(
    subscribePendingCreateMode,
    getPendingCreateModeSnapshot,
    getServerPendingCreateModeSnapshot,
  );
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

function ModeLinkContent({
  mode,
  currentMode,
  active,
  icon: Icon,
  label,
}: {
  mode: CreateMode;
  currentMode: CreateMode;
  active: boolean;
  icon: typeof ImageIcon;
  label: string;
}): JSX.Element {
  const { pending } = useLinkStatus();

  useEffect((): void => {
    if (pending && mode !== currentMode) {
      setPendingCreateMode(mode);
    }
  }, [pending, mode, currentMode]);

  return (
    <span
      data-active={active || pending ? "true" : "false"}
      className={cn(
        "inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors",
        active || pending
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
      {label}
    </span>
  );
}

/** The Image | Video switch on /create and inside a clip project. */
export function CreateModeSwitch({
  video,
  imageHref,
  videoHref,
}: {
  video: boolean;
  imageHref: string;
  videoHref: string;
}): JSX.Element {
  const currentMode: CreateMode = video ? "video" : "image";
  const pendingMode = usePendingCreateMode();
  const effectiveMode: CreateMode = pendingMode ?? currentMode;

  useEffect((): void => {
    if (pendingMode === currentMode) {
      setPendingCreateMode(null);
    }
  }, [pendingMode, currentMode]);

  useEffect((): (() => void) => {
    return (): void => {
      setPendingCreateMode(null);
    };
  }, []);

  const items = [
    {
      mode: "image" as const,
      href: imageHref,
      label: "Image",
      icon: ImageIcon,
      active: effectiveMode === "image",
    },
    {
      mode: "video" as const,
      href: videoHref,
      label: "Video",
      icon: VideoIcon,
      active: effectiveMode === "video",
    },
  ] as const;

  return (
    <nav
      aria-label="Create mode"
      className="flex shrink-0 gap-1 rounded-xl border border-border bg-background/80 p-1 text-foreground shadow-lg backdrop-blur-md"
    >
      {items.map(({ mode, href, label, icon, active }) => (
        <Link
          key={label}
          href={href}
          aria-current={active ? "page" : undefined}
          onClick={(event: MouseEvent<HTMLAnchorElement>): void => {
            if (!isPlainLeftClick(event)) return;
            if (mode === currentMode) {
              setPendingCreateMode(null);
              return;
            }
            setPendingCreateMode(mode);
          }}
          className="inline-flex flex-1 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ModeLinkContent
            mode={mode}
            currentMode={currentMode}
            active={active}
            icon={icon}
            label={label}
          />
        </Link>
      ))}
    </nav>
  );
}

/**
 * Skeleton placeholder shown while switching between Image and Video
 * generation on /create or /ugc/[id]. Mirrors the gallery wall (or project
 * clip workspace) and sticky bottom prompt dock so layout does not jump.
 */
export function CreateModeSkeleton({
  video,
  projectVideo = false,
}: {
  video: boolean;
  projectVideo?: boolean;
}): JSX.Element {
  const label = video ? "Loading video generator" : "Loading image generator";

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      data-create-mode-skeleton={video ? "video" : "image"}
      className="flex min-h-0 flex-1 flex-col"
    >
      {video && projectVideo ? (
        <div
          aria-hidden="true"
          className="flex min-h-[26rem] flex-col gap-4 xl:h-[calc(100svh-8.5rem)] xl:flex-row xl:items-stretch"
        >
          <div className="flex shrink-0 gap-2 overflow-hidden xl:w-44 xl:flex-col">
            {[0, 1, 2, 3].map((index) => (
              <div
                key={index}
                className="flex w-44 shrink-0 flex-col gap-1.5 rounded-md border border-border p-1.5"
              >
                <Skeleton className="h-24 w-full rounded-sm" />
                <Skeleton className="h-3 w-20 rounded-sm" />
              </div>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-card p-3 xl:pb-48">
            <Skeleton className="h-5 w-44 rounded-sm" />
            <Skeleton className="mt-3 min-h-0 flex-1 rounded-md" />
          </div>
        </div>
      ) : (
        <div aria-hidden="true" className={WALL_CLASS}>
          {SKELETON_TILE_RATIOS.map((ratio, index) => (
            <div
              key={index}
              className="relative overflow-hidden border border-border/60 bg-card"
              style={tileBox(ratio)}
            >
              <Skeleton className="h-full w-full rounded-none" />
            </div>
          ))}
        </div>
      )}

      <div
        aria-hidden="true"
        className="pointer-events-none sticky bottom-0 z-30 mt-auto bg-gradient-to-t from-background via-background to-transparent px-3 pb-3 pt-8"
      >
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 rounded-2xl border border-border bg-card/95 p-3 shadow-lg">
          <Skeleton className="h-16 w-full rounded-xl" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-9 w-20 rounded-lg" />
              <Skeleton className="h-9 w-28 rounded-full" />
              <Skeleton className="h-9 w-36 rounded-full" />
            </div>
            <Skeleton className="h-9 w-28 rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Swaps the active console for CreateModeSkeleton immediately when the
 * operator switches between Image and Video in CreateModeSwitch.
 */
export function CreateModeContent({
  video,
  projectVideo = false,
  children,
}: {
  video: boolean;
  projectVideo?: boolean;
  children: ReactNode;
}): JSX.Element {
  const currentMode: CreateMode = video ? "video" : "image";
  const pendingMode = usePendingCreateMode();

  if (pendingMode !== null && pendingMode !== currentMode) {
    return <CreateModeSkeleton video={pendingMode === "video"} projectVideo={projectVideo} />;
  }

  return <>{children}</>;
}
