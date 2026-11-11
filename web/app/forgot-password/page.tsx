"use client";

import { useState, useTransition } from "react";
import type { JSX } from "react";
import Link from "next/link";
import { requestPasswordReset } from "@/actions/auth";
import type { PasswordResetRequestResult } from "@/actions/auth";
import { Button } from "@/components/ui/button";
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

export default function ForgotPasswordPage(): JSX.Element {
  const [state, setState] = useState<PasswordResetRequestResult>(undefined);
  const [email, setEmail] = useState("");
  const [isPending, startTransition] = useTransition();

  const errorMessage = state && "error" in state ? state.error : undefined;
  const sent = Boolean(state && "sent" in state && state.sent);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const formData = new FormData();
    formData.set("email", email);

    startTransition(async () => {
      const result = await requestPasswordReset(formData);
      setState(result);
    });
  }

  return (
    <div className="flex min-h-svh w-full items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-6">
          <CardHeader>
            <div className="mb-3 flex flex-col items-center gap-2 text-center">
              <MaisonLogo className="h-11 w-16 text-primary" />
              <MaisonWordmark className="text-foreground" />
              <span aria-hidden="true" className="mt-2 h-px w-10 bg-border" />
            </div>
            <CardTitle className="text-center">Forgot password</CardTitle>
            <CardDescription className="text-center">
              Enter your email address to receive a password reset link
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sent ? (
              <p className="text-center text-sm text-foreground">
                If an account exists, we sent a link.
              </p>
            ) : (
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="email" required>
                    Email
                  </Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    aria-invalid={errorMessage ? true : undefined}
                    required
                  />
                  {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
                </div>
              </div>
            )}
          </CardContent>
          <CardFooter className="flex-col gap-4">
            {!sent ? (
              <Button type="submit" className="w-full" disabled={isPending}>
                {isPending ? "Sending..." : "Send reset link"}
              </Button>
            ) : null}
            <p className="text-center text-sm text-muted-foreground">
              <Link href="/login" className="font-medium underline underline-offset-4">
                Back to sign in
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
