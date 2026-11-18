"use client";

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { toast } from "sonner";
import { setSceneKeep } from "@/actions/scene-organize";
import { deleteClipScene } from "@/actions/ugc";
import { CLIP_RETENTION_DAYS, STALE_CLIP_DAYS, clipExpiryLabel } from "@/lib/clip-retention";

/** A finished Create clip whose newest take is past STALE_CLIP_DAYS. */
export type StaleClip = {
  sceneId: string;
  prompt: string;
  /** The newest take's created_at: what the worker's expiry counts from. */
  madeAt: string;
  posterUrl: string | null;
};

const BUTTON =
  "inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/**
 * /create's stale-clip prompt (owner, 2026-11-17): "clean up all, or select
 * the ones that stay". Selected clips are marked Keep (setSceneKeep), the
 * rest go to the Bin (deleteClipScene). It only warns: the worker's 14-day
 * expiry still runs for whatever is left. Clips in a real project are never
 * listed — the page reads only the personal Create project.
 */
export function StaleClipsPrompt({
  clips,
}: {
  clips: readonly StaleClip[];
}): JSX.Element | null {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [keepIds, setKeepIds] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();

  if (clips.length === 0) return null;
  const binCount = clips.filter((clip) => !keepIds.has(clip.sceneId)).length;
  const keepCount = clips.length - binCount;

  function toggle(sceneId: string): void {
    const next = new Set(keepIds);
    if (next.has(sceneId)) next.delete(sceneId);
    else next.add(sceneId);
    setKeepIds(next);
    setConfirming(false);
  }

  function apply(): void {
    start(async () => {
      let failed = 0;
      for (const clip of clips) {
        const keep = keepIds.has(clip.sceneId);
        const formData = new FormData();
        formData.set("sceneId", clip.sceneId);
        if (keep) formData.set("keep", "true");
        try {
          const result = keep ? await setSceneKeep(formData) : await deleteClipScene(formData);
          if (result?.error) failed++;
        } catch (error) {
          unstable_rethrow(error);
          failed++;
        }
      }
      if (failed > 0) toast.error(`${failed} could not be updated. The rest were.`);
      else if (binCount > 0) {
        toast(`${binCount} moved to Bin. Restore them from Bin within 3 days.`);
      } else toast(`${keepCount} kept.`);
      setConfirming(false);
      setOpen(false);
      setKeepIds(new Set());
      router.refresh();
    });
  }

  const actionLabel = confirming
    ? `Confirm: move ${binCount} to Bin`
    : keepCount === 0
      ? `Clean up all ${clips.length}`
      : binCount === 0
        ? `Keep all ${keepCount}`
        : `Keep ${keepCount}, clean up ${binCount}`;

  return (
    <section
      role="status"
      aria-label="Stale videos"
      className="mx-3 mt-3 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          You have {clips.length === 1 ? "1 stale video" : `${clips.length} stale videos`} older
          than {STALE_CLIP_DAYS} days. Unkept clips move to the Bin {CLIP_RETENTION_DAYS} days
          after they were made: clean up all, or select the ones that stay. Clips added to a
          project are never deleted.
        </p>
        <button
          type="button"
          className={BUTTON}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            setConfirming(false);
          }}
        >
          {open ? "Close" : "Review"}
        </button>
      </div>
      {open ? (
        <>
          <ul className="mt-3 grid max-h-80 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-4 lg:grid-cols-6">
            {clips.map((clip) => (
              <li key={clip.sceneId}>
                <label className="flex cursor-pointer flex-col gap-1 rounded-md border border-border bg-background p-1.5 has-[:checked]:ring-2 has-[:checked]:ring-primary">
                  {clip.posterUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a signed URL, not an optimizable asset
                    <img
                      src={clip.posterUrl}
                      alt=""
                      className="aspect-video w-full rounded object-cover"
                    />
                  ) : (
                    <div className="aspect-video w-full rounded bg-muted" />
                  )}
                  <span className="line-clamp-2 text-xs">{clip.prompt || "Untitled clip"}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={keepIds.has(clip.sceneId)}
                      onChange={() => toggle(clip.sceneId)}
                      aria-label={`Keep ${clip.prompt || "this clip"}`}
                    />
                    Keep · {clipExpiryLabel(false, clip.madeAt)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              className={BUTTON}
              disabled={pending}
              onClick={() => (confirming || binCount === 0 ? apply() : setConfirming(true))}
            >
              {pending ? "Working…" : actionLabel}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
