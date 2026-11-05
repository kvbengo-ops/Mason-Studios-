"use client";

// "Report a problem" — the operator's own channel into the issue tracker.
//
// THE FAILURE PATH IS THE FEATURE. A dialog that loses what somebody typed
// when the submit fails is worse than no dialog: they wrote it once, they
// will not write it twice, and the thing they were trying to tell us is gone
// along with their willingness to try. So nothing here clears the fields
// except a report that actually landed.

import { useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { MessageSquareWarningIcon } from "lucide-react";
import { submitIssue, uploadIssueImage } from "@/actions/report-issue";
import { stageFiles } from "@/lib/stage-files";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/spinner";
import { cn } from "@/lib/utils";
import type { JSX } from "react";

export function ReportIssueDialog({ collapsed }: { collapsed: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ url?: string; number?: number } | null>(null);
  // How many pastes/drops are mid-upload — the send button waits for this
  // to hit zero so a report can't go out with a placeholder still in it.
  const [uploading, setUploading] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The page they were on when it went wrong, which the action cannot see
  // for itself — a Server Action has no idea which route called it.
  const pathname = usePathname();

  // GitHub-style paste/drop: insert a placeholder at the cursor immediately
  // (so typing never stalls waiting on a network round trip), then swap it
  // for the real markdown image once the upload comes back. Returns whether
  // any image files were found, so the caller knows whether to preventDefault.
  function insertImages(files: File[]): boolean {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return false;

    const textarea = textareaRef.current;
    const placeholders = images.map((file) => {
      const name = file.name || "image";
      return { file, placeholder: `![Uploading ${name}… ${Math.random().toString(36).slice(2, 8)}]()` };
    });

    const insertText = placeholders.map((p) => p.placeholder).join("\n");
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      setDescription((d) => d.slice(0, start) + insertText + d.slice(end));
    } else {
      setDescription((d) => (d ? `${d}\n${insertText}` : insertText));
    }

    for (const { file, placeholder } of placeholders) {
      setUploading((n) => n + 1);
      void (async (): Promise<void> => {
        try {
          const formData = new FormData();
          formData.set("image", file);
          await stageFiles(formData);
          const result = await uploadIssueImage(formData);
          if (result.error || !result.path) {
            setDescription((d) => d.replace(placeholder, ""));
            setError(result.error ?? "Could not upload that image.");
            return;
          }
          // Absolute, since GitHub has to be able to fetch it — a relative
          // path is only meaningful in this browser.
          const url = `${window.location.origin}${result.path}`;
          setDescription((d) => d.replace(placeholder, `![${file.name || "image"}](${url})`));
        } catch (err) {
          setDescription((d) => d.replace(placeholder, ""));
          setError(err instanceof Error ? err.message : "Could not upload that image.");
        } finally {
          setUploading((n) => n - 1);
        }
      })();
    }

    return true;
  }

  const imageUrls = Array.from(description.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)).map(
    (m) => m[1],
  );

  async function send(): Promise<void> {
    if (sending || uploading > 0) return;
    setSending(true);
    setError(null);

    const formData = new FormData();
    formData.set("title", title);
    formData.set("description", description);
    formData.set("route", pathname ?? "");

    try {
      const result = await submitIssue(formData);
      if (result.error) {
        setError(result.error);
        // A duplicate comes back WITH the link to the one already filed,
        // which answers the question the refusal raises.
        if (result.issueUrl) setSent({ url: result.issueUrl });
        return;
      }
      setSent({ url: result.issueUrl, number: result.issueNumber });
      setTitle("");
      setDescription("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the report.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reopening starts clean, but only after a send that worked — a
        // dialog closed by accident mid-report reopens with the words still
        // in it.
        if (!next && sent && !error) {
          setSent(null);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Report a problem"
          title="Report a problem"
          className={cn(
            // THE SAME ROW AS THE THEME TOGGLE, deliberately: two controls
            // sitting in one footer should be one shape, and a lone icon
            // beside a labelled row reads as a different kind of thing.
            "group/feedback inline-flex w-full items-center gap-2 rounded-md p-1.5 text-sidebar-foreground/70 outline-none transition-[background-color,color,transform] duration-200 ease-out hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring motion-safe:hover:translate-x-0.5 motion-safe:active:scale-[0.98] motion-reduce:transition-none",
            // Icon-only at md:w-16 — the control itself never disappears,
            // which is the rule every other footer control here follows.
            collapsed && "md:justify-center",
          )}
        >
          <MessageSquareWarningIcon
            aria-hidden="true"
            className="size-4 shrink-0 transition-transform duration-200 motion-safe:group-hover/feedback:-translate-y-0.5 motion-safe:group-hover/feedback:scale-110 motion-reduce:transition-none"
          />
          <span className={cn("text-sm", collapsed && "md:hidden")}>Feedback</span>
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Report a problem</DialogTitle>
          {/* PLAIN WORDS. "Issue tracker" and "build you are running" are
              our vocabulary, not the operator's — and a person who has just
              hit a bug should not have to parse a sentence before they can
              report it. What they need to know is that it reaches someone
              and that they do not have to explain where they were. */}
          <DialogDescription>
            Tell us what went wrong. We send it to the team, and we add the page you are on for you.
          </DialogDescription>
        </DialogHeader>

        {sent && !error ? (
          <div className="flex flex-col gap-3">
            <p className="rounded-md border border-green-600/30 bg-green-500/10 px-3 py-2 text-sm">
              Sent{sent.number ? ` as #${sent.number}` : ""}. Thank you — someone will look at it.
            </p>
            <div className="flex justify-end gap-2">
              {sent.url ? (
                <Button asChild variant="outline" size="sm">
                  <a href={sent.url} target="_blank" rel="noreferrer">
                    See it
                  </a>
                </Button>
              ) : null}
              <Button size="sm" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="report-title" className="text-xs text-muted-foreground">
                What happened?
              </label>
              <Input
                id="report-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="The Generate button does nothing"
                disabled={sending}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="report-description" className="text-xs text-muted-foreground">
                {/* STILL ASKING FOR THE THREE THINGS — a report missing any
                    one of them costs a round trip to get it — but as a
                    question anyone can answer instead of a list of terms.
                    The example below is what actually teaches the shape. */}
                Tell us more
              </label>
              <textarea
                id="report-description"
                ref={textareaRef}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onPaste={(e) => {
                  if (insertImages(Array.from(e.clipboardData.files))) e.preventDefault();
                }}
                onDrop={(e) => {
                  if (insertImages(Array.from(e.dataTransfer.files))) e.preventDefault();
                }}
                onDragOver={(e) => {
                  if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
                }}
                rows={6}
                disabled={sending}
                placeholder="I picked a voice and pressed Generate. I thought it would make a clip. Nothing happened."
                className="w-full rounded-md border bg-transparent px-3 py-2 text-sm leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
              />
              {imageUrls.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {imageUrls.map((url, i) => (
                    // eslint-disable-next-line @next/next/no-img-element -- signed URL, not a static import
                    <img
                      key={`${url}-${i}`}
                      src={url}
                      alt="Pasted screenshot"
                      className="h-16 rounded-md border object-cover"
                    />
                  ))}
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">Paste or drop screenshots.</p>
            </div>

            {error ? (
              <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
                <p className="text-sm text-destructive">{error}</p>
                {sent?.url ? (
                  <a
                    href={sent.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs underline underline-offset-2"
                  >
                    See the one you sent
                  </a>
                ) : null}
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={sending}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void send()} disabled={sending || uploading > 0}>
                {sending || uploading > 0 ? <Spinner className="size-3.5" /> : null}
                {sending ? "Sending" : uploading > 0 ? "Uploading" : "Send"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
