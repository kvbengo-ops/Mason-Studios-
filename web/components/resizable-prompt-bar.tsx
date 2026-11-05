"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { GripHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

const KEY_STEP_PX = 24;
/** Keeps the page and the bar's controls on screen however far it is dragged. */
const MAX_VIEWPORT_FRACTION = 0.6;
const DEFAULT_WIDTH = 960;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 64;
const DRAG_THRESHOLD_PX = 5;

function maxHeight(): number {
  return Math.round(window.innerHeight * MAX_VIEWPORT_FRACTION);
}

/**
 * Wraps a prompt bar so its prompt box can be dragged taller (or shorter) from
 * a grab bar on the bar's top edge — to read a long prompt without scrolling it.
 *
 * The prompt's height rides a CSS variable, and every textarea inside is sized
 * to it, so this needs nothing from the bar itself: the image bar and the video
 * bar both just sit inside it. The bar is docked to the bottom of the page, so
 * dragging UP grows it upward.
 *
 *   drag          resize            ArrowUp / ArrowDown   +/- 24px
 *   double-click  default <-> large Home                  back to default
 *
 * The chosen height is remembered per bar in localStorage. Every access is in
 * try/catch — blocked site data must not stop the bar from rendering.
 */
export function ResizablePromptBar({
  storageKey,
  defaultPx,
  children,
}: {
  /** Names this bar's remembered height, e.g. "image" or "video". */
  storageKey: string;
  /** The prompt box's normal height. */
  defaultPx: number;
  children: ReactNode;
}): JSX.Element {
  const [height, setHeight] = useState(defaultPx);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | { edge: "top" | "bottom"; start: number; size: number }
    | { edge: "left" | "right"; start: number; size: number }
    | {
        edge: "move";
        startX: number;
        startY: number;
        originX: number;
        originY: number;
        pendingCapture: boolean;
      }
    | null
  >(null);
  const key = `prompt-bar-height:${storageKey}`;
  const widthKey = `prompt-bar-width:${storageKey}`;
  const positionKey = `prompt-bar-position:${storageKey}`;

  function clampPosition(
    nextX: number,
    nextY: number,
    current = offset,
  ): { x: number; y: number } {
    const rect = barRef.current?.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) {
      const baseLeft = rect.left - current.x;
      const baseRight = rect.right - current.x;
      const baseTop = rect.top - current.y;
      const baseBottom = rect.bottom - current.y;
      const minX = Math.min(0, 8 - baseLeft);
      const maxX = Math.max(0, window.innerWidth - 8 - baseRight);
      const minY = Math.min(0, 8 - baseTop);
      const maxY = Math.max(0, window.innerHeight - 8 - baseBottom);
      return {
        x: Math.round(Math.max(minX, Math.min(nextX, maxX))),
        y: Math.round(Math.max(minY, Math.min(nextY, maxY))),
      };
    }
    const maxAbsX = Math.max(0, Math.round(window.innerWidth / 2));
    const minY = -Math.max(0, Math.round(window.innerHeight - MIN_HEIGHT));
    const maxY = Math.max(0, Math.round(window.innerHeight / 2));
    return {
      x: Math.round(Math.max(-maxAbsX, Math.min(nextX, maxAbsX))),
      y: Math.round(Math.max(minY, Math.min(nextY, maxY))),
    };
  }

  // After mount, not in the initial state: the server cannot read localStorage,
  // and a different first paint than the server's would break hydration.
  /* eslint-disable react-hooks/set-state-in-effect -- see the note above */
  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(key));
      if (Number.isFinite(saved) && saved >= MIN_HEIGHT) setHeight(Math.min(saved, maxHeight()));
      const savedWidth = Number(window.localStorage.getItem(widthKey));
      if (Number.isFinite(savedWidth) && savedWidth >= MIN_WIDTH) {
        setWidth(Math.min(savedWidth, Math.round(window.innerWidth * 0.95)));
      }
      const savedPosition = window.localStorage.getItem(positionKey);
      if (savedPosition) {
        const parsed = JSON.parse(savedPosition) as { x?: unknown; y?: unknown };
        if (
          typeof parsed?.x === "number" &&
          Number.isFinite(parsed.x) &&
          typeof parsed?.y === "number" &&
          Number.isFinite(parsed.y)
        ) {
          setOffset(clampPosition(parsed.x, parsed.y, { x: 0, y: 0 }));
        }
      }
    } catch {
      // Blocked or unavailable: the default is a fine height.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, widthKey, positionKey, defaultPx]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function commit(next: number): void {
    const clamped = Math.max(MIN_HEIGHT, Math.min(next, maxHeight()));
    setHeight(clamped);
    try {
      window.localStorage.setItem(key, String(clamped));
    } catch {
      // Not remembered; the bar still resizes.
    }
  }

  function commitWidth(next: number): void {
    const max = window.innerWidth * 0.95;
    const clamped = Math.max(Math.min(MIN_WIDTH, max), Math.min(next, max));
    setWidth(clamped);
    try {
      window.localStorage.setItem(widthKey, String(clamped));
    } catch {
      // Not remembered; the bar still resizes.
    }
  }

  function commitPosition(nextX: number, nextY: number, current = offset): void {
    const clamped = clampPosition(nextX, nextY, current);
    setOffset(clamped);
    try {
      window.localStorage.setItem(positionKey, JSON.stringify(clamped));
    } catch {
      // Not remembered; the bar still moves.
    }
  }

  function onPointerDown(
    event: PointerEvent<HTMLDivElement>,
    edge: "top" | "bottom" | "left" | "right",
  ): void {
    const start = edge === "top" || edge === "bottom" ? event.clientY : event.clientX;
    drag.current = {
      edge,
      start,
      size: edge === "top" || edge === "bottom" ? height : width,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onMovePointerDown(event: PointerEvent<HTMLDivElement>, pendingCapture = false): void {
    if (event.button !== 0) return;
    drag.current = {
      edge: "move",
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
      pendingCapture,
    };
    if (!pendingCapture) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  }

  function onBarPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || drag.current) return;
    const target = event.target instanceof Element ? event.target : null;
    if (
      target?.closest(
        'input, button, select, a, [role="button"], [role="separator"], [role="listbox"], [role="option"], [role="menuitem"], [role="combobox"], [role="dialog"], [data-slot="dropdown-menu-trigger"]',
      )
    ) {
      return;
    }
    const textarea = target?.closest("textarea");
    if (textarea) {
      if (document.activeElement === textarea && textarea.value.length > 0) return;
      onMovePointerDown(event, true);
      return;
    }
    onMovePointerDown(event, false);
  }

  function onBarDoubleClick(event: React.MouseEvent<HTMLDivElement>): void {
    const target = event.target instanceof Element ? event.target : null;
    if (
      target?.closest(
        'textarea, input, button, select, a, [role="separator"], [role="listbox"], [role="option"], [role="menuitem"], [role="combobox"], [role="dialog"], [data-slot="dropdown-menu-trigger"]',
      )
    ) {
      return;
    }
    commitPosition(0, 0);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!drag.current) return;
    if (drag.current.edge === "move") {
      const { startX, startY, originX, originY, pendingCapture } = drag.current;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (pendingCapture) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        drag.current.pendingCapture = false;
        barRef.current?.setPointerCapture?.(event.pointerId);
      }
      commitPosition(originX + dx, originY + dy);
      return;
    }
    const { edge, start, size } = drag.current;
    if (edge === "top") commit(size + start - event.clientY);
    else if (edge === "bottom") commit(size + event.clientY - start);
    else commitWidth(size + (edge === "right" ? 1 : -1) * (event.clientX - start));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, axis: "horizontal" | "vertical"): void {
    if (axis === "horizontal" && event.key === "ArrowUp") commit(height + KEY_STEP_PX);
    else if (axis === "horizontal" && event.key === "ArrowDown") commit(height - KEY_STEP_PX);
    else if (axis === "vertical" && event.key === "ArrowRight") commitWidth(width + KEY_STEP_PX);
    else if (axis === "vertical" && event.key === "ArrowLeft") commitWidth(width - KEY_STEP_PX);
    else if (event.key === "Home" && axis === "horizontal") commit(defaultPx);
    else if (event.key === "Home") commitWidth(DEFAULT_WIDTH);
    else return;
    event.preventDefault();
  }

  function onMoveKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowUp") commitPosition(offset.x, offset.y - KEY_STEP_PX);
    else if (event.key === "ArrowDown") commitPosition(offset.x, offset.y + KEY_STEP_PX);
    else if (event.key === "ArrowLeft") commitPosition(offset.x - KEY_STEP_PX, offset.y);
    else if (event.key === "ArrowRight") commitPosition(offset.x + KEY_STEP_PX, offset.y);
    else if (event.key === "Home") commitPosition(0, 0);
    else return;
    event.preventDefault();
  }

  const moved = offset.x !== 0 || offset.y !== 0;

  return (
    <div
      ref={barRef}
      data-moved={moved ? "true" : undefined}
      onPointerDown={onBarPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={onBarDoubleClick}
      className={cn(
        "pointer-events-auto relative mx-auto w-[min(95vw,100%,var(--prompt-w))] cursor-grab active:cursor-grabbing",
        // Every textarea in the bar takes the dragged height. Important, to
        // beat the fixed h-16/h-20 the bars set on the prompt box.
        "[&_textarea]:h-(--prompt-h)! [&_textarea]:max-h-(--prompt-h)! [&_textarea]:min-h-(--prompt-h)!",
      )}
      style={
        {
          "--prompt-h": `${height}px`,
          "--prompt-w": `${width}px`,
          "--prompt-x": `${offset.x}px`,
          "--prompt-y": `${offset.y}px`,
          transform: moved ? `translate3d(${offset.x}px, ${offset.y}px, 0)` : undefined,
        } as CSSProperties
      }
    >
      <div
        role="button"
        aria-label="Move prompt box"
        tabIndex={0}
        title="Drag to move · double-click to reset position"
        onPointerDown={(event) => onMovePointerDown(event, false)}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onDoubleClick={() => commitPosition(0, 0)}
        onKeyDown={onMoveKeyDown}
        className="absolute left-6 top-0 z-10 flex h-5 -translate-y-1/2 cursor-grab touch-none select-none items-center gap-1 rounded-full border border-border bg-card px-2 text-[10px] font-medium text-muted-foreground shadow-sm transition-colors hover:border-foreground/40 hover:text-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <GripHorizontal aria-hidden="true" className="size-3" />
        <span>Move</span>
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize prompt box"
        aria-valuemin={MIN_HEIGHT}
        aria-valuenow={height}
        tabIndex={0}
        title="Drag to resize · double-click to expand"
        onPointerDown={(event) => onPointerDown(event, "top")}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onDoubleClick={() =>
          commit(height > defaultPx ? defaultPx : Math.round(window.innerHeight * 0.4))
        }
        onKeyDown={(event) => onKeyDown(event, "horizontal")}
        className="absolute left-1/2 top-0 z-10 flex h-4 w-24 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize touch-none items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden="true" className="h-1 w-10 rounded-full bg-border" />
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize prompt box bottom"
        aria-valuemin={MIN_HEIGHT}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={(event) => onPointerDown(event, "bottom")}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={(event) => onKeyDown(event, "horizontal")}
        className="absolute inset-x-3 -bottom-1.5 z-10 h-3 touch-none cursor-ns-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {(["left", "right"] as const).map((edge) => (
        <div
          key={edge}
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize prompt box ${edge}`}
          aria-valuemin={MIN_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={(event) => onPointerDown(event, edge)}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onKeyDown={(event) => onKeyDown(event, "vertical")}
          className={cn(
            "absolute inset-y-3 z-10 w-3 touch-none cursor-ew-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            edge === "left" ? "-left-1.5" : "-right-1.5",
          )}
        />
      ))}
      {children}
    </div>
  );
}
