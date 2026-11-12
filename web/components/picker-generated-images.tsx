"use client";

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { loadPersonalImageHistory } from "@/actions/image-generator";
import { useGeneratedImage } from "@/actions/use-generated-image";
import { Button } from "@/components/ui/button";
import { useAsyncAction } from "@/components/use-async-action";
import type { GeneratedImage } from "@/lib/image-generation";
import type { ImageHistoryCursor } from "@/components/image-generator-history";
import type { ElementTag } from "@/lib/elements";

/**
 * The reference picker's Images tab: the operator's own Create history. Using
 * one tags it (files it as a private element, see actions/use-generated-image.ts)
 * and hands the element to the picker's own "use" path, so the references box,
 * its limit and its duplicate check all apply unchanged.
 */
export function PickerGeneratedImages({ onUse }: { onUse: (el: ElementTag) => void }): JSX.Element {
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [cursor, setCursor] = useState<ImageHistoryCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  function use(assetId: string): void {
    run(async () => {
      try {
        const result = await useGeneratedImage(assetId);
        if ("error" in result) {
          toast.error(result.error);
          return;
        }
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
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <ul className="grid min-h-0 flex-1 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
        {images.map((image) => (
          <li key={image.assetId}>
            <button
              type="button"
              disabled={pending}
              aria-pressed={selectedId === image.assetId}
              onClick={() => setSelectedId(image.assetId)}
              onDoubleClick={() => use(image.assetId)}
              className={`aspect-square w-full overflow-hidden rounded-lg border bg-muted/60 ${selectedId === image.assetId ? "border-primary ring-2 ring-primary/40" : ""}`}
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
      <div className="flex items-center gap-2">
        {cursor ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => void loadMore(cursor)}
          >
            {loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : "Load more"}
          </Button>
        ) : null}
        <Button
          type="button"
          className="ml-auto"
          disabled={selectedId === null || pending}
          onClick={() => selectedId && use(selectedId)}
        >
          {pending ? "Tagging…" : "Use image"}
        </Button>
      </div>
    </div>
  );
}
