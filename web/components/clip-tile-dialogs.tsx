"use client";

// The two dialogs behind /create's clip tile buttons: Save to elements and
// Add to project. Share needs none — it copies a link (create-clip-wall.tsx).

import { useState } from "react";
import type { JSX } from "react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { toast } from "sonner";
import { moveClipToProject } from "@/actions/clip-actions";
import { registerElement } from "@/actions/elements";
import { ElementTagNameField } from "@/components/element-tag-name-field";
import { PendingButton } from "@/components/pending-button";
import { Label } from "@/components/ui/label";
import { useAsyncAction } from "@/components/use-async-action";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MAX_REFERENCE_VIDEO_BYTES, formatFileSizeMB } from "@/lib/file-type";
import { stageFiles } from "@/lib/stage-files";

/** A clip project a take can move into. */
export interface ClipProjectOption {
  id: string;
  title: string;
}

interface ClipRef {
  key: string;
  sceneId: string;
  projectId: string;
  url: string;
  filename: string;
  durationS: number | null;
}

/**
 * Saves a take as an @video element through registerElement — the same path
 * an uploaded video takes, so its size limit, describe pass and caps apply.
 */
export function SaveClipDialog({
  item,
  open,
  onClose,
}: {
  item: ClipRef;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { pending, run } = useAsyncAction();

  function save(): void {
    run(async () => {
      setError(null);
      try {
        const blob = await (await fetch(item.url)).blob();
        // Before the upload, so an oversized clip is not sent only to be refused.
        if (blob.size > MAX_REFERENCE_VIDEO_BYTES) {
          setError(
            `This clip is ${formatFileSizeMB(blob.size)}; video elements are limited to ${formatFileSizeMB(MAX_REFERENCE_VIDEO_BYTES)}.`,
          );
          return;
        }
        const formData = new FormData();
        formData.set("name", name.trim());
        formData.set("image", new File([blob], item.filename, { type: blob.type || "video/mp4" }));
        if (item.durationS) formData.set("durationS", String(item.durationS));
        await stageFiles(formData);
        const result = await registerElement(formData);
        if (result?.error) {
          setError(result.error);
          return;
        }
        toast(`Saved @${name.trim()} to your elements.`);
        onClose();
      } catch (err) {
        unstable_rethrow(err);
        setError("Could not save the clip. Try again.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save clip to elements</DialogTitle>
          <DialogDescription>
            Name the tag. The clip becomes an @video reference in your library.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <ElementTagNameField value={name} onChange={setName} shared={false} disabled={pending} />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <PendingButton type="submit" pending={pending}>
            Save element
          </PendingButton>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Moves the clip (all its takes) into one of the caller's projects, or a new one. */
export function MoveClipDialog({
  item,
  projects,
  open,
  onClose,
}: {
  item: ClipRef;
  projects: readonly ClipProjectOption[];
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const router = useRouter();
  const choices = projects.filter((p) => p.id !== item.projectId);
  const [target, setTarget] = useState(choices[0]?.id ?? "new");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { pending, run } = useAsyncAction();

  function move(): void {
    run(async () => {
      setError(null);
      const formData = new FormData();
      formData.set("sceneId", item.sceneId);
      formData.set("projectId", target);
      formData.set("title", title);
      try {
        const result = await moveClipToProject(formData);
        if (result?.error) {
          setError(result.error);
          return;
        }
        toast("Clip moved.");
        onClose();
        router.refresh();
      } catch (err) {
        unstable_rethrow(err);
        setError("Could not move the clip. Try again.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add clip to a project</DialogTitle>
          <DialogDescription>
            Moves this clip and all its takes. It opens from that project afterwards.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            move();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={`move-target-${item.key}`}>Project</Label>
            <select
              id={`move-target-${item.key}`}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              disabled={pending}
              className="w-full rounded-md border bg-background p-2 text-sm text-foreground"
            >
              {choices.map((p) => (
                <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                  {p.title}
                </option>
              ))}
              <option value="new" className="bg-popover text-popover-foreground">
                New project…
              </option>
            </select>
          </div>
          {target === "new" ? (
            <div className="space-y-2">
              <Label htmlFor={`move-title-${item.key}`}>New project name</Label>
              <input
                id={`move-title-${item.key}`}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
                required
                disabled={pending}
                className="w-full rounded-md border bg-background p-2 text-sm text-foreground"
              />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <PendingButton type="submit" pending={pending}>
            Move clip
          </PendingButton>
        </form>
      </DialogContent>
    </Dialog>
  );
}
