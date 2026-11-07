"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import { registerElement } from "@/actions/elements";
import { uploadDescribeEstimateUsd } from "@/lib/element-describe-cost";
import { stageFiles } from "@/lib/stage-files";
import { checkElementUploadName } from "@/actions/check-element-upload-name";
import { ElementTagNameField } from "@/components/element-tag-name-field";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUploadProgressSetter } from "@/components/upload-progress-store";
import {
  formatFileSizeMB,
  isAcceptedReferenceImage,
  isAcceptedReferenceImageSize,
  isAcceptedReferenceAudio,
  isAcceptedReferenceAudioSize,
  isAcceptedReferenceVideo,
  isAcceptedReferenceVideoSize,
} from "@/lib/file-type";

type UploadRow = {
  id: string;
  file: File;
  name: string;
  status: "ready" | "uploading" | "saved" | "error";
  error?: string;
  duration?: number;
};

function FilePreview({
  file,
  onDuration,
}: {
  file: File;
  onDuration: (seconds: number) => void;
}): JSX.Element {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => {
    return () => URL.revokeObjectURL(url);
  }, [url]);
  if (isAcceptedReferenceAudio(file)) return <audio controls src={url} className="w-full" />;
  if (isAcceptedReferenceVideo(file))
    return (
      <video
        controls
        preload="metadata"
        src={url}
        className="max-h-32 w-full"
        onLoadedMetadata={(event) => onDuration(event.currentTarget.duration)}
      />
    );
  return <img src={url} alt={file.name} className="h-28 w-full rounded-md object-contain" />;
}

export function ElementBatchUploadDialog(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [destination, setDestination] = useState<"shared" | "mine">("shared");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const setProgress = useUploadProgressSetter();
  const remaining = rows.filter((row) => row.status !== "saved");

  function patch(id: string, values: Partial<UploadRow>): void {
    setRows((old) => old.map((row) => (row.id === id ? { ...row, ...values } : row)));
  }

  function addFiles(files: File[]): void {
    if (busyRef.current) return;
    const accepted = files.filter((file) => {
      const valid = isAcceptedReferenceImage(file)
        ? isAcceptedReferenceImageSize(file)
        : isAcceptedReferenceAudio(file)
          ? isAcceptedReferenceAudioSize(file)
          : isAcceptedReferenceVideo(file) && isAcceptedReferenceVideoSize(file);
      if (!valid) toast.error(`${file.name}: unsupported file or file too large.`);
      return valid;
    });
    setRows((old) => {
      const identity = (file: File): string => `${file.name}:${file.size}:${file.lastModified}`;
      const seen = new Set(old.map((row) => identity(row.file)));
      const additions: UploadRow[] = [];
      for (const file of accepted) {
        if (seen.has(identity(file))) continue;
        seen.add(identity(file));
        const name = file.name
          .replace(/\.[^.]+$/, "")
          .replace(/[^A-Za-z0-9_-]/g, "_")
          .replace(/^[^A-Za-z0-9]+/, "")
          .slice(0, 64);
        additions.push({ id: crypto.randomUUID(), file, name, status: "ready" });
      }
      return [...old, ...additions];
    });
  }

  async function uploadAll(): Promise<void> {
    if (busyRef.current || remaining.length === 0) return;
    busyRef.current = true;
    setBusy(true);
    const batch = remaining;
    try {
      // Check the entire batch before any file is transferred or described.
      const names = batch.map((row) => row.name.trim().toLowerCase());
      const errors = await Promise.all(
        batch.map(async (row, index) => {
          if (names.some((name, other) => other !== index && name === names[index])) {
            return "This tag is used by another file in this batch. Rename one of them.";
          }
          try {
            return await checkElementUploadName(row.name, destination === "shared");
          } catch (error) {
            unstable_rethrow(error);
            return "Could not check this tag. Try again.";
          }
        }),
      );
      batch.forEach((row, index) =>
        patch(row.id, {
          error: errors[index] ?? undefined,
          status: errors[index] ? "error" : "ready",
        }),
      );
      if (errors.some(Boolean)) {
        toast.error("Fix the highlighted tags before uploading.");
        return;
      }
      const estimate = batch.reduce(
        (total, row) => total + uploadDescribeEstimateUsd(row.file),
        0,
      );
      if (
        !window.confirm(
          `Upload and describe ${batch.length} element${batch.length === 1 ? "" : "s"}? Estimated description cost: $${estimate.toFixed(4)}. Voice and video retries may cost more.`,
        )
      ) return;
      let saved = 0;
      setProgress({ done: 0, total: batch.length });
      for (const [index, row] of batch.entries()) {
        patch(row.id, { status: "uploading", error: undefined });
        const formData = new FormData();
        formData.set("name", row.name.trim());
        formData.set("destination", destination);
        formData.set("image", row.file);
        if (row.duration && Number.isFinite(row.duration))
          formData.set("durationS", String(row.duration));
        try {
          await stageFiles(formData);
          const result = await registerElement(formData);
          if (result?.error) patch(row.id, { status: "error", error: result.error });
          else {
            saved += 1;
            patch(row.id, { status: "saved", error: undefined });
            if (result?.notice) toast(result.notice);
          }
        } catch (error) {
          unstable_rethrow(error);
          patch(row.id, { status: "error", error: "Upload failed. You can retry this file." });
        }
        setProgress({ done: index + 1, total: batch.length });
      }
      toast(
        `${saved} of ${batch.length} elements uploaded to ${destination === "shared" ? "Shared" : "Mine"}.`,
      );
    } finally {
      setRows((current) => current.filter((row) => row.status !== "saved"));
      if (inputRef.current) inputRef.current.value = "";
      setProgress(null);
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Upload elements
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Upload elements</DialogTitle>
            <DialogDescription>
              Add multiple product files, review each preview, and rename or check their tags.
              Upload all when ready.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex min-h-0 flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void uploadAll();
            }}
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/wav,.mp3,.wav,video/mp4,.mp4"
              className="sr-only"
              aria-label="Choose product files"
              disabled={busy}
              onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <div className="space-y-2">
              <Label htmlFor="element-upload-destination">Save to</Label>
              <select
                id="element-upload-destination"
                value={destination}
                onChange={(event) => setDestination(event.target.value === "mine" ? "mine" : "shared")}
                disabled={busy}
                className="w-full rounded-md border bg-background p-2 text-sm text-foreground"
              >
                <option value="shared">Shared</option>
                <option value="mine">Mine</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Mine stays private and appears under the Mine filter.
              </p>
            </div>
            <div
              className="rounded-lg border border-dashed p-5 text-center"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                addFiles(Array.from(event.dataTransfer.files));
              }}
            >
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
              >
                Add files
              </Button>
              <p className="mt-2 text-sm text-muted-foreground">
                Select several files at once, or drop them here. Nothing uploads yet.
              </p>
            </div>
            <div className="min-h-0 space-y-3 overflow-y-auto">
              {rows.map((row) => (
                <div
                  key={row.id}
                  className="grid gap-4 rounded-lg border p-4 sm:grid-cols-[140px_1fr_auto]"
                >
                  <FilePreview
                    file={row.file}
                    onDuration={(duration) => patch(row.id, { duration })}
                  />
                  <div className="min-w-0 space-y-2">
                    <p className="truncate text-sm" title={row.file.name}>
                      {row.file.name}{" "}
                      <span className="text-muted-foreground">
                        ({formatFileSizeMB(row.file.size)})
                      </span>
                    </p>
                    <ElementTagNameField
                      label={`Tag for ${row.file.name}`}
                      value={row.name}
                      shared={destination === "shared"}
                      disabled={busy || row.status === "saved"}
                      onChange={(name) =>
                        patch(row.id, { name, error: undefined, status: "ready" })
                      }
                    />
                    {row.error ? (
                      <p role="alert" className="text-sm text-destructive">
                        {row.error}
                      </p>
                    ) : null}
                    {row.status === "saved" ? (
                      <p className="text-sm text-green-700">
                        Saved to {destination === "shared" ? "Shared" : "Mine"}
                      </p>
                    ) : null}
                    {row.status === "uploading" ? (
                      <p role="status" className="text-sm">
                        Uploading...
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setRows((old) => old.filter((item) => item.id !== row.id))}
                    aria-label={`Remove ${row.file.name} from batch`}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-3 border-t pt-4">
              <p className="text-sm text-muted-foreground">
                {remaining.length} files ready to upload
              </p>
              <PendingButton type="submit" pending={busy} disabled={remaining.length === 0}>
                Upload all
              </PendingButton>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
