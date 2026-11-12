"use client";

import { useState, type JSX, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
import { toast } from "sonner";
import { reorderStudioScenes } from "@/actions/scene-organize";
import { cn } from "@/lib/utils";

export interface SceneSortGroup {
  /** The scene id: every take of one scene moves together. */
  id: string;
  /** "scene 3", for the grip's accessible name. */
  label: string;
  /** The scene's tile, or tiles when it has several takes. */
  node: ReactNode;
}

/**
 * The strip's scenes, draggable into a new order (0142). The tiles themselves
 * are rendered by the server strip and passed in; this only arranges them and
 * saves the order. Dragging is by the grip, so the tile's own link, menu and
 * name field keep their clicks; the grip also takes the keyboard (Space, then
 * arrows).
 */
export function SceneSortList({
  projectId,
  groups,
  vertical,
  disabled,
}: {
  projectId: string;
  groups: readonly SceneSortGroup[];
  vertical: boolean;
  /** Read-only viewer: no grips, no drag. */
  disabled: boolean;
}): JSX.Element {
  const serverOrder = groups.map((group) => group.id).join(",");
  // The dragged order shows at once; the server's order replaces it whenever
  // the server sends a different one (the save landing, or a new scene).
  const [order, setOrder] = useState<string[]>(() => groups.map((group) => group.id));
  const [syncedTo, setSyncedTo] = useState(serverOrder);
  if (serverOrder !== syncedTo) {
    setSyncedTo(serverOrder);
    setOrder(groups.map((group) => group.id));
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byId = new Map(groups.map((group) => [group.id, group]));
  const shown = order.filter((id) => byId.has(id));

  function handleDragEnd({ active, over }: DragEndEvent): void {
    if (!over || active.id === over.id) return;
    const from = shown.indexOf(String(active.id));
    const to = shown.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const previous = shown;
    const next = arrayMove(shown, from, to);
    setOrder(next);
    reorderStudioScenes(projectId, next).then(
      (result) => {
        if (result?.error) {
          toast.error(result.error);
          setOrder(previous);
        }
      },
      () => {
        toast.error("The new order did not save.");
        setOrder(previous);
      },
    );
  }

  const sortable = !disabled && shown.length > 1;

  return (
    // A fixed id: dnd-kit's generated one differs between server and client.
    <DndContext
      id="scene-sort-list"
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={shown}
        strategy={vertical ? verticalListSortingStrategy : horizontalListSortingStrategy}
        disabled={!sortable}
      >
        {shown.map((id) => {
          const group = byId.get(id)!;
          return (
            <SortableGroup key={id} id={id} label={group.label} vertical={vertical} grip={sortable}>
              {group.node}
            </SortableGroup>
          );
        })}
      </SortableContext>
    </DndContext>
  );
}

function SortableGroup({
  id,
  label,
  vertical,
  grip,
  children,
}: {
  id: string;
  label: string;
  vertical: boolean;
  grip: boolean;
  children: ReactNode;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "relative flex shrink-0 gap-2",
        vertical && "flex-col",
        isDragging && "z-10 opacity-80",
      )}
    >
      {grip ? (
        <button
          type="button"
          aria-label={`Drag ${label} to reorder`}
          title="Drag to reorder"
          // touch-none: without it a touch drag scrolls the strip instead.
          className="absolute left-2.5 top-2.5 z-10 grid size-6 cursor-grab touch-none place-items-center rounded-sm bg-background/80 text-foreground backdrop-blur-sm outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
      {children}
    </div>
  );
}
