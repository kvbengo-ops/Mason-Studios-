"use client";

import { useRef, useState, type JSX } from "react";
import { toast } from "sonner";
import { renameScene } from "@/actions/scene-organize";
import { useAsyncAction } from "@/components/use-async-action";
import { MAX_SCENE_TITLE_CHARS } from "@/lib/scene-position";

/**
 * A scene's name on its strip tile, renamed in place like the project title
 * (ugc-title.tsx). Blank clears it. A read-only viewer sees the name only.
 */
export function SceneTitle({
  sceneId,
  title,
  readOnly = false,
}: {
  sceneId: string;
  title: string | null;
  readOnly?: boolean;
}): JSX.Element | null {
  const current = title ?? "";
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current);
  const inputRef = useRef<HTMLInputElement>(null);
  const { run } = useAsyncAction();

  // Follow the server's value unless the operator is mid-edit.
  const [syncedTo, setSyncedTo] = useState(current);
  if (current !== syncedTo) {
    setSyncedTo(current);
    if (!editing) setValue(current);
  }

  function commit(): void {
    const next = value.trim();
    setEditing(false);
    if (next === current) return;
    run(async () => {
      try {
        const formData = new FormData();
        formData.set("sceneId", sceneId);
        formData.set("title", next);
        const result = await renameScene(formData);
        if (result?.error) {
          toast.error(result.error);
          setValue(current);
        }
      } catch {
        toast.error("Failed to rename the scene.");
        setValue(current);
      }
    });
  }

  if (readOnly) {
    return current ? <span className="truncate text-[11px] font-medium">{current}</span> : null;
  }

  if (!editing) {
    return (
      <button
        type="button"
        title="Rename scene"
        onClick={() => {
          setEditing(true);
          requestAnimationFrame(() => inputRef.current?.select());
        }}
        className="truncate rounded-sm text-left text-[11px] decoration-dotted underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {value ? (
          <span className="font-medium">{value}</span>
        ) : (
          <span className="text-muted-foreground">Name this scene</span>
        )}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      aria-label="Scene name"
      value={value}
      maxLength={MAX_SCENE_TITLE_CHARS}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          setValue(current);
          setEditing(false);
        }
      }}
      className="w-full rounded-sm border-b bg-transparent text-[11px] font-medium outline-none focus:border-foreground"
    />
  );
}
