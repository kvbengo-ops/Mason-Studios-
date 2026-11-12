"use client";

import { useState, type JSX } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { addSceneComment, deleteSceneComment } from "@/actions/scene-organize";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useAsyncAction } from "@/components/use-async-action";
import type { ActionResult } from "@/lib/action-result";
import { dateTimeFormatter } from "@/lib/datetime";
import { MAX_SCENE_COMMENT_CHARS } from "@/lib/scene-position";

export interface SceneComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  /** The viewer wrote it, so they may delete it. */
  mine: boolean;
}

/**
 * The selected scene's comment thread on /ugc/[id] (0142). The project's
 * owner and admins both read and post; anyone deletes only their own.
 */
export function SceneCommentsButton({
  projectId,
  sceneId,
  sceneLabel,
  comments,
}: {
  projectId: string;
  sceneId: string;
  /** "scene 3", for the dialog's title. */
  sceneLabel: string;
  comments: readonly SceneComment[];
}): JSX.Element {
  const [body, setBody] = useState("");
  const { pending, run } = useAsyncAction();

  function submit(
    action: (formData: FormData) => Promise<ActionResult>,
    fields: Record<string, string>,
    onDone?: () => void,
  ): void {
    run(async () => {
      try {
        const formData = new FormData();
        formData.set("projectId", projectId);
        for (const [key, value] of Object.entries(fields)) formData.set(key, value);
        const result = await action(formData);
        if (result?.error) toast.error(result.error);
        else onDone?.();
      } catch {
        toast.error("That did not save. Try again.");
      }
    });
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-background px-2 text-[11px] font-semibold normal-case tracking-normal text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MessageSquare aria-hidden="true" className="size-3" />
          Comments{comments.length > 0 ? ` (${comments.length})` : ""}
        </button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3">
        <DialogTitle className="text-sm font-semibold">Comments on {sceneLabel}</DialogTitle>
        {comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No comments on this scene yet.</p>
        ) : (
          <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {comments.map((comment) => (
              <li key={comment.id} className="flex flex-col gap-1 rounded-xl bg-muted/40 p-3">
                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>
                    <span className="font-medium text-foreground">{comment.author}</span>
                    {" · "}
                    {dateTimeFormatter.format(new Date(comment.createdAt))}
                  </span>
                  {comment.mine ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => submit(deleteSceneComment, { commentId: comment.id })}
                      aria-label="Delete your comment"
                      className="grid size-6 place-items-center rounded-sm hover:bg-accent hover:text-foreground disabled:cursor-not-allowed"
                    >
                      <Trash2 aria-hidden="true" className="size-3" />
                    </button>
                  ) : null}
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {comment.body}
                </p>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!body.trim()) return;
            submit(addSceneComment, { sceneId, body }, () => setBody(""));
          }}
        >
          <label className="sr-only" htmlFor="scene-comment-body">
            Add a comment
          </label>
          <textarea
            id="scene-comment-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={MAX_SCENE_COMMENT_CHARS}
            rows={3}
            placeholder="Add a comment"
            className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            disabled={pending || !body.trim()}
            className="inline-flex h-8 items-center justify-center self-end rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Post
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
