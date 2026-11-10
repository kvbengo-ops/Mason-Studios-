import type { JSX } from "react";
import { ActionForm } from "@/components/action-form";
import { UploadButton } from "@/components/upload-button";
import { SubmitButton } from "@/components/submit-button";
import { uploadAvatar, removeAvatar } from "@/actions/profile";

// Stays a plain Server Component, same reasoning components/sidebar-
// budget.tsx gives for its own "no 'use client'": nothing here holds local
// state — ActionForm/UploadButton/SubmitButton are already Client
// Components and read pending state via useFormStatus() themselves, and
// the two Server Actions (uploadAvatar, removeAvatar) cross the server ->
// client boundary as React-serialised function references, not plain
// closures — the one thing that boundary actually forbids (see action-
// form.tsx's own header).
export function AvatarUpload({
  avatarUrl,
}: {
  /** Signed URL for the current avatar (lib/storage.ts's getImageUrl, "thumb" copy), or null if none is set. */
  avatarUrl: string | null;
}): JSX.Element {
  return (
    <div className="flex items-center gap-4">
      {avatarUrl ? (
         
        // expire and are never a static/optimizable asset next/image could
        // help with (see next.config.ts's own note on why this app doesn't
        // use next/image at all).
        <img
          src={avatarUrl}
          alt=""
          width={64}
          height={64}
          className="size-16 rounded-full border border-border object-cover"
        />
      ) : (
        <div className="flex size-16 items-center justify-center rounded-full border border-dashed border-border bg-muted text-xs text-muted-foreground">
          No photo
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <ActionForm action={uploadAvatar} fallbackErrorMessage="Failed to upload avatar.">
          <UploadButton name="file" variant="outline" size="sm" pendingLabel="Uploading…">
            {avatarUrl ? "Replace photo" : "Upload photo"}
          </UploadButton>
        </ActionForm>

        {avatarUrl ? (
          <ActionForm action={removeAvatar} fallbackErrorMessage="Failed to remove avatar.">
            <SubmitButton variant="ghost" size="sm" pendingLabel="Removing…">
              Remove
            </SubmitButton>
          </ActionForm>
        ) : null}
      </div>
    </div>
  );
}
