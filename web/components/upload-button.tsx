"use client";

// Collapses the old two-step "choose file, then click Upload" flow into one
// click: the visible control is just a button, and clicking it delegates to
// a visually-hidden <input type="file"> via a ref. Picking a file in the OS
// dialog fires the input's onChange, which submits the surrounding form
// immediately — no second click. Must live inside an ActionForm's <form> (see
// components/action-form.tsx) since it drives that form via requestSubmit()
// and reads pending state via useFormStatus().
//
// The input is `sr-only`, not `hidden`/`display:none` on a wrapper — it must
// stay a real, rendered form control so the browser includes it in the
// form's FormData on submit. Only its *visibility* is hidden.

import { useEffect, useRef } from "react";
import { Spinner } from "@/components/spinner";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";
import type { ChangeEvent, ComponentProps, JSX, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ShimmerText } from "@/components/shimmer-text";
import {
  MAX_REFERENCE_IMAGE_BYTES,
  formatFileSizeMB,
  isAcceptedReferenceImageSize,
} from "@/lib/file-type";

export interface UploadButtonProps extends Omit<
  ComponentProps<typeof Button>,
  "type" | "disabled" | "onClick" | "children"
> {
  /** `name` of the file field the server action reads via `formData.get(...)`. */
  name: string;
  accept?: string;
  /** Label shown while the form's action is in flight. */
  pendingLabel: ReactNode;
  children: ReactNode;
}

export function UploadButton({
  name,
  // The three accepted reference formats, not `image/*`. A GIF picked here
  // used to sail past the picker and get stored — one is still sitting in
  // the database from before the server-side check existed — and an animated
  // reference is not something the image model handles sensibly. The file
  // dialog should not offer what the server will refuse.
  accept = "image/jpeg,image/png,image/webp",
  pendingLabel,
  children,
  ...buttonProps
}: UploadButtonProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks the previous `pending` value so the effect below can detect the
  // true -> false edge (submission just settled) rather than firing on
  // every render.
  const wasPending = useRef(false);
  const { pending } = useFormStatus();

  useEffect(() => {
    if (wasPending.current && !pending && inputRef.current) {
      // Browsers don't fire `onChange` again for an identical file
      // selection — the input's value has to be cleared after a submit
      // completes (success or error) so re-picking the same file still
      // triggers the auto-submit next time.
      inputRef.current.value = "";
    }
    wasPending.current = pending;
  }, [pending]);

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }

    // Refuse here rather than let the submit go out. Next rejects a Server
    // Action body over its configured limit before any of our code runs, so
    // an oversized file comes back as a bare 413 with nothing we wrote in
    // it — that is exactly the failure that reached production on the
    // character reference upload. The client is the only place this can be
    // said in words.
    if (!isAcceptedReferenceImageSize(file)) {
      toast.error(
        `That image is ${formatFileSizeMB(file.size)} — the limit is ` +
          `${formatFileSizeMB(MAX_REFERENCE_IMAGE_BYTES)}. Resize it and try again.`,
      );
      event.currentTarget.value = "";
      return;
    }

    event.currentTarget.form?.requestSubmit();
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        name={name}
        accept={accept}
        onChange={handleChange}
        disabled={pending}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
      />
      <Button
        type="button"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
        {...buttonProps}
      >
        {pending ? (
          <span className="inline-flex items-center gap-2">
            {/* The GitHub Actions ring, same as submit-button.tsx and
                pending-button.tsx — never dots. This app also draws three
                dots for "nothing here yet", so on an upload that can run
                for several seconds, "working" and "empty" were wearing the
                same clothes. currentColor, so the ring picks up whatever
                text colour the button's variant already uses. */}
            <Spinner />
            {/* pendingLabel is typed ReactNode (callers may pass more than
                plain text, in principle), but ShimmerText needs a string
                for its sr-only duplicate — shimmer only when it's actually
                text, otherwise fall back to rendering it as before. Every
                current call site passes a plain string. */}
            {typeof pendingLabel === "string" ? <ShimmerText label={pendingLabel} /> : pendingLabel}
          </span>
        ) : (
          children
        )}
      </Button>
    </>
  );
}
