"use client";

import type { JSX, ReactNode } from "react";
import { UGC_CLIP_DRAG_TYPE } from "@/lib/image-reuse";

/**
 * A scene-strip tile (ugc-scene-strip.tsx is a server component, so the drag
 * handler lives here). With a clip, dragging the tile onto the /ugc prompt bar
 * references that clip; without one it is a plain div.
 */
export function UgcClipDragTile({
  clipAssetId,
  className,
  children,
}: {
  clipAssetId: string | null;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={className}
      draggable={clipAssetId !== null}
      onDragStart={(event) => {
        if (!clipAssetId) return;
        event.dataTransfer.setData(UGC_CLIP_DRAG_TYPE, clipAssetId);
        event.dataTransfer.effectAllowed = "copy";
      }}
    >
      {children}
    </div>
  );
}
