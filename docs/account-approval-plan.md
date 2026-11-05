# Account Approval Plan — admin confirms a new account before it can sign in

**Status:** Built and applied. Every step below is in the branch this document landed on
(`feat/admin-approves-new-accounts`); migrations `0052`-`0055` were applied to the hosted project on
2026-08-28, and it now reports schema version `0055`.
**Scope:** Self-serve signup (`web/actions/auth.ts`) creates a working account today. This puts
an admin decision between "signed up" and "can use the app".

## What has to be true

A newly created account can hold a password and a session, but must not reach any page, Server
Action, or API route until an admin approves it. An admin decides from `/users`. Existing
accounts are unaffected — nobody gets locked out by shipping this.

## Where the gate goes, and why not the obvious place

Three code paths hand out a session, not one:

| Path | File | When |
|---|---|---|
| `signInWithPassword` | `web/actions/auth.ts` `signIn` | ordinary login |
| `signUp` returning a session | `web/actions/auth.ts` `signUp` | `enable_confirmations = false` (`supabase/config.toml:49`) |
| code exchange | `web/app/auth/callback/route.ts` | if confirmations are ever turned back on |

Gating `signIn` alone leaves the other two open — a brand-new signup never touches `signIn` at
all under today's config. The single chokepoint downstream of all three is `requireUser()`
(`web/actions/guard.ts:37`): every page, every Server Action, and `requireAdmin` /
`requireProject` / `requireScene` all route through it, and it *already* fetches the profile row.
The check costs zero extra queries.

Two constraints that shape the rest of the design:

- **The gate cannot redirect to `/login`.** `web/lib/supabase/middleware.ts` bounces an
  authenticated user off `/login` to `/projects`. A pending user would ping-pong forever.
- **The gate cannot sign the user out.** `web/lib/supabase/server.ts:37` swallows cookie writes
  from a Server Component, so `signOut()` inside `requireUser()` would appear to work and leave
  the session cookie live. Only a Server Action or Route Handler can clear it.

Hence a dedicated `/pending` page: somewhere middleware lets a signed-in user land, with a
sign-out button that actually works.

## 1. Migration — `supabase/migrations/0052_account_approval.sql`

```sql
alter table profiles add column status text not null default 'active'
  check (status in ('pending', 'active', 'rejected'));
alter table profiles alter column status set default 'pending';
```

Add-with-`'active'` backfills every existing row in the same statement; flipping the default
afterwards makes every new row pending. No `UPDATE`, no separate backfill pass, one transaction.

`text` + `CHECK` rather than a Postgres enum, per `0012_render_settings.sql`'s house rule.

**`handle_new_user()` needs no edit.** It names its insert columns (`0015_profile_username.sql`),
so the column default applies to both the self-serve path and a hand-created dashboard account.

Also in this migration:

- **`is_active()`** — security-definer helper mirroring `is_admin()` (`0002_rls.sql:12`), added to
  `projects_insert_own` **only**. Every scenes / assets / runs insert policy chains through
  project ownership (`0002_rls.sql:77,129,182`), so that one policy stops a pending account from
  starting the spend chain even if it holds a still-valid JWT and talks to PostgREST directly.
  This is the second line, not the first — the app guard in step 2 is the first.
- **`user_directory`** — `create or replace view` with `p.status` appended. The live definition is
  in `0030_runs_project_id.sql`, not `0028_user_directory.sql`; copy from 0030 and append the new
  column last, or the replace is rejected.

`profiles` has no `UPDATE` policy at all (`0002_rls.sql` defines only the two selects), so no user
can self-approve through RLS. Nothing to close there.

## 2. The gate — `web/actions/guard.ts`, one line

In `requireUser()`, after the profile fetch:

```ts
if (profile.status !== "active") redirect("/pending");
```

## 3. `/pending` and middleware

- `web/lib/supabase/middleware.ts`: add `"/pending"` to `PUBLIC_PATHS`.
- `web/app/pending/page.tsx`: reads the profile directly rather than calling `requireUser()`
  (which would loop). `active` → redirect `/projects`; no session → redirect `/login`; otherwise
  render "waiting for approval" or "this account was declined", plus
  `<form action={signOut}><button>Sign out</button></form>`. A form action can write cookies.

**`signIn` and `signUp` need no change.** Both already redirect to `/projects`; a pending account
now lands on `/pending` from there.

## 4. Admin decision — `web/actions/account.ts` (new) and `/users`

```ts
decideAccountApproval(userId: string, decision: "approve" | "reject"): Promise<ActionResult>
```

`requireAdmin()` first, then `createAdminClient()` — the same admin-client-after-a-passing-guard
pattern `web/actions/profile.ts` already uses for profile writes, rather than inventing a new RLS
update policy. Scope the update to the statuses the decision may legally move an account out of
(`DECIDABLE_FROM`: approve accepts `pending` *or* `rejected`, reject accepts `pending` only) so a
second admin racing the first (or a stale page) loses safely and gets a returned error, not a
thrown one — `decideAllowanceRequest` (`web/actions/allowance.ts:146`) is the precedent for both
the race handling and the `ActionResult` return. Finish with `revalidatePath("/users")`.

On `web/app/(app)/users/page.tsx`: a Status column and Approve / Reject on pending rows, Approve
alone on rejected ones. Reject goes through a confirmation dialog
(`web/components/reject-account-dialog.tsx`), approve does not — approving grants exactly what the
account applied for, rejecting locks a colleague out. That
page's header comment currently declines write controls on purpose ("a decision for whoever owns
that surface to make on purpose") — this is that decision, so the comment gets rewritten, not
quietly contradicted.

## 5. Checks

- `web/actions/guard.test.ts` — a pending profile redirects to `/pending`, a rejected one too, an
  active one passes, and both `requireAdmin` and `requireProject` inherit the gate.
- `web/actions/account.test.ts` — the update carries only `status`, is scoped to id *and* to rows
  still pending, returns (not throws) when it matches nothing, and never reaches the admin client
  for a non-admin caller.

Three more files the plan did not name, each following from a step above: `web/types/db.ts`
(hand-maintained, not generated — `ProfileStatus` plus the new column on `profiles` and
`user_directory`), `web/components/account-status-badge.tsx` (the badge, beside `role-badge.tsx`),
and `web/lib/version.ts` (`EXPECTED_DB_VERSION` → `"0052"`, which `version.test.ts`'s drift guard
requires of any new migration).

## 6. Admins bypass the decision — `0055_admin_bypasses_account_approval.sql`

This closes what used to be open decision 1 (fresh-database bootstrap): on a database with no
rows, the first dashboard-created admin was `pending` with nobody left to approve them.

Admins are trusted by role, so they never need a second, separate approval. `is_active()` is
replaced to read `role = 'admin' or status = 'active'`, and `web/lib/account-approval.ts` is its
application-side twin — keeping the exception in both places is what stops the app and direct
PostgREST access from disagreeing about a pending admin:

| Surface | Helper |
|---|---|
| `requireUser()` (`actions/guard.ts`) and `/pending` | `canUseApp(profile)` |
| `/users` Approve/Reject controls, `AccountStatusBadge` | `requiresAccountApproval(role)` |
| Every spend-chain write policy (`0052`, `0053`) | `is_active()` |

`decideAccountApproval` also filters `.neq("role", "admin")` server-side, so hiding the controls
on an admin row is backed by the write itself refusing, not only by the UI. Editor and
trusted-editor tiers are unchanged: they still require an explicit `status = 'active'`.

## Open decisions

1. **What "reject" means.** It is a status, not a deletion: the account still exists and that email
   cannot sign up again. Not terminal — Approve on a rejected row puts it back to `active`, since
   rejecting the wrong row on a list of near-identical rows is one misclick. If reject should
   instead delete the auth user, say so — it changes step 4 and nothing else.

## Deliberately not in scope

- Email to admins on new signup — the Supabase mailer is team-only and capped at 2/hour
  (`supabase/config.toml:42`), so it would not reach anyone.
- `approved_by` / `approved_at` audit columns — add when an admin asks who approved whom.
- Pending-first sort or a `?status=pending` filter on `/users` — the Status column is enough
  until the list is long.
- Storage: a pending account can still write to its own `media` / `avatar` folder
  (`0005_storage_bucket.sql`, `0034_profile_avatar.sql`), since those policies are folder-scoped
  rather than routed through project ownership. Bounded and unreachable from the UI once the app
  guard is in; close it with `is_active()` there too if it ever matters.
