# Credit system — browser test plan

A hand-off for an agent driving the Claude Chrome extension. Section 1 is setup you do
once, by hand. Section 2 is the prompt to paste. Section 3 is the task list the prompt
refers to.

The thing that makes this testable at all: in `MODE=development` **no vendor is ever
called**, but the three spend caps still run. `assertWithinSpendCaps` skips only the kie
balance read in dev — `web/lib/spend.ts` says so in its own comment, and calls the caps
"what a test of the cap behaviour should be exercising." So the entire credit and approval
system can be exercised end to end without a single billable call.

---

## 1. Setup (do this yourself, before handing off)

### 1.1 Point at a LOCAL database, not production

This is the one step that must not be skipped. `web/.env.local` has historically pointed at
the production Supabase project — that is the documented cause of the incident in
`web/lib/mode.ts`'s header, where a local "mocked" render was claimed and billed by the
deployed production worker.

```bash
supabase start                      # local stack: api 54321, db 54322, studio 54323
supabase db reset                   # applies every migration from scratch
```

Then set `web/.env.local` to the local stack's URL and keys (`supabase status` prints them),
and confirm:

```bash
grep -E "NEXT_PUBLIC_SUPABASE_URL|^MODE" web/.env.local
# expect: a 127.0.0.1:54321 URL, and MODE=development
```

If `NEXT_PUBLIC_SUPABASE_URL` points anywhere else, stop. Every test below writes rows.

### 1.2 Make the boundaries reachable

Defaults are $5 daily / $10 weekly / $33 team. Shrink them so a single seeded row can sit
either side of a line, and so the team ceiling can be made to bind before the personal one:

```bash
# web/.env.local
MODE=development
DAILY_CAP_USD=2
WEEKLY_CAP_USD=4
TRUSTED_DAILY_CAP_USD=3
TRUSTED_WEEKLY_CAP_USD=6
GLOBAL_DAILY_CAP_USD=10
```

Restart `npm run dev` (port 9000) after changing these — they are read at module load.

### 1.3 Three accounts

The rules are about *different people*, so one account cannot test them. Sign up three at
`/signup`, then set roles and activate them in Studio or psql:

```sql
update profiles set role = 'admin',          status = 'active' where email = 'admin@test.local';
update profiles set role = 'trusted_editor', status = 'active' where email = 'trusted@test.local';
update profiles set role = 'editor',         status = 'active' where email = 'editor@test.local';
```

Keep a fourth signed-up-but-untouched account (`pending@test.local`, left at its default
status) for the account-approval test.

Give the agent all four sets of credentials in your prompt, or log the browser in yourself
and tell it which account is active.

### 1.4 How to position spend precisely

Do not try to reach a cap by rendering repeatedly — in dev nothing bills, and if the Go
worker is not running the scenes never leave `queued`. Seed the ledger directly instead.
`runs` rows are the only record of what anyone spent; every gate re-sums them.

```sql
-- put one editor at $1.80 spent this week and today
insert into runs (project_id, scene_id, vendor, model, cost_usd, created_at)
select p.id, null, 'kie', 'test-seed', 1.80, now()
from projects p
join profiles pr on pr.id = p.user_id
where pr.email = 'editor@test.local'
limit 1;
```

`created_at` is the knob: `now()` counts against both daily and weekly, `now() - interval
'2 days'` counts against weekly only (same Manila week), `now() - interval '10 days'` counts
against neither.

---

## 2. The prompt

Paste this, with credentials filled in.

> You are testing the credit and approval system of a Next.js app running locally at
> `http://localhost:9000`. Use the Chrome extension tools to drive it.
>
> **Hard constraints.**
> 1. This app is pointed at a local Supabase instance and runs in `MODE=development`, so no
>    vendor is ever called and no real money can move. Before you do anything else, confirm
>    that: open `/spend` as the admin and verify the page loads without a live balance
>    figure. If anything suggests you are against a production database, stop and say so.
> 2. Do not modify any application code, migration, or environment file. You are testing
>    what exists, not fixing it.
> 3. Do not trigger native browser dialogs (`alert`, `confirm`). If a control looks like it
>    will, say so and skip it rather than clicking.
> 4. If a step fails three times, stop and report. Do not keep retrying or wander into
>    unrelated pages.
>
> **Accounts** (email / password):
> - admin — `admin@test.local` / `<pw>`
> - trusted editor — `trusted@test.local` / `<pw>`
> - editor — `editor@test.local` / `<pw>`
> - unapproved — `pending@test.local` / `<pw>`
>
> Sign in at `/login`. Switch accounts by signing out and back in.
>
> **What you are testing.** The system has no wallets. There is one pot of real money (the
> kie account) and a set of per-person speed limits called allowances. Nothing is ever
> deducted from a user; a render is refused by summing that user's past `runs` rows and
> comparing against a ceiling. An approver can raise the ceiling with a grant, which expires.
> Credits are a display unit: 1 credit = $0.005, so $10 shows as 2,000 cr.
>
> **Your task.** Work through the numbered cases in `docs/credit-system-test-plan.md`
> section 3, in order. For each one record: what you did, what you saw, and PASS or FAIL
> against the stated expectation. Quote the exact on-screen text for any refusal or error
> message — the wording is part of what is under test.
>
> Some cases need a row seeded in the database first. Those are marked **[seed]** and give
> you the SQL. Run it with:
> `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "<sql>"`
>
> Take a screenshot at each decisive moment — a refusal message, a badge state, a changed
> figure — and name them by case number.
>
> When you are done, give me one table of case number, PASS/FAIL, and a one-line note, then
> a short list of anything that surprised you. Do not fix anything you find.

---

## 3. The cases

### A — Display and conversion

**A1.** Sign in as editor. Read the sidebar budget.
*Expect:* the allowance is shown in credits, not dollars. With `WEEKLY_CAP_USD=4` it reads
800 cr. A "Request more" control is present.

**A2.** Sign in as admin, open `/users`.
*Expect:* admin surfaces show both units, e.g. `800 cr ($4.00)`. The columns "Used today",
"Used this week" and "Active grants" are present.

**A3.** Confirm the displayed allowance is a ceiling, not a stock. **[seed]** Add $1.00 of
spend for the editor today, reload the sidebar.
*Expect:* the allowance figure itself does not decrease. What changes is the used/remaining
reading. A number that counts down like a wallet is a FAIL — that is the exact
misunderstanding this design avoids.

```sql
insert into runs (project_id, scene_id, vendor, model, cost_usd, created_at)
select p.id, null, 'kie', 'test-seed', 1.00, now() from projects p
join profiles pr on pr.id = p.user_id where pr.email = 'editor@test.local' limit 1;
```

### B — The four gates, and their order

**B1. The team ceiling binds before the personal one.** **[seed]** Give a *different* user
enough spend today to sit just under `GLOBAL_DAILY_CAP_USD` ($10), while the editor has
plenty of personal headroom. As the editor, try to start a render.
*Expect:* refused, and the message names the **team's** ceiling, not the editor's own. If it
names the personal cap, the gate order is wrong.

**B2. Weekly cap.** **[seed]** Put the editor at $3.90 spent this week (spread over two days
so the daily guard is not the binding one). Try to render.
*Expect:* refused against the weekly allowance, with a message pointing at asking an
approver.

**B3. Daily burst guard.** **[seed]** Reset to a clean week, then put $1.90 of spend on the
editor *today* only.
*Expect:* refused against the daily cap, with a come-back-tomorrow sense to it — a different
message from B2.

**B4. The balance check is skipped in dev.** With no valid kie key configured, attempt a
render that is otherwise within every cap.
*Expect:* it is **not** blocked by a balance check. In development the balance read is
skipped entirely; an "account is out of money" refusal here is a FAIL.

### C — Grants

**C1. A grant raises the weekly ceiling.** As the editor at their weekly limit (state from
B2), click "Request more" and submit a request with a reason. Sign in as admin, open
`/allowances`, approve it. Sign back in as the editor.
*Expect:* the request shows Pending, then Approved. The editor's weekly headroom increases
by the granted amount. No balance anywhere was debited to pay for it.

**C2. A grant does NOT raise the daily guard.** This is the sharp one. **[seed]** Put the
editor at their *daily* limit while holding a live grant from C1. Try to render.
*Expect:* still refused — by the daily cap. If the grant lifted the daily ceiling too, the
burst guard has been removed by accident and this is a FAIL worth reporting loudly.

**C3. Grants expire.** **[seed]** Expire the grant by hand, then reload the editor's sidebar.
*Expect:* the raised headroom is gone and the ceiling is back to the base cap.

```sql
update allowance_grants set expires_at = now() - interval '1 hour'
where user_id = (select id from profiles where email = 'editor@test.local');
```

### D — Who may approve what

**D1. Nobody decides their own request — including an admin.** As the admin, submit an
allowance request for yourself. Then, still as the admin, open `/allowances` and try to
decide it.
*Expect:* refused, with a message saying someone else has to decide it. An admin being able
to self-approve is a FAIL.

**D2. One pending request per person.** As the editor with a pending request already open,
try to submit a second.
*Expect:* refused. This is enforced by a unique index in the database, not by app code, so
it should hold even against fast repeated clicks — try double-submitting.

**D3. A trusted editor may decide within their ceiling.** As trusted editor, open
`/allowances` and decide a request whose amount is at or below `WEEKLY_CAP_USD` ($4).
*Expect:* allowed. The pre-filled grant amount is at or below their limit.

**D4. A trusted editor may not decide above it.** Have the editor request an amount well
above `WEEKLY_CAP_USD` (say $50). As trusted editor, try to decide it.
*Expect:* refused, with a message naming their approval limit and saying an admin has to
decide it. The request stays pending and decidable by the admin.

**D5. A trusted editor cannot choose the expiry.** While approving in D3, look for an expiry
control.
*Expect:* either absent or not editable — a peer grant's expiry is forced to the end of the
current Manila week. If a trusted editor can set an arbitrary expiry, that is a FAIL.

**D6. A plain editor cannot reach the approvals surface at all.** As the editor, navigate
directly to `/allowances`, then to `/users`.
*Expect:* both refused. `/allowances` is approver-gated, `/users` is admin-only. A partial
render that shows data before erroring is worth reporting.

**D7. Cancelling.** As the editor, submit a request and then cancel it.
*Expect:* status becomes Cancelled, and a new request can then be submitted (D2's uniqueness
applies to *pending* only).

### E — Account approval, the other approval system

**E1.** Sign in as `pending@test.local`, whose profile status was never set to active.
*Expect:* cannot use the app. This is a different gate from the allowance system — it asks
"may this person use the app at all", not "may they spend more".

**E2.** As admin, activate that account, then sign in as it again.
*Expect:* now usable, with the base editor allowance.

### F — Attribution

**F1. Spend lands on the project's owner, not on whoever clicked.** As admin, render a scene
on a project owned by the *editor*. Then check the editor's used-this-week figure on
`/users`.
*Expect:* the cost is attributed to the editor, not the admin. Attribution runs run →
project → project owner.

### G — The weekly reset

**G1.** **[seed]** Move the editor's seeded spend back to the previous Manila week, then
reload.
*Expect:* the headroom reappears on its own. Nothing was topped up and no grant was issued —
the sum simply starts counting from a new Monday.

```sql
update runs set created_at = now() - interval '10 days'
where model = 'test-seed';
```

---

## What a good report looks like

A table of case → PASS/FAIL → note, with the exact refusal wording quoted for every gate
that fired. The wording matters as much as the behaviour: these messages are what tells an
editor whether to wait, ask for a grant, or escalate, and a refusal that names the wrong
ceiling is a real bug even when the render was correctly blocked.

Cases most worth a second look if they pass suspiciously easily: **B1** (gate order),
**C2** (grant not lifting the daily guard), and **D1** (self-approval).

## Cleanup

```sql
delete from runs where model = 'test-seed';
```

Or `supabase db reset` for a clean slate.
