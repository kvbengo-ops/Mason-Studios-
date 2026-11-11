import type { JSX } from "react";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePassword } from "@/actions/profile";
import { MIN_PASSWORD_LENGTH } from "@/lib/signup-password";

export function ChangePasswordForm(): JSX.Element {
  return (
    <ActionForm action={changePassword} fallbackErrorMessage="Failed to change password.">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-current-password">Current password</Label>
          <Input
            id="profile-current-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            className="max-w-xs"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-new-password">New password</Label>
          <Input
            id="profile-new-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
            className="max-w-xs"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-confirm-password">Confirm new password</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="profile-confirm-password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
              className="max-w-xs"
            />
            <SubmitButton variant="outline" size="sm" pendingLabel="Saving…">
              Change password
            </SubmitButton>
          </div>
          <p className="text-xs text-muted-foreground">
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>
      </div>
    </ActionForm>
  );
}
