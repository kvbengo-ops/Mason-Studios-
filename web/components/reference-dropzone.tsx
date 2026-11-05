"use client";

// Spec §3.1's Reference Image control: "Drop reference photo or browse."
// Drag-and-drop is the only thing this adds over components/upload-button.tsx
// — it still must live inside an ActionForm's <form> and drive that form via
// requestSubmit(), the same contract UploadButton uses, so the existing
// uploadCharacterRef server action (actions/character.ts) stays the only
// place a character reference photo actually gets persisted. What happens
// after a file is chosen is unchanged; only how a file gets chosen changes.

import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/spinner";
import { useFormStatus } from "react-dom";
import type { ChangeEvent, DragEvent, JSX } from "react";
import { toast } from "sonner";
import {
  formatFileSizeMB,
  isAcceptedReferenceAudio,
  isAcceptedReferenceAudioSize,
  isAcceptedReferenceImage,
  isAcceptedReferenceImageSize,
  isAcceptedReferenceVideo,
  isAcceptedReferenceVideoSize,
  MAX_REFERENCE_AUDIO_BYTES,
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_VIDEO_BYTES,
} from "@/lib/file-type";
import { cn } from "@/lib/utils";
import { ShimmerText } from "@/components/shimmer-text";

/** Accepted MIME/extension list, matching ugc-reference-picker.tsx's own. */
const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";
const AUDIO_ACCEPT = "audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave,.mp3,.wav";
const VIDEO_ACCEPT = "video/mp4,.mp4";

/** The three things this control can be pointed at. See `acceptKinds` below. */
export type ReferenceKind = "image" | "audio" | "video";

/**
 * detectKind's answer for one dropped/picked file, or undefined when it
 * matches none of `kinds`. Order is irrelevant for correctness — the three
 * predicates key off disjoint MIME/extension sets — this just has to check
 * every kind the caller actually admits.
 */
function detectKind(file: File, kinds: ReadonlySet<ReferenceKind>): ReferenceKind | undefined {
  if (kinds.has("audio") && isAcceptedReferenceAudio(file)) return "audio";
  if (kinds.has("video") && isAcceptedReferenceVideo(file)) return "video";
  if (kinds.has("image") && isAcceptedReferenceImage(file)) return "image";
  return undefined;
}

/**
 * Exactly the two combinations any caller passes today. Kept as explicit
 * sentences rather than a grammar built out of the pieces: `acceptKinds`'s
 * every real caller is either a single image-only uploader or the full
 * image+audio+video one, and hand-writing both keeps the copy the
 * image-only callers already show byte-for-byte identical to what it was
 * before this was a set.
 */
function buildRejectMessage(kinds: readonly ReferenceKind[]): string {
  if (kinds.length === 1 && kinds[0] === "image") {
    return "Reference photo must be a JPG, PNG, or WebP file.";
  }
  if (kinds.includes("video")) {
    return "A reference must be a JPG, PNG or WebP picture, an MP3 or WAV voice clip, or an MP4 video.";
  }
  return "A reference must be a JPG, PNG or WebP picture, or an MP3 or WAV voice clip.";
}

function buildDropLabel(kinds: readonly ReferenceKind[]): string {
  if (kinds.length === 1 && kinds[0] === "image") {
    return "Drop reference photo or browse";
  }
  if (kinds.includes("video")) {
    return "Drop a picture, voice clip, or video, or browse";
  }
  return "Drop a picture or voice clip, or browse";
}

function buildExtLabel(kinds: readonly ReferenceKind[]): string {
  if (kinds.length === 1 && kinds[0] === "image") {
    return "JPG, PNG, WebP";
  }
  if (kinds.includes("video")) {
    return "JPG, PNG, WebP · MP3, WAV · MP4";
  }
  return "JPG, PNG, WebP · MP3, WAV";
}

export function ReferenceDropzone({
  name,
  disabled,
  acceptKinds = ["image"],
}: {
  /** `name` of the file field the server action reads via `formData.get(...)`. */
  name: string;
  /** The page's `locked` guard — distinct from `pending`, which only covers
   *  an in-flight submission of THIS form. */
  disabled?: boolean;
  /**
   * Which kinds of file this control will take. Used to be `allowAudio?:
   * boolean` — a boolean answered "picture, or picture-and-voice" and had
   * nothing left to say once a third kind (video, 0093) needed admitting
   * too, so this replaced it with the set itself rather than growing a
   * second boolean next to the first.
   *
   * DEFAULTS TO `["image"]`, so the character-reference callers this
   * component was built for (actions/character.ts's uploadCharacterRef /
   * uploadProductRef) keep byte-for-byte the behaviour they have: a
   * non-picture dropped there is still refused by the same message, because
   * those actions store a PICTURE and would have no idea what to do with
   * anything else.
   */
  acceptKinds?: readonly ReferenceKind[];
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const wasPending = useRef(false);
  const { pending } = useFormStatus();
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    // Same reset UploadButton does: clear the input after a submit settles
    // so re-dropping/re-picking the same file still fires a change next
    // time (the browser won't emit one for an identical selection).
    if (wasPending.current && !pending && inputRef.current) {
      inputRef.current.value = "";
    }
    wasPending.current = pending;
  }, [pending]);

  const inert = disabled || pending;
  const kindSet = new Set(acceptKinds);

  function submitFile(file: File | undefined): void {
    if (!file || inert || !inputRef.current) {
      return;
    }
    // The `accept` attribute filters the OS file picker but does nothing
    // for a drag-and-drop payload, so both paths funnel through the same
    // check here rather than trusting the browser to have already filtered.
    const kind = detectKind(file, kindSet);
    if (!kind) {
      toast.error(buildRejectMessage(acceptKinds));
      return;
    }
    // Checked before the file ever leaves the browser: Next's Server Action
    // body limit (next.config.ts) rejects an oversized request outright,
    // before uploadCharacterRef/uploadProductRef run at all, so there is no
    // server-returned ActionResult to display for that case — this client
    // check is the only place that failure can be turned into a message
    // naming the actual limit instead of a redacted React error.
    const sizeOk =
      kind === "audio"
        ? isAcceptedReferenceAudioSize(file)
        : kind === "video"
          ? isAcceptedReferenceVideoSize(file)
          : isAcceptedReferenceImageSize(file);
    if (!sizeOk) {
      const limit =
        kind === "audio"
          ? MAX_REFERENCE_AUDIO_BYTES
          : kind === "video"
            ? MAX_REFERENCE_VIDEO_BYTES
            : MAX_REFERENCE_IMAGE_BYTES;
      const subject =
        kind === "audio" ? "That clip" : kind === "video" ? "That video" : "Reference photo";
      toast.error(
        `${subject} is ${formatFileSizeMB(file.size)} — the limit is ${formatFileSizeMB(limit)}.`,
      );
      return;
    }
    const transfer = new DataTransfer();
    transfer.items.add(file);
    inputRef.current.files = transfer.files;
    inputRef.current.form?.requestSubmit();
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    submitFile(event.currentTarget.files?.[0]);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragActive(false);
    submitFile(event.dataTransfer.files?.[0]);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    if (!inert) {
      setDragActive(true);
    }
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragActive(false)}
      onClick={() => !inert && inputRef.current?.click()}
      role="button"
      tabIndex={inert ? -1 : 0}
      aria-disabled={inert}
      onKeyDown={(event) => {
        if (!inert && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-1 rounded-md border border-dashed p-8 text-center transition-colors",
        inert
          ? "cursor-not-allowed border-border bg-muted/30 opacity-60"
          : "cursor-pointer border-border hover:bg-muted/40",
        dragActive && !inert && "border-primary bg-primary/5",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        name={name}
        accept={acceptKinds
          .map((kind) =>
            kind === "image" ? IMAGE_ACCEPT : kind === "audio" ? AUDIO_ACCEPT : VIDEO_ACCEPT,
          )
          .join(",")}
        onChange={handleChange}
        disabled={inert}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
      />
      {pending ? (
        // A multi-megabyte phone photo over a slow connection can take
        // several seconds to upload — a text label alone reads as "nothing
        // happened" at that size. The ring makes the in-flight state
        // legible at a glance, not just to someone reading the copy.
        <div className="flex flex-col items-center gap-2">
          {/* The GitHub Actions ring, not dots — the one in-flight
              treatment this app draws (submit-button.tsx,
              pending-button.tsx, status-icon.tsx). Dots were ambiguous
              here: this app also draws them for "nothing here yet", which
              is exactly what an empty dropzone otherwise looks like.
              Unguarded by motion-safe:, same reasoning as status-icon.tsx:
              under reduced motion this is the only thing distinguishing
              WORKING from a dead control. */}
          <Spinner className="size-5 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            <ShimmerText label="Uploading…" />
          </p>
        </div>
      ) : (
        <p className="text-sm font-medium text-foreground">{buildDropLabel(acceptKinds)}</p>
      )}
      <p className="text-xs text-muted-foreground">{buildExtLabel(acceptKinds)}</p>
    </div>
  );
}
