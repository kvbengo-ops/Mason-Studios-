import type { JSX } from "react";
import { BinThumbnail, type BinThumbnail as BinThumbnailValue } from "@/components/bin-thumbnail";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { VideoRun } from "@/components/video-runs-panel";
import type {
  EditorDeletedData,
  EditorImageItem,
  EditorImageRun,
  EditorVideoClip,
} from "@/lib/admin-creations";
import { dateTimeFormatter } from "@/lib/datetime";
import { formatCredits } from "@/lib/format-usd";
import type { ImageAttemptStatus } from "@/lib/image-attempt";
import { cn } from "@/lib/utils";

export type AdminCreationsTab = "images" | "videos" | "deleted";

export type AdminCreationsGridProps =
  | {
      tab: "images";
      images: readonly EditorImageItem[];
      imageRuns: readonly EditorImageRun[];
    }
  | {
      tab: "videos";
      clips: readonly EditorVideoClip[];
      videoRuns: readonly VideoRun[];
    }
  | {
      tab: "deleted";
      deleted: EditorDeletedData;
    };

const IMAGE_RUN_STATUS_LABEL: Record<ImageAttemptStatus, string> = {
  queued: "Queued…",
  generating: "Generating…",
  completed: "Completed",
  failed: "Failed",
  billing_unknown: "Billing unknown",
};

const VIDEO_RUN_STATUS_LABEL: Record<VideoRun["status"], string> = {
  queued: "Queued…",
  rendering: "Rendering…",
  done: "Done",
  failed: "Failed",
};

function DeletedMediaPreview({
  thumbnail,
  itemLabel,
  badge,
}: {
  thumbnail: BinThumbnailValue;
  itemLabel: string;
  badge: string;
}): JSX.Element {
  if (thumbnail.kind === "video") {
    return (
      <video
        src={thumbnail.url}
        controls
        preload="metadata"
        playsInline
        className="h-full w-full object-contain"
      />
    );
  }
  return <BinThumbnail thumbnail={thumbnail} itemLabel={itemLabel} badge={badge} />;
}

export function AdminCreationsGrid(props: AdminCreationsGridProps): JSX.Element {
  if (props.tab === "images") {
    const { images, imageRuns } = props;
    return (
      <div className="flex flex-col gap-8">
        <section aria-labelledby="admin-creations-images-heading" className="flex flex-col gap-3">
          <h2 id="admin-creations-images-heading" className="text-lg font-semibold">
            Generated images ({images.length})
          </h2>
          {images.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
              No personal generated images yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {images.map((image) => (
                <Card key={image.assetId} className="flex h-full min-w-0 flex-col py-3">
                  <CardContent className="flex flex-1 flex-col gap-2 px-3">
                    <div className="relative aspect-[9/16] w-full overflow-hidden rounded-md border border-border bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element -- signed Storage URL */}
                      <img
                        src={image.url}
                        alt={image.prompt ?? "Generated image"}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      {image.modelLabel ? (
                        <Badge variant="secondary">{image.modelLabel}</Badge>
                      ) : null}
                      {image.costUsd !== null ? (
                        <span className="font-mono text-xs font-medium tabular-nums text-foreground">
                          {formatCredits(image.costUsd)}
                        </span>
                      ) : null}
                    </div>
                    <p className="line-clamp-3 break-words text-sm leading-snug">
                      {image.prompt ?? "(no prompt)"}
                    </p>
                    <p className="mt-auto text-[11px] text-muted-foreground">
                      {dateTimeFormatter.format(new Date(image.createdAt))}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        <section
          aria-labelledby="admin-creations-image-runs-heading"
          className="flex flex-col gap-3"
        >
          <h2 id="admin-creations-image-runs-heading" className="text-lg font-semibold">
            Image attempts ({imageRuns.length})
          </h2>
          {imageRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No image attempts yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {imageRuns.map((run) => (
                <li
                  key={run.runId}
                  className="flex flex-col gap-1 rounded-md border border-border p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={cn(
                        "text-sm font-medium",
                        run.status === "failed" || run.status === "billing_unknown"
                          ? "text-destructive"
                          : "text-foreground",
                      )}
                    >
                      {IMAGE_RUN_STATUS_LABEL[run.status]}
                    </span>
                    <span className="font-mono text-sm font-medium tabular-nums">
                      {run.costUsd !== null ? formatCredits(run.costUsd) : "Not billed"}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {run.modelLabel} · {dateTimeFormatter.format(new Date(run.createdAt))}
                  </span>
                  {run.reason ? (
                    <span className="break-words text-xs text-muted-foreground">{run.reason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    );
  }

  if (props.tab === "videos") {
    const { clips, videoRuns } = props;
    return (
      <div className="flex flex-col gap-8">
        <section aria-labelledby="admin-creations-videos-heading" className="flex flex-col gap-3">
          <h2 id="admin-creations-videos-heading" className="text-lg font-semibold">
            Video clips ({clips.length})
          </h2>
          {clips.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
              No video clips yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {clips.map((clip) => (
                <Card key={clip.key} className="flex h-full min-w-0 flex-col py-3">
                  <CardContent className="flex flex-1 flex-col gap-2 px-3">
                    <div className="relative aspect-[9/16] w-full overflow-hidden rounded-md border border-border bg-black">
                      <video
                        src={clip.url}
                        controls
                        preload="metadata"
                        playsInline
                        className="h-full w-full object-contain"
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary">{clip.modelLabel}</Badge>
                        <Badge variant="outline" className="font-mono tabular-nums">
                          v{clip.n}
                        </Badge>
                        {clip.durationS ? (
                          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                            {clip.durationS}s
                          </span>
                        ) : null}
                      </div>
                      {clip.costUsd !== null ? (
                        <span className="font-mono text-xs font-medium tabular-nums text-foreground">
                          {formatCredits(clip.costUsd)}
                        </span>
                      ) : null}
                    </div>
                    <p className="line-clamp-3 break-words text-sm leading-snug">
                      {clip.prompt || "(no prompt)"}
                    </p>
                    <p className="mt-auto text-[11px] text-muted-foreground">
                      {clip.personal ? "Personal" : clip.projectTitle} ·{" "}
                      {dateTimeFormatter.format(new Date(clip.createdAt))}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        <section
          aria-labelledby="admin-creations-video-runs-heading"
          className="flex flex-col gap-3"
        >
          <h2 id="admin-creations-video-runs-heading" className="text-lg font-semibold">
            Video attempts ({videoRuns.length})
          </h2>
          {videoRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No video attempts yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {videoRuns.map((run) => {
                const inFlight = run.status === "queued" || run.status === "rendering";
                return (
                  <li
                    key={run.id}
                    className="flex flex-col gap-1 rounded-md border border-border p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span
                        className={cn(
                          "text-sm font-medium",
                          run.status === "failed" ? "text-destructive" : "text-foreground",
                        )}
                      >
                        {VIDEO_RUN_STATUS_LABEL[run.status]}
                      </span>
                      {run.costUsd !== null || !inFlight ? (
                        <span className="font-mono text-sm font-medium tabular-nums">
                          {run.costUsd !== null ? formatCredits(run.costUsd) : "Not billed"}
                        </span>
                      ) : null}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {run.modelLabel} · {dateTimeFormatter.format(new Date(run.createdAt))}
                    </span>
                    {run.prompt ? (
                      <p className="line-clamp-2 break-words text-xs">{run.prompt}</p>
                    ) : null}
                    {run.reason ? (
                      <span className="break-words text-xs text-muted-foreground">
                        {run.reason}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    );
  }

  const { scenes, versions, images } = props.deleted;
  const totalDeleted = scenes.length + versions.length + images.length;

  if (totalDeleted === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No deleted scenes, takes, or images for this editor.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section
        aria-labelledby="admin-creations-deleted-scenes-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="admin-creations-deleted-scenes-heading" className="text-lg font-semibold">
          Deleted scenes ({scenes.length})
        </h2>
        {scenes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deleted scenes.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {scenes.map((scene) => {
              const badge = scene.idx === null ? "—" : `#${scene.idx}`;
              const itemLabel = scene.idx === null ? "Scene" : `Scene #${scene.idx}`;
              return (
                <Card key={scene.sceneId} className="flex h-full min-w-0 flex-col py-3">
                  <CardContent className="flex flex-1 flex-col gap-2 px-3">
                    <div
                      className={cn(
                        "relative aspect-[9/16] w-full overflow-hidden rounded-md bg-muted",
                        scene.thumbnail.kind === "placeholder"
                          ? "border border-dashed border-border"
                          : "border border-border",
                      )}
                    >
                      <DeletedMediaPreview
                        thumbnail={scene.thumbnail}
                        itemLabel={itemLabel}
                        badge={badge}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary" className="font-mono tabular-nums">
                        {badge}
                      </Badge>
                      {scene.modelLabel ? (
                        <Badge variant="outline">{scene.modelLabel}</Badge>
                      ) : null}
                      <span className="text-[11px] text-muted-foreground">
                        {scene.versionCount} version{scene.versionCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <p className="line-clamp-2 break-words text-sm leading-snug">{scene.prompt}</p>
                    <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                      <Badge variant="secondary">
                        Deleted {dateTimeFormatter.format(new Date(scene.deletedAt))}
                      </Badge>
                      {scene.purged ? <Badge variant="outline">Purged</Badge> : null}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section
        aria-labelledby="admin-creations-deleted-versions-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="admin-creations-deleted-versions-heading" className="text-lg font-semibold">
          Deleted takes ({versions.length})
        </h2>
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deleted takes.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {versions.map((version) => {
              const badge = version.n === null ? "—" : `v${version.n}`;
              const itemLabel = version.n === null ? "Version" : `Version v${version.n}`;
              return (
                <Card key={version.versionId} className="flex h-full min-w-0 flex-col py-3">
                  <CardContent className="flex flex-1 flex-col gap-2 px-3">
                    <div
                      className={cn(
                        "relative aspect-[9/16] w-full overflow-hidden rounded-md bg-muted",
                        version.thumbnail.kind === "placeholder"
                          ? "border border-dashed border-border"
                          : "border border-border",
                      )}
                    >
                      <DeletedMediaPreview
                        thumbnail={version.thumbnail}
                        itemLabel={itemLabel}
                        badge={badge}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary" className="font-mono tabular-nums">
                        {badge}
                      </Badge>
                      {version.modelLabel ? (
                        <Badge variant="outline">{version.modelLabel}</Badge>
                      ) : null}
                    </div>
                    <p className="line-clamp-2 break-words text-sm leading-snug">
                      {version.prompt}
                    </p>
                    <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                      <Badge variant="secondary">
                        Deleted {dateTimeFormatter.format(new Date(version.deletedAt))}
                      </Badge>
                      {version.purged ? <Badge variant="outline">Purged</Badge> : null}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section
        aria-labelledby="admin-creations-deleted-images-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="admin-creations-deleted-images-heading" className="text-lg font-semibold">
          Binned images ({images.length})
        </h2>
        {images.length === 0 ? (
          <p className="text-sm text-muted-foreground">No binned images.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {images.map((image) => (
              <Card key={image.assetId} className="flex h-full min-w-0 flex-col py-3">
                <CardContent className="flex flex-1 flex-col gap-2 px-3">
                  <div
                    className={cn(
                      "relative aspect-[9/16] w-full overflow-hidden rounded-md bg-muted",
                      image.thumbnail.kind === "placeholder"
                        ? "border border-dashed border-border"
                        : "border border-border",
                    )}
                  >
                    <BinThumbnail
                      thumbnail={image.thumbnail}
                      itemLabel="Generated image"
                      badge="Image"
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <Badge variant="secondary">{image.modelLabel ?? "Image"}</Badge>
                    {image.costUsd !== null ? (
                      <span className="font-mono text-xs font-medium tabular-nums text-foreground">
                        {formatCredits(image.costUsd)}
                      </span>
                    ) : null}
                  </div>
                  <p className="line-clamp-2 break-words text-sm leading-snug">
                    {image.prompt ?? "Generated image"}
                  </p>
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                    <Badge variant="secondary">
                      Deleted {dateTimeFormatter.format(new Date(image.deletedAt))}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
