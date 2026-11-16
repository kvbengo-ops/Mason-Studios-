"use client";

import { useRef, useState, type JSX } from "react";
import { PencilIcon } from "lucide-react";
import { updateElement } from "@/actions/elements";
import type { ElementTag } from "@/lib/elements";

/**
 * A reference chip's "@tag", renamable in place: click it, type, Enter (or
 * click away) saves through updateElement — the same rename the Elements
 * Library makes, which also rewrites the tag in the owner's saved prompts.
 * The bar then swaps the tag in its own draft via `onRenamed`.
 */
export function TagRenameLabel({
  tag,
  element,
  projectId,
  disabled = false,
  onRenamed,
  onError,
}: {
  tag: string;
  /** The element behind the tag; without one there is nothing to rename. */
  element: ElementTag | undefined;
  projectId: string | null;
  disabled?: boolean;
  onRenamed: (from: string, to: string) => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tag);
  const [saving, setSaving] = useState(false);
  // Enter saves and the input then unmounts, which can also blur it: one save.
  const busy = useRef(false);

  if (!element || disabled) {
    return <span className="max-w-[9rem] truncate font-medium">@{tag}</span>;
  }
  const current = element;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(current.name);
          setEditing(true);
        }}
        title={`Rename @${tag}`}
        aria-label={`Rename @${tag}`}
        className="group/rename inline-flex max-w-[9rem] items-center gap-1 rounded-sm font-medium hover:underline"
      >
        <span className="truncate">@{tag}</span>
        <PencilIcon
          aria-hidden="true"
          className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover/rename:opacity-100"
        />
      </button>
    );
  }

  async function save(): Promise<void> {
    if (busy.current) return;
    const name = draft.trim().replace(/^@+/, "");
    if (!name || name === current.name) {
      setEditing(false);
      return;
    }
    busy.current = true;
    setSaving(true);
    const formData = new FormData();
    if (projectId) formData.set("projectId", projectId);
    formData.set("elementId", current.id);
    formData.set("name", name);
    // updateElement writes all three; resend the ones this does not change.
    formData.set("category", current.category);
    formData.set("description", current.description ?? "");
    try {
      const result = await updateElement(formData);
      if (result && "error" in result && result.error) {
        onError(result.error);
        return;
      }
      onRenamed(current.name, name);
      setEditing(false);
    } catch {
      onError(`Could not rename @${current.name}. Try again.`);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <input
      autoFocus
      value={draft}
      disabled={saving}
      aria-label={`New tag for @${tag}`}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        // Enter inside the bar's <form> would otherwise submit it — Generate.
        if (event.key === "Enter") {
          event.preventDefault();
          void save();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setEditing(false);
        }
      }}
      onBlur={() => void save()}
      className="h-6 w-28 rounded-sm border bg-background px-1 text-xs font-medium"
    />
  );
}
