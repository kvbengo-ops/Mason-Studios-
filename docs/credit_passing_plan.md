# Credit Passing Plan — an editor hands their own weekly headroom to a colleague

**Status:** Plan only. No migration written, no code changed.
**Scope:** `editor` ↔ `trusted_editor`, either direction. **Admins are out of scope** — not as
a party on either end, not as an approver. A pass needs no approval at all.

## The one idea

There are no balances (`docs/spend-model.md`). A weekly allowance is a **ceiling** the render
gate compares a running sum against, and `allowance_grants` is already the table that moves
that ceiling: `user_active_grants_usd` folds every unexpired, unrevoked row into
`getEffectiveWeeklyCapUsd`.

So a pass is not a new mechanism. **A pass is two grant rows**, written together:

| row | `user_id` | `amount_usd` |
|---|---|---|
| credit | the recipient | `+X` |
| debit  | the sender    | `−X` |

Both expire at the same instant. The sum across the team is unchanged — a pass is zero-sum by
construction, which is the entire argument for why nobody has to approve it. Money did not
move, because money never moves here; one editor's ceiling went down by exactly what another's
went up.

### Why two rows and not a new `allowance_transfers` table

Six places state the "active grant" predicate and none of them share code —
`user_active_grants_usd`, `user_active_grants_usd_by_user`, `outstanding_allowance_usd`,
`sidebar_budget_snapshot`, plus two PostgREST row selects in TypeScript.
`web/lib/revoked-grants-drift.test.ts` exists because keeping those six in agreement is a
standing hazard, and 0075 is the story of what it costs to miss one.

A separate transfers table means a **seventh** term all six have to learn. A negative
`allowance_grants` row means **none of them change**. Enforcement, the `/users` column, the
sidebar snapshot, the team-wide outstanding figure and the batched page read all get the right
answer with zero edits and zero drift surface.

`outstanding_allowance_usd` clamps each account at `greatest(0, …)`, so it is worth stating
that this stays exactly zero-sum: the guard below never lets a sender pass more headroom than
they have, so their term drops by `X` and never crosses zero, while the recipient's rises by
`X`. The admin's team-wide number does not move when editors trade.

---

## 1. Migration `0086_pass_allowance.sql`

### 1a. One column, one relaxed constraint

```sql
alter table allowance_grants
  add column transfer_peer_id uuid references profiles(id);

alter table allowance_grants drop constraint allowance_grants_amount_usd_check;
alter table allowance_grants add constraint allowance_grants_amount_usd_check
  check (amount_usd <> 0 and (amount_usd > 0 or transfer_peer_id is not null));
```

The check is not weakened, it is split. `> 0` still holds for every ordinary grant; a negative
row is legal **only** as half of a transfer. Nothing existing can accidentally write one.

`transfer_peer_id` is the counterparty on *both* halves — the sender on the credit row, the
recipient on the debit row. That is what the UI needs ("+400 cr from ana", "−400 cr to ben")
with one join and no self-join, and it doubles as the marker that says "this row is a pass".
`null` on every grant that exists today, and on every future admin/peer approval.

`granted_by` is the **sender** on both rows: they initiated it, and that is who audit should
name. No new attribution column, the same call 0074 made.

### 1b. `pass_allowance()` — the whole feature

> **SUPERSEDED BY A SECURITY REVIEW — do not implement the signature below.**
>
> This section describes `pass_allowance` taking the sender's spendable headroom
> (`p_sender_headroom_usd`) and the expiry (`p_expires_at`) as arguments, while the
> function stayed callable by `authenticated`. Those together were a vulnerability:
> PostgREST exposes every function `authenticated` may execute, so an editor could
> skip the dialog and the Server Action entirely, call `rpc/pass_allowance` with any
> headroom they liked, and move allowance they did not have — and set an expiry that
> outlived the weekly reset the grant is supposed to die with.
>
> What shipped instead, in `supabase/migrations/0087_pass_allowance.sql` section 2:
> the function is **revoked from `public`, `anon` and `authenticated`** and callable
> only by `service_role`; the sender is `p_from_user_id`, authenticated by
> `requireUser()` in the Server Action because the service-role session has no
> `auth.uid()`; the headroom is **computed inside the function under its lock** from
> `user_spend_usd` and `user_active_grants_usd`; and the expiry is **derived** as the
> next Asia/Manila Monday and returned. The only remaining parameters are the two
> figures SQL cannot produce — the weekly base cap (a render.yaml env var) and the
> in-flight render estimate (priced in `lib/models.ts`).
>
> Read the migration, not this section, for the current contract.

```sql
create or replace function pass_allowance(
  p_to_user_id uuid,
  p_amount_usd numeric,
  p_sender_headroom_usd numeric,   -- base weekly cap − week spend − in-flight holds, from TS
  p_expires_at timestamptz,
  p_note text
) returns void
language plpgsql security definer set search_path = public
```

`security definer`, refusing everything itself, exactly like `decide_allowance_request`. It is
the sole writer of a transfer.

**The sender is `auth.uid()`, never a parameter.** This is the principle
`reserve_image_attempt` states in its own comment, and the one the 0085 review flagged when a
path stopped honouring it: *a caller must not be able to name whose budget is spent.* A
`p_from_user_id` argument would be a function that lets anyone drain anyone.

Checks, in order:

1. **Amount** — `p_amount_usd > 0` and finite. A "negative pass" is a pull, not a push.
2. **Not yourself** — `p_to_user_id <> auth.uid()`. Self-passing is a no-op that writes two
   rows; refuse it rather than let it litter the ledger.
3. **Both parties are editors** — `role in ('editor', 'trusted_editor')` for sender *and*
   recipient. An admin on either end raises. This is the "admin out of scope" line, enforced
   where it cannot be bypassed rather than only hidden in the picker.
4. **Both parties are active** — `is_active()` for the sender, `status = 'active'` for the
   recipient (0052/0055). Passing headroom to a pending or rejected account parks budget
   somewhere nobody can use it.
5. **Headroom** — under a lock, see below.

Then two inserts, and return.

### 1c. The one race worth closing

Every other cap in this system is a contention guard and `docs/spend-model.md` says so on
purpose. A pass is different in kind: two tabs racing a render **overshoot** a ceiling
slightly; two tabs racing a pass **mint** headroom that never existed. That earns a lock.

```sql
perform pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('allowance-pass:' || auth.uid()::text)
);

if p_amount_usd > p_sender_headroom_usd + user_active_grants_usd(auth.uid(), now()) then
  raise exception 'pass_allowance: amount exceeds remaining weekly allowance'
    using errcode = 'check_violation';
end if;
```

Per-sender, not global — `reserve_image_attempt`'s global lock exists because the company-wide
daily cap is shared; a pass only threatens the sender's own ledger. The two functions never
take each other's locks, so there is no ordering hazard between them.

The split of the headroom figure is deliberate. `p_sender_headroom_usd` carries the parts
Postgres cannot see — the role default and override live in `render.yaml`/`resolveAccountCaps`,
and in-flight holds are a TS read — the same reason `outstanding_allowance_usd` takes the
weekly defaults as parameters. The **grants term is re-read inside the lock**, because that is
the only term another concurrent pass can move. A render landing in the gap is the ordinary
accepted contention, unchanged.

### 1d. Expiry is forced to end of the Manila week

Not a parameter the sender picks. `endOfManilaWeekIso()` already exists and is what a peer
grant is already forced to (P6).

The debit row expiring matters more than the credit row: **a permanent debit would be a cap cut
nobody decided.** Monday, both halves fall out of `user_active_grants_usd` and the sender's own
allowance is back with no cleanup job — the same arithmetic that already makes the weekly reset
free.

Consequence, stated plainly: unspent passed headroom is not returned on Monday, it simply stops
existing for both parties. Nothing is owed back.

### 1e. RLS

`allowance_grants_select` (`user_id = auth.uid() or can_approve_allowance()`) is unchanged, and
already shows each party their own half.

`allowance_grants_insert_admin` stays on `is_admin()` — the definer RPC owns this write path, so
no session-token insert path widens. The same call 0074 made.

**One new read**, because the recipient picker needs it:

```sql
create or replace function transfer_recipients()
returns table (id uuid, username text, email text, role text)
```

`security definer`, refuses a caller who is not an active editor/trusted editor, returns active
editors and trusted editors other than the caller. Deliberately not a widening of
`profiles_select_admin` or `user_directory` — this returns three columns to people who need to
pick a name, not the directory.

This **is** the privacy widening in this feature: an editor learns their colleagues' usernames
and emails. Same shape as the one P6 accepted for the approval queue, and named here for the
same reason.

---

## 2. TypeScript

### `web/actions/transfer.ts` (new)

```ts
passAllowance(toUserId: string, amountUsd: number, note?: string): Promise<ActionResult>
```

`requireUser()`, then refuse an `admin` caller with a sentence (the RPC refuses too; this is
what turns a 500 into something a person reads — the split `decisionBlockReason` already uses).
Read `getAccountBudgetSnapshot(user.id, profile)`, pass
`weeklyBaseCapUsd − weeklyUsedUsd − heldUsd` as `p_sender_headroom_usd`, and call the RPC
through the caller's own session client (definer function, `auth.uid()` must be real — not
`createAdminClient()`, same as `decideAllowanceRequest`).

Revalidate `SIDEBAR_LAYOUT_PATH` (layout) and `ALLOWANCES_PATH`.

### `web/lib/transfer.ts` (new, not `server-only`)

`passBlockReason({ senderRole, senderId, recipientRole, recipientId, amountUsd, headroomUsd })
: string | null` — the one predicate the action, the dialog and the trigger's visibility all
ask, so three copies cannot drift. Shaped like `decisionBlockReason`, in its own file because
`lib/allowance.ts` is about the *grant workflow* and this is a different one.

Not `server-only`: the dialog is a Client Component. `ProfileRole` is type-only, same as
`lib/allowance.ts`'s.

### `web/lib/spend.ts` — display only, no arithmetic change

`weeklyGrantUsd` is derived (`effectiveWeeklyCapUsd − caps.weeklyCapUsd`) and is **already
correct** with a negative row in the ledger — it just goes negative for a net sender. Only the
breakdown needs to stop calling it "grant":

- `getActiveGrantsSummary` already selects the rows. Add `transfer_peer_id` to the select and
  return `grantedInUsd` / `passedOutUsd` / `receivedUsd` alongside the existing count and
  earliest expiry. One function, no new query, no new SQL.
- `AccountBudgetSnapshot` and `SidebarBudget` carry the three figures through.

---

## 3. UI

- **`components/pass-credits-dialog.tsx`** (new) — recipient combobox from
  `transfer_recipients()`, amount in **credits** (`formatCredits`/`creditsToUsd`, converted at
  the edge per the credit plan's rule), optional note, and the sender's remaining shown above
  the input. Client-side `passBlockReason` fast-fail; the RPC is the real gate.
- **`components/sidebar-budget.tsx`** — a "Pass credits" trigger beside "Request more",
  rendered for `editor`/`trusted_editor` only. Like "Request more", render it
  **unconditionally** and let the dialog explain when headroom is zero — the bug that file's
  own header records is gating a control's *existence* on a computed number.
- Breakdown line becomes three terms where they are non-zero: `allowance / +grant / −passed`.
  A net sender currently reads `+-$2.00 grant`, which is the only thing in the whole feature
  that renders wrong if this step is skipped.
- **`/allowances`** — a "Passes this week" list, in and out, from the caller's own
  `allowance_grants` rows where `transfer_peer_id is not null`. Read-only.

---

## 4. Checks

- `web/lib/transfer.test.ts` — `passBlockReason`: self, admin as sender, admin as recipient,
  pending recipient, amount over headroom, zero/negative/non-finite amount, and the happy path
  in both directions (editor→trusted, trusted→editor).
- `web/actions/transfer.test.ts` — the RPC is called with the session client and never with a
  `p_from_user_id`; an admin caller is refused before the RPC; both revalidate paths fire.
- `web/lib/spend.test.ts` — a negative grant row lowers `getEffectiveWeeklyCapUsd`, and
  `assertWeeklyCapNotExceeded` refuses against the lowered figure. This is the assertion that
  proves the two-row trick actually works end to end.
- `web/lib/version.ts` — `EXPECTED_DB_VERSION` → `"0086"`, which `version.test.ts`'s drift
  guard requires of any new migration.
- `web/types/db.ts` — `transfer_peer_id` on `allowance_grants` plus the two new functions
  (hand-maintained; `db-types-drift.test.ts` is the guard).

Nothing to add to `revoked-grants-drift.test.ts`: no grant aggregate is redefined, which is the
point.

**Deploy order:** migration first, then web — `EXPECTED_DB_VERSION` going to `0086` means a web
deploy ahead of the migration is immediate `schemaDrift`. Same order as 0083/0084/0085.

---

## Deliberately not in scope

- **Cancelling a pass.** No revoke, no pairing id. The inverse of a mis-sent pass is the
  recipient passing it back, which costs zero code and is what you would do with cash. Add it
  when someone actually mis-sends: it needs a shared `transfer_id` so both halves revoke
  together — revoking one half alone would break zero-sum, which is why a partial revoke must
  never be reachable.
- **Passing to or from an admin.** Out of scope by request; the role check in 1b is the one
  place to widen if that changes.
- **Raising the daily burst guard.** A pass moves the weekly ceiling only, exactly like a
  grant. A recipient still cannot burn a large pass in one day, and that property is what makes
  approval-free passing safe.
- **A request/accept handshake.** Headroom arriving unannounced hurts nobody — it only ever
  raises a ceiling.
- **Scheduled or recurring passes.** Everything expires Monday.
