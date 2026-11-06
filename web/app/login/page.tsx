"use client";

import { useState, useTransition } from "react";
import type { JSX } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { unstable_rethrow } from "next/navigation";
import { signIn } from "@/actions/auth";
import type { SignInResult } from "@/actions/auth";
import { loginFormSchema } from "@/lib/login-schema";
import type { LoginFormValues } from "@/lib/login-schema";
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

export default function LoginPage(): JSX.Element {
  const [state, setState] = useState<SignInResult>(undefined);
  const [isPending, startTransition] = useTransition();

  // zodResolver(loginFormSchema) is the exact schema signIn re-parses
  // server-side (lib/login-schema.ts) — this only catches "you typed
  // nothing" / "that's not an email" before the round trip; whether the
  // credentials are actually valid is still answered by Supabase.
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    mode: "onBlur",
    reValidateMode: "onBlur",
  });

  const formLevelError = state && "error" in state && !state.field ? state.error : undefined;

  // No native `action={...}` / `useActionState` here on purpose: React 19
  // resets an uncontrolled form once its action-bound submission completes,
  // which was wiping email + password on every failed login. Calling the
  // Server Action from inside handleSubmit's callback, wrapped in a
  // transition, means there is no native submission for React to reset
  // after — the inputs keep whatever the user typed regardless of the
  // result. RHF's handleSubmit already runs the resolver and blocks the
  // callback on failure, so this also replaces the old trigger()/
  // preventDefault hack that existed only to guard the native submit path.
  function onSubmit(values: LoginFormValues): void {
    const formData = new FormData();
    formData.set("email", values.email);
    formData.set("password", values.password);

    startTransition(async () => {
      try {
        const result = await signIn(formData);
        setState(result);
        if (result && "error" in result && result.field) {
          setError(result.field, { type: "server", message: result.error });
        }
      } catch (error) {
        // signIn redirect()s to /create on success — a thrown NEXT_REDIRECT
        // control-flow error, not a failure. unstable_rethrow lets it through
        // to Next's navigation handling; without it, a successful login
        // would be caught here and reported as a failed one, the same bug
        // this pattern already caused once in render-confirm-dialog.tsx.
        unstable_rethrow(error);
        setState({ error: "Invalid email or password." });
      }
    });
  }

  return (
    <div className="flex min-h-svh w-full items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        {/* Card supplies `flex flex-col gap-6`, but this form sits between it
            and the header/content/footer, so that gap lands on a single child
            and the sections render flush against each other. The form has to
            carry the same layout for the spacing to reach them. */}
        <form noValidate onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6">
          <CardHeader>
            <div className="mb-3 flex flex-col items-center gap-2 text-center">
              <MaisonLogo className="h-11 w-16 text-primary" />
              <MaisonWordmark className="text-foreground" />
              <span aria-hidden="true" className="mt-2 h-px w-10 bg-border" />
            </div>
            <CardTitle className="text-center">Sign in</CardTitle>
            <CardDescription className="text-center">
              Enter your email below to sign in to your account
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="email" required>
                  Email
                </Label>
                <Input
                  id="email"
                  type="email"
                  suppressHydrationWarning
                  placeholder="you@example.com"
                  autoComplete="email"
                  aria-invalid={errors.email ? true : undefined}
                  {...register("email")}
                />
                {errors.email ? (
                  <p className="text-sm text-destructive">{errors.email.message}</p>
                ) : null}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password" required>
                  Password
                </Label>
                <Input
                  id="password"
                  type="password"
                  suppressHydrationWarning
                  autoComplete="current-password"
                  aria-invalid={errors.password ? true : undefined}
                  {...register("password")}
                />
                {errors.password ? (
                  <p className="text-sm text-destructive">{errors.password.message}</p>
                ) : null}
              </div>
              {formLevelError ? <p className="text-sm text-destructive">{formLevelError}</p> : null}
            </div>
          </CardContent>
          <CardFooter className="flex-col gap-4">
            <Button type="submit" className="w-full" disabled={isPending} suppressHydrationWarning>
              {isPending ? "Signing in..." : "Sign in"}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              Don&apos;t have an account?{" "}
              <Link href="/signup" className="font-medium underline underline-offset-4">
                Sign up
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
