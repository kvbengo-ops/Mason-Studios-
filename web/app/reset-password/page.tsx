import type { JSX } from "react";
import { resetPassword } from "@/actions/auth";
import { MIN_PASSWORD_LENGTH } from "@/lib/signup-password";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MaisonLogo, MaisonWordmark } from "@/components/maison-logo";

// Outside (app) so a pending account can reset its password too — (app)'s
// layout calls requireUser(), which redirects pending accounts to /pending.
export default function ResetPasswordPage(): JSX.Element {
  return (
    <div className="flex min-h-svh w-full items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <ActionForm
          action={resetPassword}
          fallbackErrorMessage="Failed to reset password."
          className="flex flex-col gap-6"
        >
          <CardHeader>
            <div className="mb-3 flex flex-col items-center gap-2 text-center">
              <MaisonLogo className="h-11 w-16 text-primary" />
              <MaisonWordmark className="text-foreground" />
              <span aria-hidden="true" className="mt-2 h-px w-10 bg-border" />
            </div>
            <CardTitle className="text-center">Reset password</CardTitle>
            <CardDescription className="text-center">
              Enter a new password for your account
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="password" required>
                  New password
                </Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="confirmPassword" required>
                  Confirm password
                </Label>
                <Input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  required
                />
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <SubmitButton className="w-full" pendingLabel="Saving…">
              Reset password
            </SubmitButton>
          </CardFooter>
        </ActionForm>
      </Card>
    </div>
  );
}
