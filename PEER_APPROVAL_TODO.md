# P6 — Peer approval: implementation TODO

**Single source of truth for Claude and Codex.** The spec is `docs/credit-display-plan.md`
§ P6; this file is how it gets built. If the two disagree, this file wins and the plan gets
amended.

**Branch:** `feat/peer-allowance-approval`, two commits off its merge base with `main`, pushed
2026-09-02.
No PR opened yet. (Originally written against `docs/credit-plan` @ `bbd9213`, which was
squash-merged into `main` as `24fcba0`; the branch was rebased onto `main` so the PR shows
only this feature.) This feature adds **`0074`** (originally `0062`, renumbered after a collision — see STATUS).

> **Integration with latest `main` — SETTLED 2026-09-02.** The warning that used to sit
> here was correct and has been acted on. The branch is rebased onto `main` (`72b2a1f`),
> both textual conflicts are resolved (main renamed fal→kie in `0070`; this branch made the
> same tiles admin-only — both survive), and the peer migration is renumbered **`0062` →
> `0074`**. Force-pushed; GitHub shows no conflicts. Full findings that prompted this:
> [`docs/peer-approval-main-integration-findings.md`](docs/peer-approval-main-integration-findings.md).
>
> **That file's central warning was right and is NOT fixed by the rename.** See
> "Production migration ledger is corrupted" below — main's different `0062` really was
> skipped on production, and template v10 really is missing.

**What it does:** an allowance request can be decided by an admin **or** a trusted editor.
Nobody decides their own. A trusted editor's yes is bounded — capped amount, expiry forced
to the end of the current Manila week. Requests above the peer ceiling stay admin-only.

**What it does not do:** it does not change caps, credits, grant arithmetic, or who may
spend. `assertWithinSpendCaps` is untouched. This ships independently of P0–P5.

---

## STATUS — 2026-09-02: rebased on main as `0074`, pushed; nothing read back; production ledger needs repair

Both tracks are written, committed, rebased onto `main` and pushed as `0074`. Two things
have never happened: nobody has read anything back from the database, and no human has seen
one of these screens render. One thing went wrong on production and is not yet repaired.

### Done

- **Code on `feat/peer-allowance-approval`** — 2 commits sitting directly on `main`
  (`72b2a1f`), force-pushed 2026-09-02, GitHub reports no conflicts. No PR opened, by
  request.
- **Migration applied to production** as `0062` on 2026-09-02, then **renumbered to `0074`**
  on the branch after the collision below. Its objects are live and resolve:
  `can_approve_allowance()`, the three widened policies, the rewritten
  `decide_allowance_request`.
- **`setTrustedEditor`, the `/users` role toggle** — new, not in the original plan. See D10:
  `trusted_editor` had no assignment path anywhere in the app, so P6 would have merged
  switched on and inert.
- **Rebased twice onto a fast-moving `main`.** Both conflicts were the same collision: main
  renamed fal→kie in `0070`, this branch made the same tiles admin-only. Both survive —
  `kieBalanceUsd` gated on `adminViewer`.
- **`tsc` clean, lint clean, 1836 passing.**

### 🔴 Production migration ledger is corrupted — unrepaired

**This is the most important thing on this page.** Applying an unmerged migration to
production claimed migration number `0062` in `supabase_migrations.schema_migrations`. Main
had independently created a *different* `0062_seed_template_v10.sql`. When main's migrations
were pushed, the CLI saw `0062` already recorded and **skipped it**. `0063`–`0073` applied
normally, so the ledger reads `0073` and looks perfectly healthy.

Confirmed consequences on production, 2026-09-02:

- **`prompt_templates` has no v10.** Highest is v9.
- **Every compile is running v9.** `actions/compile.ts:94` selects
  `order("version", desc).limit(1)`.
- **Ledger row `0062` is mislabelled** — it holds this feature's statements, not the
  template seed.

Renumbering to `0074` fixed the branch. It fixed nothing on production. Repair needs, as a
deliberate forward-only step: seed template v10, and reconcile the two ledger rows. **Not
done — it needs an owner and authorization.** Tell whoever owns the compiler that v10 has
not been live.

Root cause, recorded so it does not repeat: **a migration number is a shared sequence, and
claiming one from an unmerged branch races every other branch doing the same.** The baseline
check that preceded the apply was run against this branch's migration directory, not against
`main`, and `main` had moved.

### Still to do — in this order

1. **Repair production** (above). Independent of this PR and more urgent than it.
2. **Run the DB read-backs.** Nine `[~]` items in § 3, plus § 5 steps 3 and 6. The script is
   § 8 of this file and **has not been run**. It must go through the dashboard SQL editor:
   each case needs a different `auth.uid()`, and the service-role key bypasses RLS with a
   null uid, so PostgREST cannot impersonate the four roles. **This is the step that proves
   the guard is not UI-only.**
3. **Walk it in a browser** — § 5 steps 4, 5, 7 and 8. Not one of these screens has been
   rendered by anyone. The tests prove the logic and say nothing about whether it is usable.
4. **Then** open the PR. Body is drafted.

### Facts that will bite whoever picks this up

**Production runs `main`, which has none of this.** Zero occurrences of `requireApprover`. A
trusted editor on the live app today sees no nav link and is bounced off `/allowances`.

**The database is ahead of the deployed code.** `profiles_select_admin` is already widened on
production: a trusted editor *could* read every profile row through PostgREST right now.
There are zero trusted editors, so the exposure is theoretical — but it starts now.

**`0074` will replay on the next `db push`.** The ledger records this feature's statements
under `0062`, so `0074` looks unapplied. Harmless — the migration is `create or replace` and
`alter policy` throughout — but expect it, and do not read it as evidence of a problem.

**`main` moves fast.** Three pushes in two hours on 2026-09-02. This branch goes stale
quickly; rebase immediately before merging, not a day earlier.

**Two of main's own tests are failing**, independent of this branch and verified on
`main` itself: `lib/spend-seam.test.ts` and `lib/dev-seam.test.ts` can no longer find
`actions/ugc.ts`. That is the guard that every render path checks the spend cap, and it is
currently not watching the new UGC route. Someone should own that separately.

### Corrections to this file's own earlier claims

- **The test baseline was never 927.** It is 1778 now, and was ~1770 when this file was
  written. `AGENTS.md`'s "927 tests across 74 files" is stale by a wide margin.
- **There is no `'suspended'` profile status.** `profiles.status` is
  `pending` / `active` / `rejected` (`0052:50`). This file said "suspended" in five places;
  all now read `rejected`. The predicate checks `status = 'active'`, so behaviour was always
  right — only the wording was wrong, and it was wrong in the direction that invites someone
  to write `status = 'suspended'` in a migration, where no type would catch it.
- **D1 was false.** See D10.

### Deviations from this file, and why

| # | This file said | What was built | Why |
|---|---|---|---|
| 1 | `can_approve_allowance()` = `role in ('admin','trusted_editor')` | `role = 'admin' or (role = 'trusted_editor' and status = 'active')` | `trusted_editor` is the FIRST approval-requiring role to appear in a privileged predicate. Without the status half, an account an admin **rejected** could still approve grants through a direct RPC call, even though `requireApprover` → `requireUser` → `canUseApp` bounces them to `/pending` in the app. The expression is now `canUseApp`'s exact rule, so the two cannot disagree. |
| 2 | CL-4: map the *"may not decide their own"* raise to a returned message | Both new raises stay **thrown** | `actions/allowance.ts` already documents the rule for exactly this case: 0032's `is_admin()` raise is deliberately unmapped because `requireAdmin()` guarantees it, so it firing means something is broken. `decisionBlockReason` guarantees the self-decision rule the same way — same session identity, same row, no race between them — so mapping it would have made the file inconsistent with its own stated rule for no gain. The spec was wrong; the code follows the codebase. |
| 3 | Contract § 1 listed two pure helpers | A **third** shipped: `peerDefaultGrantAmountUsd(requestedUsd, peerMaxGrantUsd)` | The clamp was inline in two places (the action, and the dialog's `Math.min` at `decide-allowance-request-dialog.tsx:76`) and untestable where it lived, because `WEEKLY_CAP_USD` is a module-level constant. It matters for a real configuration, not a hypothetical one: at a **$12** ceiling — and the P6 caps table sets `DAILY_CAP_USD` to 12 — a $12 request pre-fills at $15 and the approver is refused a request they are entitled to approve. Now one export with a direct test. |

**One file outside both track lists was touched:** `web/lib/version.ts`'s
`EXPECTED_DB_VERSION`, now `0074`. `lib/version.test.ts` is a drift guard that
fails CI the moment a migration is added without it. It belongs to whoever adds the
migration; CL took it.

**One optional CX follow-up:** the dialog's own `Math.min(defaultGrantAmountUsd, peerMaxGrantUsd)`
can now import `peerDefaultGrantAmountUsd` instead. Behaviour is identical today — this is
about the two pre-fills not drifting later, not a bug.

---

## 0. Decisions already made — do not relitigate

Both agents work from these. If one turns out to be wrong, say so in a comment on this file;
don't quietly build the other thing.

| # | Decision | Why |
|---|---|---|
| D1 | Authority rides on the existing `trusted_editor` role. No new role, no `can_approve` column. | The role already means "trusted with more money". ~~Admins already assign it on `/users`.~~ **False — corrected 2026-09-02, see D10.** |
| D10 | **`trusted_editor` had no assignment path in the app. P6 now adds one** — an editor ↔ trusted_editor toggle on `/users` (`setTrustedEditor`, `actions/account.ts`). Promotion to `admin` stays refused. | Found while proving the migration: `decideAccountApproval` (`actions/account.ts:67`) writes `status` only, and nothing in `web/` wrote `profiles.role` — `role-badge.tsx` merely renders it. The role had been unassignable since `0031`, so P6 would have shipped switched on and inert (production had **zero** `trusted_editor` rows: 2 admins, 14 active editors). Built rather than left to a dashboard UPDATE because the UPDATE was already the recovery path `0052` was written to eliminate, and this hands out spend. Scoped to the editor tiers only: that clears `users/page.tsx`'s own bar for adding a control ("grants an admin no power they did not already have"), while `→ admin` does not — it is a real escalation, it is not reversible by the granting admin, and a demote path must refuse unseating the last admin or `/users` becomes unreachable. See § 6. |
| D2 | `is_admin()` is **never** widened. A new `can_approve_allowance()` sits beside it. | `is_admin()` also gates the Character Library, `/users`, `/spend` and every cross-account read in `0002_rls.sql`. |
| D9 | `can_approve_allowance()` requires `status = 'active'` for the trusted-editor branch, not for admins. | Added during CL-1 — see Deviation 1. Mirrors `canUseApp`: admins are trusted by role, editor tiers need approval. |
| D3 | Self-decision is blocked for **everyone**, admins included. | One check. An exception costs more than not having one. |
| D4 | Peer ceiling = `WEEKLY_CAP_USD` (6,000 cr at the P6 caps). Requests above it are **read-only** for peers — approve *and* deny. | Denying a big ask an admin would have approved is as bad as approving it. |
| D5 | For a non-admin approver the action **overrides** expiry to `endOfManilaWeekIso()` rather than validating what was sent. | Nothing to validate, nothing to fast-fail, nothing to keep in sync. The picker is hidden for peers. |
| D6 | Numeric bounds live in TS (`lib/allowance.ts`); the DB owns identity (role, self-decision) and atomicity. | Exactly the split `grantExpiryError` + `decide_allowance_request` already use. |
| D7 | `profiles_select_admin`'s predicate widens to `can_approve_allowance()` — a peer can read every profile row. | The queue view inner-joins `profiles`; see CL-2. The narrow alternative is named in § 6. |
| D8 | The two team-wide tiles on `/allowances` (Account funds, Outstanding allowance) are **hidden from peers**, not widened. | They read `runs` / `projects` / every `profiles` row through `security invoker` SQL. Widening those is a far bigger blast radius than this feature needs. |

---

## 1. The contract — locked before either track starts

Both tracks code against these signatures. **Claude lands them first, empty-bodied if
necessary, in one small commit** (CL-0) so Codex is never blocked.

```ts
// web/lib/allowance.ts — client-safe, no `server-only`, same as grantExpiryError

/**
 * Why this caller may not decide this request, or null when they may.
 * Mirrors grantExpiryError's shape exactly: string | null, pure, no I/O.
 * Three callers: the Server Action (authoritative), the page (decides
 * whether to render the triggers at all), the dialog (fast-fail).
 */
export function decisionBlockReason(args: {
  approverRole: ProfileRole;
  approverId: string;
  requesterId: string;
  requestedUsd: number;
  peerMaxGrantUsd: number | null;
}): string | null;

/** Why this grant amount is refused for a non-admin approver, or null. Admins skip it. */
export function peerGrantAmountError(amountUsd: number, peerMaxGrantUsd: number): string | null;
```

```ts
// web/actions/guard.ts — next to requireAdmin, same shape
export function isApprover(profile: Profile): boolean;   // role === 'admin' || 'trusted_editor'
export async function requireApprover(): Promise<{ user: User; profile: Profile }>;
```

**Prop added to `DecideAllowanceRequestDialog`:**

```ts
/** lib/spend.ts's WEEKLY_CAP_USD, resolved server-side by the page. null for an admin — no ceiling applies. */
peerMaxGrantUsd: number | null;
```

`peerMaxGrantUsd` is a **plain number prop, never an import.** `lib/spend.ts` throws at
module load on a malformed cap env var and must not be reached from a Client Component —
the page already resolves it through the dynamic `import("@/lib/spend")` block at
`allowances/page.tsx:203`.

**One ambiguity, settled here:** a `null` `peerMaxGrantUsd` means "admin, no ceiling" in the
dialog, but in `decisionBlockReason` a `null` ceiling for a **non-admin** means the cap could
not be resolved and every decision is blocked. Fail closed. The two readings never collide
because the role is always passed alongside.

---

## 2. Split — no file is owned by both agents

| Track | Owner | Files |
|---|---|---|
| **CL** — authority | Claude | `supabase/migrations/0074_*.sql`, `web/actions/guard.ts`, `web/lib/allowance.ts`, `web/actions/allowance.ts`, `web/actions/guard.test.ts`, `web/actions/allowance.test.ts`, `web/lib/allowance.test.ts` |
| **CX** — surface | Codex | `web/app/(app)/allowances/page.tsx`, `web/components/decide-allowance-request-dialog.tsx`, `web/app/(app)/layout.tsx`, `web/components/sidebar-shell.tsx`, `web/components/nav-links.tsx`, `AGENTS.md`, `docs/spend-model.md`, `docs/credit-display-plan.md` |

Only `web/lib/allowance.ts` is read by both. **Claude writes it, Codex imports it.** If Codex
needs a new export, it goes in this file as a request — not into that file directly.

**Order:** CL-0 lands → CL and CX run in parallel → CL-1..4 must be merged before CX's page
work can be exercised for real → joint verification (§ 5).

---

## 3. CL — Claude's track (authority)

**Marks:** `[x]` = built *and* proven. **All nine former `[~]` items were read back on
production 2026-09-02 and passed** — see § 8's result block. The legend below is kept for
history: `[~]` = built and **applied**, proof still outstanding —
every one of these is a SQL statement whose result nobody has read back. The migration went onto
production on 2026-09-02, so these are no longer blocked on access; they are blocked on
somebody running the script and pasting the table. Nothing in this lane is unbuilt.

Item text below has been rewritten to describe **what shipped**, not what was originally
specified — three things diverged, and the STATUS section at the top of this file explains
why for each.

### CL-0 · Land the contract stubs — done
- [x] `isApprover` / `requireApprover` in `web/actions/guard.ts`, directly below
      `requireAdmin`. `requireApprover` throws `AuthorizationError` exactly like
      `requireAdmin`: every approver control is hidden from a non-approver, so reaching it
      means the UI was bypassed, not that an operator hit an expected refusal. Its doc
      comment carries the split — this guard answers "may this account decide anything at
      all", `decisionBlockReason` answers "may it decide THIS request".
- [x] `decisionBlockReason` and `peerGrantAmountError` in `web/lib/allowance.ts`, beside
      `grantExpiryError`. That file stays free of `server-only`; both new imports are safe
      across the client boundary (`ProfileRole` is type-only, `lib/format-usd.ts` documents
      its own client-safety at its line 20).
- [x] A **third** export shipped that the contract did not list:
      `peerDefaultGrantAmountUsd(requestedUsd, peerMaxGrantUsd)`. See Deviation 3 — the
      clamp existed inline in two places and was untestable where it lived.
      *Verified:* `tsc --noEmit` clean; Codex's page and dialog import all of it without
      adaptation.

### CL-1 · Migration `0074` — `can_approve_allowance()` — applied and PROVEN
- [x] `create or replace function can_approve_allowance()`, modelled on `is_admin()`
      (`0002_rls.sql:12`): `security definer`, `set search_path = public`, `stable`.
      Predicate as built — **not** the flat role list this file first specified:
      `role = 'admin' or (role = 'trusted_editor' and status = 'active')`.
      The status half is Deviation 1 (and D9): `trusted_editor` is the first
      approval-requiring role to enter a privileged predicate, and without it a **rejected**
      account could still approve grants through a direct RPC call. This is `canUseApp`'s
      exact rule, so the app guard and the database predicate cannot disagree.
- [x] `comment on function` states what it is **not**: not a substitute for `is_admin()`, and
      never to be used to gate the Character Library, `/users` or `/spend`.
      *Unproven:* needs `select can_approve_allowance()` read back as an admin, an active
      trusted editor, a **rejected** trusted editor, and a plain editor — four cases now,
      not three, because of the status half.

### CL-2 · Migration `0074` — the three RLS widenings, and only three — applied and PROVEN
- [x] `alter policy allowance_requests_select on allowance_requests using (user_id = auth.uid() or can_approve_allowance())` (`0032:100`), with a `comment on policy`.
- [x] `alter policy allowance_grants_select on allowance_grants using (user_id = auth.uid() or can_approve_allowance())` (`0032:186`), with a `comment on policy`.
      Required, not cosmetic: `user_active_grants_usd_by_user` (`0033:82`) is
      **`security invoker`**, so without this the approve dialog's active-grants figure reads
      $0 for every requester except the peer themselves — a wrong number in front of someone
      deciding whether to add to it, which is the worst shape this bug could take.
- [x] `alter policy profiles_select_admin on profiles using (can_approve_allowance())`
      (`0002_rls.sql:33`). **The load-bearing one.** `allowance_request_directory`
      (`0032:337`) is `security_invoker = true` and does `join profiles p on p.id = r.user_id`
      — an **inner** join. Left on `is_admin()`, a peer's queue renders empty with no error.
      The policy keeps its name; its `comment on policy` records that the name is now
      historical and names the narrower alternative that was rejected.
- [x] `alter policy` throughout, never `drop` + `create` — same reasoning `0033`'s header
      gives. *(Verifiable by reading the migration; no database needed.)*
- [x] `allowance_requests_update` (`0032:121`) and `allowance_grants_insert_admin`
      (`0032:195`) left on `is_admin()`, deliberately. `decide_allowance_request` is
      `security definer` and neither table has `force row level security`, so the function
      bypasses RLS on the write path — these two are not in it. Widening them would open a
      session-token write path straight at PostgREST that nothing needs. The migration says
      so in a comment block of its own. *(The plan's P6 section listed five policy changes;
      CX-6 corrected it to three.)*
      *Unproven:* on a trusted-editor session, `select * from allowance_request_directory`
      must return another user's pending row with `user_email` populated, while
      `update allowance_requests set status='approved'` on that same row is still refused.

### CL-3 · Migration `0074` — `decide_allowance_request` — applied and PROVEN
- [x] `create or replace function decide_allowance_request(...)`, identical signature
      (`0032:275`) — same five params, same `returns allowance_requests`.
- [x] First statement is now
      `if not can_approve_allowance() then raise exception 'decide_allowance_request: % is not an approver', decided_by_id; end if;`
- [x] Second reads the row's `user_id` into `requester_id` and raises
      `'decide_allowance_request: % may not decide their own request'` when it equals
      `decided_by_id` — **before** the UPDATE, so a self-decision never writes anything.
      A non-existent request leaves `requester_id` NULL, `null = decided_by_id` is NULL not
      true, and control falls through to the existing 'is not pending (or does not exist)'
      raise — the pre-existing error is preserved, not shadowed.
- [x] Everything else — the `where status = 'pending'` UPDATE, the `updated_request.id is
      null` re-check, the atomic grant insert — is byte-for-byte unchanged.
      *(Verifiable by diffing against `0032:275`; no database needed.)*
- [x] `comment on function` rewritten: says "approver", names both caller rules, and states
      that the amount ceiling is deliberately **not** enforced here and why.
      *Unproven:* a trusted editor's own pending request must raise; the same trusted editor
      deciding a colleague's must write decision and grant together. **This is the step that
      proves the guard is not UI-only** — do not skip it.

### CL-4 · `actions/allowance.ts` — the enforcement the DB can't express — done
- [x] `requireAdmin()` → `requireApprover()`, keeping `{ user, profile }` — both are needed.
- [x] `.select(...)` widened to include `user_id`, with a comment saying why.
- [x] `decisionBlockReason` called after the not-found / not-pending checks, so the more
      specific state error ("already denied") wins when both apply. `WEEKLY_CAP_USD` is
      passed unconditionally — the function returns early for an admin and never reads it,
      so there is no role branch here to keep in sync with the one inside it.
- [x] Non-admin approver on an approval: the **default** amount is clamped through
      `peerDefaultGrantAmountUsd`, a **typed** amount is refused by `peerGrantAmountError`
      (never silently lowered), and `options.expiresAt` is **ignored entirely** in favour of
      `endOfManilaWeekIso()` (D5). The admin path — including the 90-day `grantExpiryError`
      check — is untouched.
- [x] **Neither** new RPC raise is mapped to a returned message; both stay thrown. This
      reverses what this file originally specified — see Deviation 2. `requireApprover`
      guarantees the first and `decisionBlockReason` the second, both off the same session
      identity and the same row, so neither can legitimately fire; mapping them would have
      contradicted the rule the file already states for 0032's `is_admin()` raise. The
      comment there records the reversal so the next reader does not "fix" it back.
      *Verified:* `web/actions/allowance.test.ts`, 26 tests.

### CL-5 · Tests — done
- [x] `web/lib/allowance.test.ts` (22) — `decisionBlockReason` truth table: admin/other,
      trusted/other at and under the ceiling, admin/self, trusted/self, trusted/over-ceiling,
      plain editor, and every unusable ceiling (`null`, `0`, `-1`, `NaN`) blocking a peer
      while never blocking an admin. `peerGrantAmountError` at, just under and just over.
      `peerDefaultGrantAmountUsd` including the case that justifies it — a **$12** ceiling,
      where `defaultGrantAmountUsd(12)` overshoots to $15 — plus a sweep asserting the
      pre-fill can never produce something `peerGrantAmountError` would then refuse.
- [x] `web/actions/guard.test.ts` (17) — `requireApprover` admits admin and trusted editor,
      refuses a plain editor, and bounces a **rejected** trusted editor to `/pending`
      through the inherited `canUseApp` gate (the app-side twin of CL-1's status half).
- [x] `web/actions/allowance.test.ts` (26) — every peer refusal asserts the RPC was **never
      called**, not merely that a message came back; an implementation that refused after
      writing the decision would pass a message-only assertion.
- [x] `web/lib/client-boundary.test.ts` still passes — the thing that catches `lib/spend.ts`
      leaking into a Client Component through the new prop.
      *Verified:* full suite **1769/1770**. The single failure is
      `components/account-menu.test.tsx`'s hover-delay test: passes in isolation, untouched
      by either track, a Radix timing flake under parallel load. Pre-existing.
      *(The "927-test baseline" this file and `AGENTS.md` both cite is stale — see STATUS.)*

### CL-6 · Consequence of adding a migration — done
- [x] `web/lib/version.ts`'s `EXPECTED_DB_VERSION` is `0074`, comment updated.
      `lib/version.test.ts` is a drift guard that fails CI the moment a migration lands
      without it. This file is in neither track's list; it belongs to whoever adds the
      migration, which was CL. Flagged here so it is not discovered twice.
      *Verified:* `bun run test lib/version.test.ts`.

### Left for whoever runs the read-backs
CL-1, CL-2 and CL-3 are applied SQL whose result nobody has looked at. In order:

1. ~~Confirm the applied schema version first.~~ **Done 2026-09-02.** The project reported
   `0061` via `applied_schema_version()` with no gaps in `0056`–`0061`, so the migration
   landed on what looked like a known baseline. **This check was insufficient** — it read
   this branch's migration directory, not `main`'s, and `main` had already claimed `0062`.
   See STATUS. `DEV_A_TODO.md`'s "through `0055`, `0056`–`0058` outstanding" line was
   stale by five migrations; corrected there.
2. ~~Apply the migration.~~ **Done 2026-09-02**, via `supabase db push`, as `0062`.
   `can_approve_allowance()` resolves. Production later reached `0073` via main's own
   migrations; the file is now `0074` on this branch. See STATUS for what this broke. The CLI recorded it in
   `supabase_migrations.schema_migrations`, so the sidebar's drift readout is honest — a raw
   SQL-console apply would have left the ledger saying `0061` forever.
3. **← YOU ARE HERE.** Run the four `can_approve_allowance()` cases (CL-1), the
   directory-read and refused-write pair (CL-2), and both `decide_allowance_request` raises
   (CL-3).

   A script doing all of it exists and **has not been run**. It creates its own fixtures —
   production has no `trusted_editor` and no pending request — and ends in a deliberate
   `raise exception` carrying the results table, so the rollback is structural rather than
   something the operator has to remember. An `ERROR` in the editor is the success case.

   It must run in the **dashboard SQL editor**, not through PostgREST: each case needs a
   different `auth.uid()`, and the service-role key bypasses RLS with a null uid, so the
   four identities cannot be impersonated from the REST API at all.
4. § 5 steps 3 and 6 are the same work; tick them together.

Until then: the code is written, the TypeScript half is proven and the migration is live,
but **nothing about it has been read back**. Do not describe `0074` as verified.

---

## 4. CX — Codex's track (surface)

### CX-1 · `/allowances` admits approvers
- [x] `requireAdmin()` → `requireApprover()` (`allowances/page.tsx:113`), keeping the returned
      `profile` and `user` — the page needs `profile.role` and `user.id` for every row.
- [x] Update the "Session client, same as /users" comment two lines below: the database still
      does the scoping, now via `can_approve_allowance()`.
- [x] Inside the existing `try { await import("@/lib/spend") }` block (`:203`), also read
      `spend.WEEKLY_CAP_USD` into `peerMaxGrantUsd`. On import failure it stays `null`, and a
      `null` ceiling for a non-admin blocks every decision (§ 1). Fail closed — the fail-soft
      fallback in that block is for the expiry default only.
- [x] Per row, call `decisionBlockReason(...)` and pass the result down. Do not reimplement
      the predicate in JSX.

### CX-2 · The two team-wide tiles go admin-only
- [x] Skip the `getOutstandingAllowanceUsd` and `getFalAccountBalanceUsd` calls entirely for a
      non-admin viewer — don't render-then-hide, and don't call-then-discard.
      `outstanding_allowance_usd` (`0035:59`) is `security invoker` and scans every
      `profiles` / `runs` / `projects` row; for a peer it returns a silently **under-counted**
      number, which is worse than no number. Account funds is a `/spend`-grade figure, and
      `/spend` stays admin-only.
- [x] The summary grid becomes admin-only. Queue, search, sort and pagination are unchanged
      for both roles.
- [x] `outstandingAllowanceUsd` and `accountFundsUsd` already reach the dialog as nullable
      props — pass `null` for a peer, which the component already renders as
      "Unknown" / omitted (see its own prop docs). No new null-handling.

### CX-3 · Rows a peer may not decide
- [x] Where `DecideAllowanceRequestDialog` renders today, a non-null `decisionBlockReason`
      renders **the reason** in place of the triggers — not a disabled button with no
      explanation. Two reasons exist and they read differently: "Your own request" and
      "Over your approval limit — needs an admin."
- [x] Admins see no change on this page except their own requests, which they now also cannot
      decide (D3).

### CX-4 · `DecideAllowanceRequestDialog` peer mode
- [x] Add the `peerMaxGrantUsd: number | null` prop (§ 1). `null` = admin = today's behaviour,
      exactly.
- [x] When it is a number: `max` on the amount input, `peerGrantAmountError` in
      `handleApprove` beside the existing `grantExpiryError` fast-fail, and the ceiling stated
      in the dialog copy.
- [x] When it is a number: **hide the expiry field.** End of week is the only legal value (D5)
      and the server forces it regardless — a picker that cannot change anything is a trap.
      `defaultExpiresAtIso` still arrives and is still sent; only the input goes.
- [x] `defaultGrantAmountUsd` rounds **up** to the nearest $5, so the pre-fill can land above
      the ceiling. Clamp the pre-fill here. **Do not change `defaultGrantAmountUsd`** —
      rounding up is correct for an admin, and `/allowances` is not its only caller.
      *Proof:* a component test in the shape of
      `web/components/ledger-reconcile-card.test.tsx` — peer mode renders no expiry input and
      refuses an over-ceiling amount client-side.

### CX-5 · Nav plumbing
- [x] `layout.tsx:159` passes one `showAdminLinks={isAdmin(profile)}` flag for four links. Add
      a second boolean for `/allowances`, threaded `sidebar-shell.tsx:92` → `nav-links.tsx:40`,
      sourced from `isApprover(profile)`.
- [x] `/library`, `/spend` and `/users` stay strictly `isAdmin`. Do not fold them into one
      "staff" flag — that is the same mistake D2 exists to prevent, one layer up.
- [x] `nav-links.tsx:49` composes the array from both flags. The `ALLOWANCES_LINK` label stays
      "Allowance requests".

### CX-6 · Docs
- [x] `AGENTS.md` § Spend caps: "Role-tiered caps pair with a request → admin-grant workflow"
      becomes approver-grant, with the three peer bounds and the self-decision rule stated.
- [x] `docs/spend-model.md`: the same correction everywhere it says an admin approves.
- [x] `docs/credit-display-plan.md` § P6: correct the RLS list from five policies to three,
      and record that `allowance_requests_update` / `allowance_grants_insert_admin`
      deliberately stay on `is_admin()` (CL-2). Add the `profiles_select_admin` inner-join
      trap — it is the single most missable part of this feature.
- [x] Add one row to `AGENTS.md` § Boundaries to respect: *"An allowance decision goes through
      `requireApprover`, never `requireAdmin` — and nobody, admin included, decides their own
      request."*

---

## 5. Joint verification — nobody reports done before this

In order. **Steps 1, 2, 3 and 6 are done. Steps 4, 5, 7 and 8 — every one of them a
browser check — have not been started.** Nothing here has
been seen rendered by a human, and nothing in the database has been read back. Step 0, the
production ledger repair in STATUS, is not on this list because it is not this feature's
verification — it is a live defect this feature caused, and it outranks all of it.

1. [x] **`tsc --noEmit`** across `web/` — clean, including the CL/CX seam. Note `make check`
   itself has not been run: it also covers the Go worker, which this feature does not touch.
2. [x] **`bun run test`** from `web/` — not `bun test`. **1836 passing** on the rebased
   branch. Two failures, both verified to fail on `main` itself with this branch checked
   out nowhere: `lib/spend-seam.test.ts` and `lib/dev-seam.test.ts`. The
   `components/account-menu.test.tsx` hover-timing flake also appears under parallel load
   and passes in isolation. The "927-test" baseline was stale by a wide margin.
3. [x] **Read back `can_approve_allowance()`** as an admin, an active trusted editor, a
   **rejected** trusted editor, and a plain editor — four cases, not three. **Done
   2026-09-02, all four correct.** admin=true, trusted+active=true, trusted+not-active=false,
   plain editor=false. Full output in § 8.
4. [ ] **Peer happy path, in the app:** a trusted editor sees `/allowances` in the nav, opens
   it, sees a colleague's pending request with an email on it, approves 1,000 cr, and the
   colleague's weekly headroom moves.
   **Now possible** — `setTrustedEditor` (D10) means there is finally a way to make one.
   Needs two accounts and a pending request: production has **no** pending requests, and a
   peer cannot decide their own, so an editor has to file one first.
5. [ ] **Peer refusals, in the app:** own request → reason shown, no triggers. Over-ceiling
   request → reason shown, no triggers.
6. [x] **Bypass check** — **Done 2026-09-02. The guard is not UI-only.** Calling the RPC
   directly as the trusted editor on their OWN request raised
   `decide_allowance_request: 60b41331… may not decide their own request`; as a plain editor
   it raised `… is not an approver`. The peer's decision on a COLLEAGUE's request wrote both
   the decision row and the grant. A peer's raw `UPDATE` to approve a colleague's request
   matched **0 rows** under RLS.
7. [ ] **Admin regression:** an admin's approve/deny, the 90-day expiry, and both summary
   tiles are unchanged.
8. [ ] **`/users` toggle, in the app (new, D10):** promote an active editor, confirm the
   badge flips and `/allowances` appears in their nav; demote, confirm it goes away. An
   admin row must offer no toggle at all.

---

## 6. Known ceilings — recorded, not fixed

- **A trusted editor can over-grant a *colleague* by calling the RPC directly**, because the
  amount ceiling lives in TS (D6). Same exposure `MAX_GRANT_EXPIRY_DAYS` already accepts for
  admins. Upgrade path: a literal fuse inside `decide_allowance_request` refusing any
  non-admin grant above a hard number. Do it if the role stops being a small, hand-picked set.
- **D7 widens profile visibility to every approver.** The narrow alternative, if it ever
  matters: a separate policy gated on `exists (select 1 from allowance_requests r where
  r.user_id = profiles.id or r.decided_by = profiles.id)`. Rejected for now — it puts a
  subquery on the hottest table in the app for a privacy gain nobody has asked for.
- **A peer sees no team-wide context on `/allowances`** (D8). If that starts mattering, the
  fix is a peer-safe aggregate, not widening `runs` / `projects`.
- **No admin promotion, and no last-admin guard** (D10). `setTrustedEditor` moves accounts
  between `editor` and `trusted_editor` only; `'admin'` is in neither direction's
  `CHANGEABLE_FROM` list, which is what makes an admin row untouchable by any userId handed
  to the action. Making anyone an admin is still a dashboard UPDATE, deliberately. Upgrade
  path, if it is ever wanted: it needs a refusal to demote the last remaining admin and a
  refusal to demote yourself, and those two guards are most of the work — not the role write.

## 7. Out of scope

A dedicated approver role or `can_approve` column; per-approver budgets (how much one person
may hand out per week); two-approver sign-off; notifications or queue routing; letting a peer
grant more than was requested; anything in P0–P5.

---

## 8. The `0074` read-back script (§ 5 steps 3 and 6)

Lives here rather than in a file so it cannot drift from the instructions above, and cannot
be mistaken for a migration. Paste whole into the **Supabase SQL editor**.

**It has not been run.** Whoever runs it should paste the resulting table back into § 5.

Three things to know before running:

- **Safe on production.** Every fixture is created inside the block, and the block ends in a
  deliberate `raise exception`, so Postgres rolls all of it back. The rollback is structural
  — not something the operator has to remember to type.
- **An `ERROR` in the editor is the success case.** The results table arrives *as* the error
  message. Read it there.
- **It borrows two real profiles** and mutates them in-transaction (one editor is promoted to
  `trusted_editor`), because production has no `trusted_editor` and no pending request to
  test against. Nothing survives the rollback. If those two ids no longer exist, swap them —
  any admin, any two active editors.

```sql
-- =============================================================================
-- 0074 read-back proof — PEER_APPROVAL_TODO.md § 5 step 3 + step 6 (CL-1/2/3)
--
-- Paste whole into the Supabase SQL editor and run. Safe on production:
-- every fixture is created inside this block and the block ENDS IN A
-- DELIBERATE `raise exception`, so Postgres rolls the whole thing back. The
-- rollback is structural, not something you have to remember to type. The
-- results arrive AS the error message — an "ERROR" in the editor is the
-- expected, successful outcome here. Read the table in it.
--
-- Actors: two real profiles are borrowed and mutated in-transaction (one
-- editor is promoted to trusted_editor), because production has NO
-- trusted_editor rows to test against. Nothing survives the rollback.
-- =============================================================================
do $$
declare
  v_admin  uuid := 'd10a477d-585a-4c57-a233-dd7b5f71e64c';  -- real admin
  v_te     uuid := '60b41331-3598-491d-9f2b-e603d91fc11c';  -- editor -> trusted_editor for this txn
  v_ed     uuid := '2d5ea637-4100-449d-99fc-85edb4360920';  -- stays a plain editor; the requester
  v_req_te uuid;
  v_req_ed uuid;
  v_owner  text := current_user;
  v_bool   boolean;
  v_int    integer;
  v_grants_before integer;
  v_report text;
begin
  create temp table proof_0074 (n serial, step text, expected text, actual text) on commit drop;

  -- --- fixtures -------------------------------------------------------------
  update profiles set role = 'trusted_editor', status = 'active' where id = v_te;
  insert into allowance_requests (user_id, requested_usd, reason)
    values (v_te, 50, '0074 proof: self-decision') returning id into v_req_te;
  insert into allowance_requests (user_id, requested_usd, reason)
    values (v_ed, 50, '0074 proof: peer decision') returning id into v_req_ed;
  select count(*) into v_grants_before from allowance_grants where user_id = v_ed;

  -- === CL-1 · can_approve_allowance(), four identity cases ==================
  -- security definer, so no role switch needed; only auth.uid() matters.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  select can_approve_allowance() into v_bool;
  insert into proof_0074 (step, expected, actual) values ('CL-1 admin', 'true', v_bool::text);

  perform set_config('request.jwt.claims', json_build_object('sub', v_te)::text, true);
  select can_approve_allowance() into v_bool;
  insert into proof_0074 (step, expected, actual) values ('CL-1 trusted_editor active', 'true', v_bool::text);

  update profiles set status = 'rejected' where id = v_te;
  select can_approve_allowance() into v_bool;
  insert into proof_0074 (step, expected, actual) values ('CL-1 trusted_editor NOT active', 'false', v_bool::text);
  update profiles set status = 'active' where id = v_te;   -- restore for the rest

  perform set_config('request.jwt.claims', json_build_object('sub', v_ed)::text, true);
  select can_approve_allowance() into v_bool;
  insert into proof_0074 (step, expected, actual) values ('CL-1 plain editor', 'false', v_bool::text);

  -- === CL-2 · RLS: peer reads the queue, still cannot write it ==============
  -- Needs a real role switch — the editor session is an owner and bypasses RLS.
  perform set_config('request.jwt.claims', json_build_object('sub', v_te)::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*) into v_int
    from allowance_request_directory
   where id = v_req_ed and user_email is not null;
  perform set_config('role', v_owner, true);
  insert into proof_0074 (step, expected, actual)
    values ('CL-2 peer reads colleague row + email', '1', v_int::text);

  perform set_config('role', 'authenticated', true);
  update allowance_requests set status = 'approved' where id = v_req_ed;
  get diagnostics v_int = row_count;
  perform set_config('role', v_owner, true);
  insert into proof_0074 (step, expected, actual)
    values ('CL-2 peer direct UPDATE refused (rows)', '0', v_int::text);

  -- === CL-3 · decide_allowance_request(), both new raises ===================
  -- Each in its own sub-block so a caught raise does not abort the outer txn.
  begin
    perform decide_allowance_request(v_req_te, true, 25, now() + interval '7 days', '0074 proof');
    insert into proof_0074 (step, expected, actual)
      values ('CL-3 self-decision raises', 'raise', 'NO RAISE — BUG');
  exception when others then
    insert into proof_0074 (step, expected, actual)
      values ('CL-3 self-decision raises', 'raise: may not decide their own request', sqlerrm);
  end;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_ed)::text, true);
    perform decide_allowance_request(v_req_ed, true, 25, now() + interval '7 days', '0074 proof');
    insert into proof_0074 (step, expected, actual)
      values ('CL-3 non-approver raises', 'raise', 'NO RAISE — BUG');
  exception when others then
    insert into proof_0074 (step, expected, actual)
      values ('CL-3 non-approver raises', 'raise: is not an approver', sqlerrm);
  end;

  -- happy path: the trusted editor decides a COLLEAGUE's request
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_te)::text, true);
    perform decide_allowance_request(v_req_ed, true, 25, now() + interval '7 days', '0074 proof');
    insert into proof_0074 (step, expected, actual)
      values ('CL-3 peer decision writes decision', 'approved',
              (select status from allowance_requests where id = v_req_ed));
    select count(*) - v_grants_before into v_int from allowance_grants where user_id = v_ed;
    insert into proof_0074 (step, expected, actual)
      values ('CL-3 peer decision writes grant', '1', v_int::text);
  exception when others then
    insert into proof_0074 (step, expected, actual)
      values ('CL-3 peer decision writes decision+grant', 'no raise', 'RAISED: ' || sqlerrm);
  end;

  -- === report, then force the rollback ======================================
  select string_agg(
           rpad(step, 42) || rpad(coalesce(expected, ''), 44) || ' got: ' || coalesce(actual, 'NULL'),
           E'\n' order by n)
    into v_report
    from proof_0074;

  raise exception E'\n\n0074 PROOF — all fixtures rolled back\n%\n\n%',
    repeat('-', 110), v_report;
end $$;
```


### Result — run 2026-09-02, all ten checks passed

```
CL-1 admin                             true     got: true
CL-1 trusted_editor active             true     got: true
CL-1 trusted_editor NOT active         false    got: false
CL-1 plain editor                      false    got: false
CL-2 peer reads colleague row + email   1       got: 1
CL-2 peer direct UPDATE refused (rows)  0       got: 0
CL-3 self-decision raises              raise    got: decide_allowance_request: 60b41331… may not decide their own request
CL-3 non-approver raises               raise    got: decide_allowance_request: 2d5ea637… is not an approver
CL-3 peer decision writes decision     approved got: approved
CL-3 peer decision writes grant         1       got: 1
```

This closes every SQL item in § 3 and § 5 steps 3 and 6. The four identity cases, the
inner-join queue read, the refused direct write, both raises, and the atomic
decision-plus-grant are all confirmed against production. **The authority is in the
database, not the UI.**

---

## 9. Production ledger repair (STATUS § "Production migration ledger is corrupted")

**Not run.** Do this before, or in the same sitting as, § 8. It is unrelated to whether this
PR merges — the defect is live on production right now and every compile is affected.

The damage is one skipped migration: main's `0062_seed_template_v10.sql` never executed,
because this feature's migration had already recorded version `0062`. Nothing else was
skipped; `0063`–`0073` applied normally.

### Step 1 — seed the missing template

The body is long, so take it from the repo rather than retyping:

```
git show origin/main:supabase/migrations/0062_seed_template_v10.sql
```

Paste that whole file into the dashboard SQL editor and run it. It is a single
`insert into prompt_templates`. Verify:

```sql
select name, version from prompt_templates order by version desc limit 2;
-- expect ugc-v1 / 10 on top. Before the repair the top row is 9.
```

Compiles pick up v10 immediately — `actions/compile.ts:94` selects
`order("version", desc).limit(1)`. That is the intended behaviour main shipped, but it IS a
live behaviour change, so tell whoever owns the compiler when it happens.

### Step 2 — make the ledger honest

Optional for correctness of behaviour, required for anyone who later trusts the ledger.
Ledger row `0062` currently holds this feature's statements, not the template seed.

```sql
-- relabel 0062 to what it should always have been
update supabase_migrations.schema_migrations
   set name = 'seed_template_v10'
 where version = '0062';

-- record this feature under the number it now has on the branch.
-- Its objects ARE applied, so this is a statement of fact, not a shortcut.
insert into supabase_migrations.schema_migrations (version, name)
values ('0074', 'peer_allowance_approval')
on conflict (version) do nothing;
```

If step 2 is skipped, nothing breaks: `0074` simply looks unapplied and replays on the next
`db push`, which is harmless because the migration is `create or replace` and `alter policy`
throughout. What breaks is anyone's ability to trust what the ledger says happened.

### Do not

- **Do not** delete the `0062` row and re-push. That makes the CLI replay main's template
  seed *and* leaves this feature's objects unrecorded.
- **Do not** renumber anything on `main`. Main's `0062` is correct and already merged; this
  branch is the one that took a number it had not earned.
