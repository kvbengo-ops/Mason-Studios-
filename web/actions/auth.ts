"use server";

import { redirect } from "next/navigation";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { checkSignupDomainAllowed } from "@/lib/signup-allowlist";
import { loginFormSchema } from "@/lib/login-schema";
import { signupFormSchema } from "@/lib/signup-schema";

// Self-serve signup, added once the twenty-hand-provisioned-editors model
// stopped being enough. Email ownership verification depends on Supabase's
// confirmation setting, but an address already attached to an auth account
// is rejected below. Every account created this way signs up as 'editor'
// (profiles.role's own default — see the disabled
// role control on the signup form below) and gets that role's
// DAILY_CAP_USD/WEEKLY_CAP_USD render budget (lib/spend.ts) from the moment
// signUp succeeds — nobody has to provision it. That's the exposure this
// trades for not manually creating accounts: anyone who can reach this
// form can mint accounts and spend against the render budget indefinitely,
// one editor-tier allowance per account. SIGNUP_ALLOWED_DOMAINS (see
// lib/signup-allowlist.ts, render.yaml) is the lever to shut that down to
// a company domain without a code change if it's abused; it does nothing
// to a single account's own render behavior once created — that's still
// gated by spend.ts same as before. An admin can move an account to
// 'trusted_editor' (a higher allowance, not a visibility change — see
// 0031_account_allowances.sql) or vary its allowance directly once it
// exists; nothing about that is reachable from this form.
//
// 0004_profile_trigger.sql already creates the matching `profiles` row on
// insert into auth.users, so signUp needs no extra bootstrap step here —
// the trigger doesn't care whether the insert came from the dashboard or
// from supabase.auth.signUp.

// `field` lets the login page put a server-side error under the input it
// actually concerns (see lib/action-result.ts's redaction rationale for why
// this comes back as data rather than being thrown) instead of a separate
// message box that looks like a different system from the client-side
// react-hook-form errors sitting right above it. Omitted when no single
// field is at fault — "Invalid email or password" is deliberately ambiguous
// between the two, the same way it always has been, so it stays a
// form-level message.
export type SignInResult = { error: string; field?: "email" | "password" } | undefined;

/**
 * Email + password sign-in Server Action. Redirects to /create on
 * success; returns an error string on failure so the login form can
 * render it inline.
 */
export async function signIn(formData: FormData): Promise<SignInResult> {
  const email = formData.get("email");
  const password = formData.get("password");

  // loginFormSchema is the same schema the login form validates against
  // client-side (lib/login-schema.ts) — coercing a non-string FormData
  // entry (a File, in practice never submitted by these fields) to "" lets
  // its own "required" message fire instead of a type error.
  const parsed = loginFormSchema.safeParse({
    email: typeof email === "string" ? email : "",
    password: typeof password === "string" ? password : "",
  });
  if (!parsed.success) {
    // safeParse failed, so zod guarantees at least one issue.
    const issue = parsed.error.issues[0]!;
    return { error: issue.message, field: issue.path[0] as "email" | "password" };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    // Supabase's own message for this ("Email not confirmed") reads like a
    // generic rejection rather than telling the user what to do next, and
    // it's the one login failure that isn't "wrong email or password" — a
    // real account with a real password that just hasn't clicked the link
    // in its confirmation email yet.
    if (error.code === "email_not_confirmed") {
      return {
        error:
          "This address hasn't been confirmed yet. Check your inbox for the confirmation " +
          "email and click the link in it before signing in.",
      };
    }
    return { error: "Invalid email or password." };
  }

  // Deactivated accounts are refused the session, not just the app.
  //
  // `pending` and `rejected` are deliberately NOT handled here: those
  // accounts are held at /pending, which exists to tell them what to do
  // next and carries the sign-out button. A pending account signing in and
  // being told to wait is the correct outcome. Deactivation is different —
  // access was taken away, so the door is shut rather than the room.
  //
  // This is belt-and-braces, not the only guard: is_active() already
  // refuses every RLS-protected read and write, and canUseApp() already
  // redirects an existing session to /pending the moment an admin flips the
  // status. That second path still matters — someone already signed in when
  // they are deactivated never comes back through here — which is why the
  // /pending copy for this case stays.
  //
  // profiles_select_own is `id = auth.uid()` with no is_active() dependency,
  // so a deactivated account can still read its own row; if that ever
  // changes, this read returns nothing and the branch below stops firing.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("status")
      .eq("id", user.id)
      .single();
    if (profile?.status === "deactivated") {
      await supabase.auth.signOut();
      return {
        error: "This account has been deactivated. Talk to an admin if you think that is wrong.",
      };
    }
  }

  redirect("/create");
}

// `field` lets the signup page put a server-side error (username taken,
// domain not allowlisted, …) under the input it concerns, same as
// SignInResult above.
export type SignUpResult =
  | { error: string; field?: "username" | "email" | "password" | "confirmPassword" }
  | { checkInbox: true; email: string }
  | undefined;

/**
 * Email + password signup Server Action. Redirects to /create on success,
 * same as signIn — but whether that actually happens depends on a dashboard
 * setting this code doesn't control (enable_confirmations), so it branches
 * on what Supabase actually returned rather than assuming. A session means
 * confirmation is off and the account is live; no session means the project
 * still requires confirmation (someone re-enabled it, or this runs against
 * an environment where it's on), and redirecting anyway would land a
 * signed-out user on a page that 404s them. In that case fall back to the
 * `{ checkInbox, email }` result so the signup page can show that instead.
 */
export async function signUp(formData: FormData): Promise<SignUpResult> {
  const rawEmail = formData.get("email");
  const rawUsername = formData.get("username");
  const rawPassword = formData.get("password");
  const rawConfirmPassword = formData.get("confirmPassword");

  // signupFormSchema is the same schema the signup form validates against
  // client-side (lib/signup-schema.ts) — coercing a non-string FormData
  // entry to "" lets its own "required" messages fire instead of a type
  // error. This is the client form's ceiling, not the server's: anyone can
  // post past it, which is exactly why signUp re-runs it here rather than
  // trusting whatever the browser sent.
  const parsed = signupFormSchema.safeParse({
    username: typeof rawUsername === "string" ? rawUsername : "",
    email: typeof rawEmail === "string" ? rawEmail : "",
    password: typeof rawPassword === "string" ? rawPassword : "",
    confirmPassword: typeof rawConfirmPassword === "string" ? rawConfirmPassword : "",
  });
  if (!parsed.success) {
    // safeParse failed, so zod guarantees at least one issue.
    const issue = parsed.error.issues[0]!;
    return {
      error: issue.message,
      field: issue.path[0] as "username" | "email" | "password" | "confirmPassword",
    };
  }
  const { username, password } = parsed.data;
  const email = parsed.data.email.toLowerCase();

  // Server-only from here down: SIGNUP_ALLOWED_DOMAINS isn't available in
  // the browser, and email/username availability requires a database read — see
  // lib/signup-allowlist.ts and the comment on the lookup below.
  const domainCheck = checkSignupDomainAllowed(email, process.env.SIGNUP_ALLOWED_DOMAINS);
  if (!domainCheck.allowed) {
    return { error: domainCheck.reason, field: "email" };
  }

  // handle_new_user() (supabase/migrations/0015_profile_username.sql) inserts
  // both profiles.email and profiles.username for every auth user. Check both
  // here so an existing address gets a useful error before Supabase's
  // enumeration-resistant duplicate response can look like a successful
  // unconfirmed signup. Username uniqueness is enforced by a unique index,
  // while auth.users itself enforces email uniqueness.
  // In practice Supabase's auth server collapses a failed trigger into a
  // generic 500 ("Database error saving new user") with no reliable way to
  // tell a username collision apart from an unrelated database failure.
  // So availability is checked here instead, before signUp is ever called,
  // using the admin client to read across every account's username despite
  // RLS (profiles' own policies only allow a user to read their own row or
  // an admin to read every row — neither fits an anonymous signup request).
  // This is a narrow, deliberate exception to "only call createAdminClient
  // after verifying ownership" (see lib/supabase/server.ts): there is no
  // ownership to verify yet, and the query is scoped to an existence check
  // on one column, not a data read.
  const adminClient = createAdminClient();
  const { data: existingEmail, error: emailLookupError } = await adminClient
    .from("profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (emailLookupError) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[signup] email profile lookup failed", {
        code: emailLookupError.code,
        message: emailLookupError.message,
        supabaseHost: new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://invalid").host,
        serviceKeySet: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      });
    }
    return { error: "Could not create that account. Double-check the details and try again." };
  }
  if (existingEmail) {
    return {
      error: "An account with this email already exists. Try signing in instead.",
      field: "email",
    };
  }

  const { data: existingUsername, error: usernameLookupError } = await adminClient
    .from("profiles")
    .select("id")
    .ilike("username", username)
    .maybeSingle();

  if (usernameLookupError) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[signup] username profile lookup failed", {
        code: usernameLookupError.code,
        message: usernameLookupError.message,
      });
    }
    return { error: "Could not create that account. Double-check the details and try again." };
  }
  if (existingUsername) {
    return { error: "That username is taken. Try another.", field: "username" };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // /auth/callback already lands confirmed users on /create by
      // default (safeNext's DEFAULT_NEXT) — no `next` param needed here.
      // Only exercised when enable_confirmations is on; harmless otherwise.
      emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
      // Read by handle_new_user() via raw_user_meta_data. role is
      // deliberately absent here — see the signup page for why letting the
      // client influence it at all is a privilege-escalation bug, not a
      // missing feature: 0002_rls.sql grants role='admin' read/write access
      // to every project belonging to every user.
      data: { username },
    },
  });

  if (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[signup] Supabase Auth returned an error", {
        code: error.code,
        status: error.status,
        message: error.message,
      });
    }
    // Supabase returns a 200 with an "identities" array for a duplicate,
    // unconfirmed signup rather than a distinct error code (to avoid
    // leaking which emails exist), but a genuine duplicate — an already
    // *confirmed* address — does come back as an error here.
    if (error.code === "user_already_exists") {
      return {
        error: "An account with this email already exists. Try signing in instead.",
        field: "email",
      };
    }
    // The username availability check above closes the ordinary race, but
    // not a concurrent signup for the same name landing between that check
    // and this insert — profiles_username_lower_idx (0015) is what
    // actually prevents the duplicate row in that case, and it fails here
    // as the generic branch below rather than a distinct error code (see
    // the comment above the lookup for why). Rare enough, and the message
    // is still honest, that a dedicated code path isn't worth it.
    return { error: "Could not create that account. Double-check the details and try again." };
  }

  // With email confirmation enabled, Supabase deliberately hides whether an
  // address exists by returning a synthetic user with no identities and no
  // error. This also closes the race where another signup creates the email
  // after our profiles lookup but before auth.signUp reaches auth.users.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return {
      error: "An account with this email already exists. Try signing in instead.",
      field: "email",
    };
  }

  // data.session is the tell, not a config flag we'd have to keep in sync:
  // Supabase only hands back a session here when the project's
  // enable_confirmations setting is off, so this is live even if that
  // dashboard toggle changes without a matching code change.
  if (data.session) {
    redirect("/create");
  }

  return { checkInbox: true, email };
}

/** Signs the current user out and redirects to /login. */
export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
