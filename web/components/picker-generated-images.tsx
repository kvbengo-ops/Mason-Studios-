"use client";

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toast } from "sonner";
import { loadPersonalImageHistory } from "@/actions/image-generator";
import { tagGeneratedImage } from "@/actions/tag-generated-image";
import { PendingButton } from "@/components/pending-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAsyncAction } from "@/components/use-async-action";
import type { GeneratedImage } from "@/lib/image-generation";
import type { ImageHistoryCursor } from "@/components/image-generator-history";
import type { ElementTag } from "@/lib/elements";

/**
 * The reference picker's Images tab, laid out like its Elements tab: the grid on
 * the left, and on the right the picture with the Tag and Description it will be
 * saved under. Using one files it as a private element named and described as
 * typed (actions/tag-generated-image.ts) and hands that element to the picker's
 * own "use" path, so the references box, its limit and its duplicate check apply
 * unchanged.
 */
export function PickerGeneratedImages({ onUse }: { onUse: (el: ElementTag) => void }): JSX.Element {
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [cursor, setCursor] = useState<ImageHistoryCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<GeneratedImage | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { pending, run } = useAsyncAction();

  async function loadMore(from: ImageHistoryCursor): Promise<void> {
    setLoading(true);
    setFailed(false);
    try {
      const page = await loadPersonalImageHistory(from);
      setImages((current) => [...current, ...page.images]);
      setCursor(page.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  // First page on mount, with state set only in the promise callbacks.
  useEffect(() => {
    let cancelled = false;
    loadPersonalImageHistory(null)
      .then((page) => {
        if (cancelled) return;
        setImages(page.images);
        setCursor(page.nextCursor);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function select(image: GeneratedImage): void {
    if (image.assetId === selected?.assetId) return;
    setSelected(image);
    setName("");
    setDescription("");
  }

  function use(): void {
    if (!selected) return;
    const assetId = selected.assetId;
    run(async () => {
      try {
        const result = await tagGeneratedImage({
          assetId,
          name: name.trim().replace(/^@+/, ""),
          description,
        });
        if ("error" in result) {
          toast.error(result.error);
          return;
        }
        if (result.existing) toast(`Already tagged as @${result.element.name}.`);
        onUse(result.element);
      } catch {
        toast.error("Could not tag that image.");
      }
    });
  }

  if (!loading && !failed && images.length === 0) {
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">
        No generated images yet. Make one in the Image Generator and it shows up here.
      </p>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto pr-1">
        <ul className="grid auto-rows-min grid-cols-2 gap-2">
          {images.map((image) => (
            <li key={image.assetId}>
              <button
                type="button"
                aria-pressed={selected?.assetId === image.assetId}
                onClick={() => select(image)}
                className={`aspect-square w-full overflow-hidden rounded-xl border bg-muted/60 ${selected?.assetId === image.assetId ? "border-primary ring-2 ring-primary/40" : ""}`}
              >
                <img
                  src={image.url}
                  alt="Generated image"
                  loading="lazy"
                  decoding="async"
                  className="size-full object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
        {loading && images.length === 0 ? (
          <p role="status" className="p-6 text-center text-sm text-muted-foreground">
            Loading images…
          </p>
        ) : null}
        {failed ? (
          <p role="alert" className="text-center text-sm text-destructive">
            Images could not be loaded.
          </p>
        ) : null}
        {cursor ? (
          <PendingButton
            type="button"
            size="sm"
            variant="ghost"
            pending={loading}
            onClick={() => void loadMore(cursor)}
          >
            Load more
          </PendingButton>
        ) : null}
      </div>

      {selected === null ? (
        <p className="grid place-items-center rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          Pick one to name it and say what it shows.
        </p>
      ) : (
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto rounded-md border p-3 text-left">
          <div className="relative mx-auto flex max-h-56 w-full justify-center overflow-hidden rounded-md bg-muted/60">
            <img
              src={selected.url}
              alt="Selected generated image"
              className="max-h-56 w-auto max-w-full object-contain"
            />
          </div>

          <div className="grid grid-cols-[3fr_1fr] gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="generated-image-tag" className="text-[11px] text-muted-foreground">
                Tag
              </label>
              <Input
                id="generated-image-tag"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={64}
                placeholder="e.g. coffee_front"
                disabled={pending}
                className="h-8 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">Category</span>
              <span className="inline-flex h-8 items-center justify-center rounded-full border border-green-600/40 bg-green-500/10 px-2 text-xs font-medium text-green-700 dark:text-green-400">
                Image
              </span>
            </div>
          </div>

          <label
            htmlFor="generated-image-description"
            className="text-[11px] text-muted-foreground"
          >
            Description
          </label>
          <Textarea
            id="generated-image-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            maxLength={2000}
            disabled={pending}
            placeholder="What is in this picture? This text replaces the tag in a prompt."
            className="text-sm"
          />
          <p className="text-[10px] leading-snug text-muted-foreground">
            Letters, numbers, - and _ only, no @. Saved to your Elements Library when you use it.
          </p>

          <div className="sticky bottom-0 bg-background pt-2">
            <PendingButton
              type="button"
              className="w-full"
              pending={pending}
              disabled={name.trim() === ""}
              onClick={use}
            >
              Use element
            </PendingButton>
          </div>
        </div>
      )}
    </div>
  );
}
