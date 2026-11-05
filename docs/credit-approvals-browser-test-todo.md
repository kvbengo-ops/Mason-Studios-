# Credit flow + approvals — browser test TODO

A tick-list for driving the app by hand (or with the Claude Chrome extension) at
`http://localhost:9000`. Prose rationale for the credit model lives in
`docs/credit-system-test-plan.md`; this file is the checklist.

---

## 0. STOP — read before starting the dev server

`web/.env.local` is **currently pointed at production**:

```
MODE=production
NEXT_PUBLIC_SUPABASE_URL=https://wyaxxmwmhayanlviovsg.supabase.co   # hosted prod project
KIE_API_KEY=<live>
ANTHROPIC_API_KEY=<live>
```

Starting `npm run dev` as-is and clicking Render writes `dev=false` rows into the
production `scenes` table, which the **deployed** worker claims and really bills — the
exact incident documented in `web/lib/mode.ts`. A local mock flag cannot stop it; the
worker that claims the row is not your process.

- [ ] **0.1** Back up the current env file (`cp web/.env.local web/.env.local.prod.bak`).
- [ ] **0.2** `supabase start` then `supabase db reset` (api 54321, db 54322, studio 54323).
- [ ] **0.3** Rewrite `web/.env.local` for local testing:
      ```
      MODE=development
      NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321   # from `supabase status`
      NEXT_PUBLIC_SUPABASE_ANON_KEY=<local anon key>
      SUPABASE_SERVICE_ROLE_KEY=<local service role key>
      KIE_API_KEY=
      ANTHROPIC_API_KEY=
      DAILY_CAP_USD=2
      WEEKLY_CAP_USD=4
      TRUSTED_DAILY_CAP_USD=3
      TRUSTED_WEEKLY_CAP_USD=6
      ADMIN_DAILY_CAP_USD=100
      ADMIN_WEEKLY_CAP_USD=700
      GLOBAL_DAILY_CAP_USD=10
      ```
      Vendor keys **blank** on purpose: if a gate is missed, the call fails instead of billing.
- [ ] **0.4** `make doctor` — expect `MODE=development`, both keys `blank`, supabase `ok`.
- [ ] **0.5** `npm run dev` in `web/` (port 9000). Confirm the app loads.
- [ ] **0.6** Sanity: open `/spend` as admin and confirm no live kie balance figure is
      shown. If anything suggests production, stop.

Caps are read at module load — **restart the dev server** after any `.env.local` edit.

### Accounts

Sign up four at `/signup`, then in Studio/psql:

```sql
update profiles set role='admin',          status='active' where email='admin@test.local';
update profiles set role='trusted_editor', status='active' where email='trusted@test.local';
update profiles set role='editor',         status='active' where email='editor@test.local';
-- leave pending@test.local untouched (status defaults to 'pending')
```

If signup is refused, `SIGNUP_ALLOWED_DOMAINS` is set — clear it or use an allowed domain.

### Seeding spend

Never try to reach a cap by rendering — in dev nothing bills, and with no worker running
scenes sit in `queued` forever. Seed `runs` directly:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "<sql>"
```

```sql
insert into runs (project_id, scene_id, vendor, model, cost_usd, created_at)
select p.id, null, 'kie', 'test-seed', 1.80, now()
from projects p join profiles pr on pr.id = p.user_id
where pr.email = 'editor@test.local' limit 1;
```

`created_at` is the knob: `now()` hits daily+weekly, `now() - interval '2 days'` weekly
only (same Manila week), `now() - interval '10 days'` neither. Cleanup:
`delete from runs where model='test-seed';`

**Every editor account needs at least one project** before seeding — the insert above joins
through `projects`. Create one at `/projects/new` first.

---

## 1. Credit display — the unit changes by role and by surface

1 credit = $0.005, so $4 = 800 cr, $2 = 400 cr, $10 = 2,000 cr.

- [ ] **1.1** As **editor**, open the account menu (avatar, bottom-left of the sidebar —
      it opens upward). Budget reads in **credits**, no dollars.
- [ ] **1.2** As **admin**, same menu. Reads in **plain USD**, plus a `Team: $X left today`
      line that editors do not get.
- [ ] **1.3** `/allowances` as **admin** — amounts read **dual**: `800 cr ($4.00)`.
- [ ] **1.4** `/allowances` as **trusted editor** — same page, **credits only**, and the
      two admin cards (`Account funds`, `Outstanding allowance`) are absent.
- [ ] **1.5** `/users` as admin — `Used today`, `Used this week`, `Active grants` columns
      read in **plain USD** (not dual, not credits). Note any mismatch with 1.3.
- [ ] **1.6** `/profile` as editor — `Left today`, `Left this week`, `Active grants`,
      `Request history`. Credits.
- [ ] **1.7** **The allowance is a ceiling, not a wallet.** [seed] Add $1.00 of spend for
      the editor today, reload `/profile`. The **cap** figure must not move; only
      used/remaining changes. A number that counts down like a balance is a FAIL.

---

## 2. The four gates, and their order

Server order is **balance → global → weekly → daily** (`assertWithinSpendCaps`,
`web/lib/spend.ts`). Quote the exact refusal wording for each — the wording is under test,
because it is what tells an editor whether to wait a day, wait for Monday, or escalate.

- [ ] **2.1 Balance check is skipped in dev.** With `KIE_API_KEY` blank, start a render
      that is within every cap. It must **not** be refused for funding. Seeing
      "Rendering is temporarily unavailable — the kie.ai account needs additional funding"
      here is a FAIL.
- [ ] **2.2 Team ceiling binds before the personal one.** [seed] Put a *different* account
      just under `GLOBAL_DAILY_CAP_USD` ($10) today, leaving the editor plenty of personal
      headroom. As editor, try to render.
      *Expect:* refusal names **the team** — "the WHOLE TEAM's spend today… this is not
      about your own usage". If it names the personal cap, gate order is wrong.
- [ ] **2.3 Weekly allowance.** [seed] Clean the week, then put the editor at $3.90 spread
      over two days (so daily is not the binding one). Render.
      *Expect:* "…over your $4.00 weekly allowance… **wait until Monday**".
- [ ] **2.4 Daily burst guard.** [seed] Clean week, then $1.90 on the editor **today only**.
      Render.
      *Expect:* "…over your $2.00 **daily burst guard**… **wait until tomorrow**".
      This must be a visibly different message from 2.3.
- [ ] **2.5 Landing exactly on the cap is allowed.** Seed the editor to exactly the cap
      minus the render estimate. The render is permitted. One cent more, refused.
- [ ] **2.6 The render page pre-warns before you click.** On `/projects/<id>/render`, an
      over-budget render should surface the refusal *before* submitting, naming the same
      cap the server would ("This render is $X over what you have left this week…").
      Client and server naming *different* caps is a FAIL worth reporting.

---

## 3. In-flight spend — queued work counts against you before any `runs` row exists

`getInFlightSpend` counts scenes in `queued`/`rendering`. Testable precisely *because* no
worker is running: enqueued scenes stay `queued`.

- [ ] **3.1** With the editor near (not over) the weekly cap and **no worker running**,
      enqueue a render. It succeeds; the scene sits in `queued`.
- [ ] **3.2** Without seeding anything, immediately try a second render of similar size.
      *Expect:* refused, even though `runs` is still empty — the first render's estimate
      is counted. A second render sailing through is the overspend hole this closes.
- [ ] **3.3** `/profile` "Left this week" should already reflect the in-flight estimate,
      not just settled `runs`.
- [ ] **3.4** Delete/cancel the queued scenes, reload. Headroom returns.

---

## 4. The caps guard more than the Render button

`assertWithinSpendCaps` also gates brief compile, character reference frames, frame
generation, the Character Library, and `/ugc`. Each is an independent call site.

- [ ] **4.1** With the editor over their weekly cap, try **Compile** on a script
      (`/projects/<id>/script`). Refused with the same weekly message.
- [ ] **4.2** Same state, try generating a **character reference frame**
      (`/projects/<id>/character`). Refused.
- [ ] **4.3** Same state, try a **`/ugc`** generation. Refused.
- [ ] **4.4** Same state, `/library` → add character / describe from photo. Refused.
      Any of these succeeding while Render is blocked is an ungated spend path.

---

## 5. The "Request more" dialog tells the truth about whether it will help

`allowanceDialogState` has five outcomes. The control is always present; only the message
changes. Read the message at each state.

- [ ] **5.1 `headroom`** — nothing exhausted. Dialog opens and says plainly that nothing is
      blocking you yet (requesting ahead of a big render is still allowed).
- [ ] **5.2 `normal`** — weekly exhausted, daily and global fine. "You've used this week's
      allowance. Ask an admin to raise it…"
- [ ] **5.3 `blocked-daily`** — [seed] daily exhausted too. "Requesting more won't unblock
      you right now — your daily burst guard is what's…"
- [ ] **5.4 `blocked-global`** — [seed] team cap exhausted, editor's own daily fine.
      Message names the **team's shared daily cap**.
- [ ] **5.5 `blocked-both`** — daily *and* global exhausted. Message names **both**.
- [ ] **5.6** Submitting a **non-positive** amount is refused: "Enter a positive number of
      credits."

---

## 6. Grants

- [ ] **6.1 A grant raises the weekly ceiling.** From 2.3's state, editor clicks
      *Request more allowance*, adds a reason, submits. Admin opens `/allowances`,
      approves. Editor reloads.
      *Expect:* Pending → Approved; weekly headroom up by the granted amount; **nothing
      anywhere was debited to pay for it**.
- [ ] **6.2 A grant does NOT raise the daily guard.** [seed] Put the editor at their daily
      limit while holding the live grant. Render.
      *Expect:* still refused, **by the daily cap**. A grant lifting the daily ceiling means
      the burst guard was removed by accident — report loudly.
- [ ] **6.3 A grant does NOT raise the global cap.** Same idea against
      `GLOBAL_DAILY_CAP_USD`. Still refused, still naming the team.
- [ ] **6.4 Grants expire.**
      ```sql
      update allowance_grants set expires_at = now() - interval '1 hour'
      where user_id = (select id from profiles where email='editor@test.local');
      ```
      Reload `/profile` — raised headroom gone, `Active grants` back to none.
- [ ] **6.5 Expiry bounds.** As admin approving, try an expiry in the **past** and one
      **beyond 90 days**. Both refused with a stated reason.
- [ ] **6.6 Grant amount defaults up to the $5 increment.** Approving a $12 request
      pre-fills $15 for an admin.

---

## 7. Who may decide what

- [ ] **7.1 Nobody decides their own request — admins included.** As admin, file a request
      for yourself, then try to decide it on `/allowances`.
      *Expect:* the row shows "You can't decide your own allowance request — someone else
      has to." and offers no Approve/Deny control. Self-approval is a FAIL.
- [ ] **7.2 One pending request per person.** With a pending request open, submit a second.
      Refused (enforced by a unique index, so **double-click the submit button** — it must
      hold under a race, not just in the UI).
- [ ] **7.3 Trusted editor may decide within their ceiling.** Their ceiling is
      `WEEKLY_CAP_USD` ($4 / 800 cr) — the **base editor** cap, not their own $6. As trusted
      editor, decide a request at or under 800 cr. Allowed.
- [ ] **7.4 Trusted editor may not decide above it.** Have the editor request 10,000 cr
      ($50). As trusted editor:
      *Expect:* "This request is over your 800 cr approval limit — an admin has to decide
      it." The request stays **pending** and an admin can still decide it.
- [ ] **7.5 Deny escalates too.** In 7.4's state, confirm the trusted editor gets **no Deny
      control either** — not just no Approve. A peer able to deny an oversized ask is as
      damaging as one able to approve it.
- [ ] **7.6 The pre-filled amount is clamped, and a typed one is not.** With
      `WEEKLY_CAP_USD=4` (off the $5 grid): a request at 800 cr pre-fills at **800 cr, not
      1,000**. Then type an amount **above** 800 cr and submit.
      *Expect:* refused — "You can approve up to 800 cr — an admin has to decide anything
      larger." Silently granting less than the figure on screen is also a FAIL.
- [ ] **7.7 A trusted editor cannot choose the expiry.** During 7.3, the expiry control is
      absent or not editable (a peer grant is forced to the end of the Manila week).
- [ ] **7.8 A plain editor cannot reach the approver surfaces.** Navigate directly to
      `/allowances`, then `/users`, then `/spend`. All refused. A partial render that flashes
      data before erroring is worth reporting.
- [ ] **7.9 Nav badge.** As admin and as trusted editor, the sidebar `Allowances` link
      carries a count of requests **that viewer can actually decide** — an oversized request
      should not be counted for the trusted editor, and neither should their own.
- [ ] **7.10 Cancelling.** Editor submits a request, then cancels it from the account menu
      (`Allowance request pending: … — Cancel`). Status → Cancelled, and a new request can
      then be filed (7.2's uniqueness is pending-only).

---

## 8. Admin allowance controls on `/users`

- [ ] **8.1 Promote / demote a trusted editor.** `Make trusted` on the editor row → role
      becomes `Trusted editor`; `Remove trusted` reverses it.
- [ ] **8.2 An admin row offers neither control** (the action refuses admin rows server-side
      as well as hiding the button).
- [ ] **8.3 A promoted-but-pending account gains nothing.** Promote `pending@test.local` to
      trusted editor without activating it. It still cannot use the app or decide anything.
- [ ] **8.4 Per-account weekly override.** Set a weekly allowance on the editor's row.
      `/profile` and the account menu both reflect it, and the gate in §2 now measures
      against the override rather than the role default.
- [ ] **8.5 Clearing the override** ("Use role default") returns them to the role cap.
- [ ] **8.6 Override upper bound.** Try an override above `ADMIN_WEEKLY_CAP_USD` ($700).
      Refused: "…is the highest allowance any role gets — raise the cap env vars…".
      Try `0` and a negative. Refused: "Enter a positive weekly allowance…".
- [ ] **8.7 All-editors bulk allowance.** `Weekly allowance for all editors` applies to
      every editor row at once. Confirm it does **not** touch admins, and confirm a
      per-account override set in 8.4 behaves predictably afterwards (note which wins).
- [ ] **8.8 Underfunding warning.** On `/allowances` as admin, when
      `Outstanding allowance` exceeds `Account funds`, the warning line appears:
      "Outstanding allowance exceeds account funds…". It **warns, does not block** —
      approving anyway must still be possible.

---

## 9. Account approval — the other approval system

Different gate from allowances: "may this person use the app at all", not "may they spend
more".

- [ ] **9.1** Sign in as `pending@test.local`. Redirected to `/pending`, "Waiting for
      approval". No app surface is reachable — try `/projects` and `/profile` directly.
- [ ] **9.2** Admin rejects the account. Signing in now reads "Account not approved" /
      "An admin reviewed this account and did not approve it."
- [ ] **9.3** Admin approves it. Sign in again — app usable, base editor allowance visible.
- [ ] **9.4 Stale-list race.** Open `/users` in two tabs, approve the same pending row in
      both. The loser gets "That account no longer needs approval or someone else already
      decided it — this list now shows where it stands." and the list refreshes. It must
      **not** silently flip an already-approved account to rejected.

---

## 10. Attribution and the weekly reset

- [ ] **10.1 Spend lands on the project's owner, not on whoever clicked.** As admin, render
      a scene on a project owned by the **editor**. Check `/users` → the editor's
      `Used this week` moved, the admin's did not. Attribution is run → project → owner.
- [ ] **10.2 The week resets on its own.**
      ```sql
      update runs set created_at = now() - interval '10 days' where model='test-seed';
      ```
      Reload. Headroom reappears with no top-up and no grant — the sum simply starts from a
      new Monday (00:00 Asia/Manila).
- [ ] **10.3 The day resets independently.** Move seeded spend to `now() - interval '2 days'`
      — the daily guard clears while the weekly figure stays.

---

## Reporting

One table: case → PASS/FAIL → one-line note, with the **exact refusal wording quoted** for
every gate that fired, plus a screenshot named by case number at each decisive moment
(refusal, badge state, changed figure).

Cases most worth a second look if they pass suspiciously easily:
**2.2** (gate order), **3.2** (in-flight), **6.2** (grant not lifting the daily guard),
**7.1** (self-approval), **7.6** (peer over-grant).

## Cleanup

```sql
delete from runs where model='test-seed';
```

- [ ] Restore `web/.env.local` from `web/.env.local.prod.bak` when finished — or leave it
      on the local stack deliberately. Do not leave it half-restored.
