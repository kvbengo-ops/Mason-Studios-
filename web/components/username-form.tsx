import type { JSX } from "react";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateUsername } from "@/actions/profile";
import { MIN_USERNAME_LENGTH, MAX_USERNAME_LENGTH } from "@/lib/signup-username";

// Plain Server Component, same reasoning avatar-upload.tsx gives its own —
// ActionForm already surfaces updateUsername's returned ActionResult as a
// toast (a duplicate-username collision, lib/action-result.ts's whole
// reason to exist for actions/profile.ts's updateUsername), so there is no
// local state this component needs to hold itself.
export function UsernameForm({ username }: { username: string }): JSX.Element {
  return (
    <ActionForm action={updateUsername} fallbackErrorMessage="Failed to update username.">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="profile-username">Username</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="profile-username"
            name="username"
            defaultValue={username}
            minLength={MIN_USERNAME_LENGTH}
            maxLength={MAX_USERNAME_LENGTH}
            pattern="[A-Za-z0-9_]+"
            required
            className="max-w-xs"
          />
          <SubmitButton variant="outline" size="sm" pendingLabel="Saving…">
            Save
          </SubmitButton>
        </div>
        <p className="text-xs text-muted-foreground">
          {MIN_USERNAME_LENGTH}-{MAX_USERNAME_LENGTH} characters — letters, numbers, and underscores
          only.
        </p>
      </div>
    </ActionForm>
  );
}
