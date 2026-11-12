"use client";

import { useState, useTransition } from "react";
import type { JSX } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { unstable_rethrow } from "next/navigation";
import { signUp } from "@/actions/auth";
import type { SignUpResult } from "@/actions/auth";
import { signupFormSchema } from "@/lib/signup-schema";
import type { SignupFormValues } from "@/lib/signup-schema";
import { MAX_USERNAME_LENGTH } from "@/lib/signup-username";
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

export default function SignupPage(): JSX.Element {
  const [state, setState] = useState<SignUpResult>(undefined);
  const [isPending, startTransition] = useTransition();

  // zodResolver(signupFormSchema) is the exact schema signUp re-parses
  // server-side (lib/signup-schema.ts) — this is client-side convenience
  // on top of that check, never a replacement for it, since a bypassed
  // client can still post straight to the Server Action.
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<SignupFormValues>({
    resolver: zodResolver(signupFormSchema),
    mode: "onBlur",
    reValidateMode: "onBlur",
  });

  const formLevelError = state && "error" in state && !state.field ? state.error : undefined;

  // No native `action={...}` / `useActionState` here on purpose: React 19
  // resets an uncontrolled form once its action-bound submission completes,
  // which was wiping every field (including both passwords) on every failed
  // signup. Calling the Server Action from inside handleSubmit's callback,
  // wrapped in a transition, means there is no native submission for React
  // to reset after — the inputs keep whatever the user typed regardless of
  // the result. RHF's handleSubmit already runs the resolver and blocks the
  // callback on failure, so this also replaces the old trigger()/
  // preventDefault hack that existed only to guard the native submit path.
  function onSubmit(values: SignupFormValues): void {
    const formData = new FormData();
    formData.set("username", values.username);
    formData.set("email", values.email);
    formData.set("password", values.password);
    formData.set("confirmPassword", values.confirmPassword);

    startTransition(async () => {
      try {
        const result = await signUp(formData);
        setState(result);
        if (result && "error" in result && result.field) {
          setError(result.field, { type: "server", message: result.error });
        }
      } catch (error) {
        // signUp redirect()s to /create on success — a thrown NEXT_REDIRECT
        // control-flow error, not a failure. unstable_rethrow lets it through
        // to Next's navigation handling; without it, a successful signup
        // would be caught here and reported as a failed one, the same bug
        // this pattern already caused once in render-confirm-dialog.tsx.
        unstable_rethrow(error);
        if (process.env.NODE_ENV !== "production") {
          console.error(
            "[signup] Server Action threw",
            error instanceof Error ? error.message : String(error),
          );
        }
        setState({
          error: "Could not create that account. Double-check the details and try again.",
        });
      }
    });
  }

  // Once signup succeeds there is no session yet — Supabase withholds one
  // until the confirmation link is clicked — so this replaces the form
  // instead of redirecting, and says exactly where the email went. A
  // signup that quietly looks like a login is the main way this flow goes
  // wrong for a new user who still needs to confirm their email.
  if (state && "checkInbox" in state) {
    return (
      <div className="flex min-h-svh w-full items-center justify-center bg-background p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <div className="mb-3 flex flex-col items-center gap-2 text-center">
              <MaisonLogo className="h-11 w-16 text-primary" />
              <MaisonWordmark className="text-foreground" />
              <span aria-hidden="true" className="mt-2 h-px w-10 bg-border" />
            </div>
            <CardTitle className="text-center">Check your inbox</CardTitle>
            <CardDescription className="text-center">
              We sent a confirmation link to <span className="font-medium">{state.email}</span>.
              Click it to activate your account — you&apos;re not signed in yet.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Link href="/login" className="text-sm font-medium underline underline-offset-4">
              Back to sign in
            </Link>
          </CardFooter>
        </Card>
      </div>
    );
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
            <CardTitle className="text-center">Sign up</CardTitle>
            <CardDescription className="text-center">
              Enter your email below to create an account
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="username" required>
                  Username
                </Label>
                <Input
                  id="username"
                  type="text"
                  placeholder="darwin_a"
                  autoComplete="username"
                  maxLength={MAX_USERNAME_LENGTH}
                  aria-invalid={errors.username ? true : undefined}
                  {...register("username")}
                />
                {errors.username ? (
                  <p className="text-sm text-destructive">{errors.username.message}</p>
                ) : null}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email" required>
                  Email
                </Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="email"
                  aria-invalid={errors.email ? true : undefined}
                  {...register("email")}
                />
                {errors.email ? (
                  <p className="text-sm text-destructive">{errors.email.message}</p>
                ) : null}
              </div>
              {/* Fixed, not a form control: role is never client-influenced,
                  and never registered with react-hook-form either. 0002_rls.sql
                  grants role='admin' read/write access to every project
                  belonging to every user, so a selectable (or RHF-managed,
                  submittable) role here would be self-service privilege
                  escalation, not a feature. profiles.role already defaults to
                  'editor' — this just shows that default rather than letting
                  anything set it. Matches the disabled-option treatment in
                  render-gate.tsx: a plainly unavailable control that says why,
                  rather than one that looks broken. */}
              <div className="grid gap-2">
                <Label htmlFor="role">Role</Label>
                <Button
                  id="role"
                  type="button"
                  variant="outline"
                  disabled
                  title="Admin access is granted by an existing admin — it can't be chosen at signup."
                  className="w-fit"
                >
                  Newly onboarded
                </Button>
                <p className="text-xs text-muted-foreground">
                  New accounts start with the Newly onboarded role. Admin access is granted by an existing admin.
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password" required>
                  Password
                </Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={errors.password ? true : undefined}
                  {...register("password")}
                />
                {errors.password ? (
                  <p className="text-sm text-destructive">{errors.password.message}</p>
                ) : null}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="confirmPassword" required>
                  Confirm password
                </Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={errors.confirmPassword ? true : undefined}
                  {...register("confirmPassword")}
                />
                {errors.confirmPassword ? (
                  <p className="text-sm text-destructive">{errors.confirmPassword.message}</p>
                ) : null}
              </div>
              {formLevelError ? <p className="text-sm text-destructive">{formLevelError}</p> : null}
            </div>
          </CardContent>
          <CardFooter className="flex-col gap-4">
            <Button type="submit" className="w-full" disabled={isPending}>
              {isPending ? "Signing up..." : "Sign up"}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link href="/login" className="font-medium underline underline-offset-4">
                Sign in
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
