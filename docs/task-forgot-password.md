# Task: forgot password + change password

Two features for existing accounts:

- **Forgot password** — a signed-out user requests a reset link by email.
- **Change password** — a signed-in user changes it from `/profile`.

**Signup does not change.** `enable_confirmations` stays `false`; no email
confirmation is added.

## Why email needs setup first

Production cannot send email today. Supabase's built-in mailer only delivers
to the project's own team addresses and is capped at 2/hour — the reason
confirmation was turned off (`supabase/config.toml`, `[auth.email]`). A reset
email hits the same wall, so Resend is wired in as custom SMTP before any of
this works in prod.

## 1. Resend + Supabase setup (dashboard, no code)

Do these in order.

1. **Resend → Domains:** add `vbgstudio.site`. Add the SPF, DKIM and MX records
   it shows at the DNS host. Wait for "Verified".
2. **Resend → API Keys:** create a key with "Sending access", scoped to that
   domain.
3. **Supabase → Auth → SMTP Settings:** enable custom SMTP.
   | Field | Value |
   | --- | --- |
   | Host | `smtp.resend.com` |
   | Port | `465` |
   | Username | `resend` |
   | Password | the Resend API key |
   | Sender email | `no-reply@vbgstudio.site` |
   | Sender name | `VBG Studio` |
4. **Supabase → Auth → Rate Limits:** check the email limit (about 30/hour once
   custom SMTP is on). Resend's free plan allows 100/day.
5. **Supabase → Auth → URL Configuration:**
   - Site URL: `https://app.vbgstudio.site`
   - Redirect URLs: add `https://app.vbgstudio.site/**`
6. **Supabase → Auth → Email Templates → Reset Password:** set the link to
   ```
   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password
   ```

Leave **Confirm email** off.

The Resend key lives only in Supabase. The app gets no new env var.

## 2. Forgot password

### Flow

```
/login → "Forgot password?" → /forgot-password (enter email)
  → email link → /auth/confirm (verifyOtp, session set)
  → /reset-password (new password + confirm) → /create
```

### Why `/auth/confirm`, not `/auth/callback`

`/auth/callback` exchanges a PKCE code. Its verifier lives in a cookie of the
browser that asked for the reset, so a link opened on another device (asked on
desktop, opened on phone) fails. `token_hash` + `verifyOtp` works on any device.

### Files

| File | Change |
| --- | --- |
| `web/app/forgot-password/page.tsx` | New. Email field. Always shows "If an account exists, we sent a link." — never reveals whether the email exists. |
| `web/app/auth/confirm/route.ts` | New. Reads `token_hash`, `type`, `next`; calls `verifyOtp({ token_hash, type: "recovery" })`; redirects to `next` on `NEXT_PUBLIC_APP_URL`'s origin. Failure goes to `/login`. |
| `web/app/auth/callback/route.ts` | Export `safeNext` so `/auth/confirm` reuses it. |
| `web/app/reset-password/page.tsx` | New. Outside `(app)` so a pending account can reset too. New password + confirm. |
| `web/actions/auth.ts` | Add `requestPasswordReset` and `resetPassword` (below). |
| `web/lib/supabase/middleware.ts` | Add `/forgot-password` and `/auth/confirm` to `PUBLIC_PATHS`. |
| `web/app/login/page.tsx` | "Forgot password?" link under the password field. |

### Actions

**`requestPasswordReset(formData)`**

- Validate email with the existing `loginFormSchema` email rule.
- `supabase.auth.resetPasswordForEmail(email, { redirectTo: `${NEXT_PUBLIC_APP_URL}/auth/confirm?next=/reset-password` })`.
- Return the same success result whether or not the account exists. Log errors
  server-side, never show them.

**`resetPassword(formData)`**

- `supabase.auth.getUser()` (not `requireUser()`, which redirects pending accounts to `/pending`); if there is no user, return `{ error: "This reset link has expired. Request a new one." }`.
- Refuse unless the session's `amr` contains `otp` or `recovery` (`verifyOtp` sets `otp`). This stops a stolen
  ordinary session from setting a password without knowing the current one.
- Validate with `signupPasswordSchema` (`lib/signup-password.ts`).
- `supabase.auth.updateUser({ password })`, then `redirect("/create")`.
- Return errors as data, not throws (`lib/action-result.ts`).

## 3. Change password

| File | Change |
| --- | --- |
| `web/actions/profile.ts` | Add `changePassword` (below). |
| `web/components/change-password-form.tsx` | New. Same `ActionForm` + `SubmitButton` pattern as `username-form.tsx`. Fields: current, new, confirm. |
| `web/app/(app)/profile/page.tsx` | Render `<ChangePasswordForm />` in the Account card, under `UsernameForm`. |

**`changePassword(formData)`**

- `requireUser()`.
- Validate new + confirm with `signupPasswordSchema`; current must be non-empty.
- Check the current password with a throwaway anon client
  (`createClient(url, anonKey, { auth: { persistSession: false } })`) calling
  `signInWithPassword({ email: user.email, password: current })`. Sign that
  client out right after. The user's own session cookies are untouched.
- Wrong current password → `{ error: "Current password is incorrect." }`.
- `supabase.auth.updateUser({ password })` on the session client.
- Return an `ActionResult` so errors show as a toast, not a redacted throw.

## 4. Local dev

- No Resend locally. Emails land in Mailpit at `http://localhost:54324`
  (`[local_smtp]` is already enabled).
- Add `supabase/templates/recovery.html` with the same link as step 1.6, and in
  `supabase/config.toml`:
  ```toml
  [auth.email.template.recovery]
  subject = "Reset your password"
  content_path = "./supabase/templates/recovery.html"
  ```
  so local and prod use the same link.

## 5. Tests

| Test | Proves |
| --- | --- |
| `actions/auth.test.ts` | `requestPasswordReset` returns the same result for a known and an unknown email. |
| `actions/auth.test.ts` | `resetPassword` refuses a session without `otp` or `recovery` in `amr`. |
| `actions/auth.test.ts` | A pending account with an `otp` session can reset its password. |
| `actions/profile.test.ts` | `changePassword` refuses a wrong current password and does not call `updateUser`. |
| `app/auth/confirm/route.test.ts` | An off-site or `//evil.com` `next` falls back to the default. |

## Reused, nothing new

- `signupPasswordSchema` / `passwordFieldSchema` (8-character floor + match).
- `loginFormSchema`'s email rule.
- `ActionForm`, `SubmitButton`, `ActionResult`, `requireUser`.

No migration. No new table. No worker change. No new app env var.

## Verify in prod

1. Request a reset for a real account. The email arrives from
   `no-reply@vbgstudio.site`.
2. Open the link on a **different device**. It lands on `/reset-password`
   signed in.
3. Set a new password. Sign out. Sign in with the new one.
4. Request a reset for an email with no account. Same message, no email.
5. On `/profile`, change password with a wrong current one (refused), then the
   right one (works).
