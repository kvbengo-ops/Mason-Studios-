# Task Checklist: Forgot Password + Change Password

**Specification:** [`docs/task-forgot-password.md`](task-forgot-password.md)

## Status Legend
- `[ ]` Pending
- `[~]` In progress
- `[x]` Completed

---

## 1. Resend + Supabase Setup (Dashboard / Manual, No Code — Owner)

- [ ] **1.1** **Resend → Domains:** Add `vbgstudio.site`, configure SPF, DKIM, and MX records at DNS host, and wait for "Verified".
- [ ] **1.2** **Resend → API Keys:** Create a key with "Sending access" scoped to `vbgstudio.site`.
- [ ] **1.3** **Supabase → Auth → SMTP Settings:** Enable custom SMTP (`smtp.resend.com`, port `465`, user `resend`, password = Resend API key, sender `no-reply@vbgstudio.site` / `VBG Studio`).
- [ ] **1.4** **Supabase → Auth → Rate Limits:** Verify email rate limit (~30/hour with custom SMTP; Resend free tier is 100/day).
- [ ] **1.5** **Supabase → Auth → URL Configuration:** Set Site URL to `https://app.vbgstudio.site` and add `https://app.vbgstudio.site/**` to Redirect URLs.
- [ ] **1.6** **Supabase → Auth → Email Templates → Reset Password:** Set recovery link to:
  ```
  {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password
  ```
- [ ] **1.7** Keep **Confirm email** (`enable_confirmations`) off; add no new app env vars.

---

## 2. Local Dev Setup (`supabase/`)

- [x] **2.1** Create `supabase/templates/recovery.html` containing the recovery link:
  `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`
- [x] **2.2** Configure `[auth.email.template.recovery]` in `supabase/config.toml`:
  ```toml
  [auth.email.template.recovery]
  subject = "Reset your password"
  content_path = "./supabase/templates/recovery.html"
  ```

---

## 3. Auth Confirm Route & Middleware

- [x] **3.1** **`web/app/auth/callback/route.ts`:** Export `safeNext` so `/auth/confirm` can reuse it.
- [x] **3.2** **`web/app/auth/confirm/route.ts` (New):**
  - Read `token_hash`, `type`, and `next` from query params.
  - Call `supabase.auth.verifyOtp({ token_hash, type: "recovery" })`.
  - Redirect to `safeNext(next)` resolved against `NEXT_PUBLIC_APP_URL`'s origin on success.
  - Redirect to `/login` on missing params or verification failure.
- [x] **3.3** **`web/lib/supabase/middleware.ts`:** Add `/forgot-password` and `/auth/confirm` to `PUBLIC_PATHS`.

---

## 4. Forgot Password & Reset Password Flow

- [x] **4.1** **`web/actions/auth.ts` — `requestPasswordReset(formData)`:**
  - Validate email using `loginFormSchema`'s email rule (`web/lib/login-schema.ts`).
  - Call `supabase.auth.resetPasswordForEmail(email, { redirectTo: `${NEXT_PUBLIC_APP_URL}/auth/confirm?next=/reset-password` })`.
  - Return the same success result whether or not the account exists; log any Supabase error server-side without exposing it to the client.
- [x] **4.2** **`web/actions/auth.ts` — `resetPassword(formData)`:**
  - Get the user via `supabase.auth.getUser()` (not `requireUser()`, so pending accounts can also reset their password).
  - Refuse unless the current session's `amr` claim contains `otp` or `recovery`.
  - Validate `password` and `confirmPassword` with `signupPasswordSchema` (`web/lib/signup-password.ts`).
  - Call `supabase.auth.updateUser({ password })`, then `redirect("/create")`.
  - Return actionable errors as data (`ActionResult`), not throws.
- [x] **4.3** **`web/app/login/page.tsx`:** Add a `"Forgot password?"` link (`/forgot-password`) under the password field.
- [x] **4.4** **`web/app/forgot-password/page.tsx` (New):**
  - Email input form wired to `requestPasswordReset`.
  - Always display `"If an account exists, we sent a link."` on submit without revealing whether the address exists.
- [x] **4.5** **`web/app/reset-password/page.tsx` (New):**
  - Placed outside `(app)` so pending accounts can reach it.
  - Form with `password` and `confirmPassword` fields wired to `resetPassword`.

---

## 5. Change Password Flow (`/profile`)

- [x] **5.1** **`web/actions/profile.ts` — `changePassword(formData)`:**
  - Guard with `requireUser()`.
  - Validate `currentPassword` is non-empty and validate `password` + `confirmPassword` with `signupPasswordSchema`.
  - Verify current password using a throwaway non-persisting anon client (`createClient(url, anonKey, { auth: { persistSession: false } })`) calling `signInWithPassword({ email: user.email, password: current })`, then sign that throwaway client out immediately.
  - Return `{ error: "Current password is incorrect." }` if verification fails.
  - Call `supabase.auth.updateUser({ password })` on the session client and return `ActionResult`.
- [x] **5.2** **`web/components/change-password-form.tsx` (New):**
  - Follow the `ActionForm` + `SubmitButton` pattern from `web/components/username-form.tsx`.
  - Fields: current password, new password, confirm new password.
- [x] **5.3** **`web/app/(app)/profile/page.tsx`:** Render `<ChangePasswordForm />` inside the Account card below `<UsernameForm />`.

---

## 6. Tests

- [x] **6.1** **`web/actions/auth.test.ts`:**
  - `requestPasswordReset` returns the same result for a known and an unknown email.
  - `resetPassword` refuses a session without `otp` or `recovery` in `amr`.
  - A pending account with an `otp` session can reset its password.
- [x] **6.2** **`web/actions/profile.test.ts`:**
  - `changePassword` refuses a wrong current password and does not call `updateUser`.
- [x] **6.3** **`web/app/auth/confirm/route.test.ts`:**
  - Off-site or protocol-relative (`//evil.com`) `next` parameter falls back to the default redirect path.

---

## 7. Production Verification (Owner)

- [ ] **7.1** Request a password reset for a real account and confirm email arrives from `no-reply@vbgstudio.site`.
- [ ] **7.2** Open the reset link on a different device and verify it lands on `/reset-password` signed in.
- [ ] **7.3** Set a new password, sign out, and sign in with the new password.
- [ ] **7.4** Request a reset for an email with no account and confirm the UI shows the same message and sends no email.
- [ ] **7.5** On `/profile`, test changing password with an incorrect current password (refused) and then the correct current password (succeeds).
