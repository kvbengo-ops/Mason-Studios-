# Image Generator — Implementation TODO

> **SUPERSEDED IN ONE RESPECT.** Every task below is complete, and the routes it
> names still exist — but `0085_personal_image_generator.sql` has since removed
> the project requirement. `/image-generator` is no longer the "which project
> pays?" picker CX-7 describes; it is the console itself, guarded by
> `requireUser`, with the asset on `assets.user_id` and the charge on
> `runs.user_id`. `/images/[id]` and everything in this file about it are
> unchanged. Read **"Amendment: the project requirement is gone"** at the top of
> `docs/image-generation-route-plan.md` before using this file for sequencing.

**Single source of truth for implementing `docs/image-generation-route-plan.md`.**
The plan says *what and why*. This file says *who, in what order, and what
counts as done*. If the two ever disagree, the plan wins on design and this file
wins on sequencing — and whoever spots the conflict fixes it here in the same
change.

| Lane | Who | Model | Owns |
|---|---|---|---|
| **ME** | Kyle (human) | — | Decisions, credentials, browser verification, review, merge |
| **CL** | Claude | Opus 5 | Migration, RPC, money lifecycle, security seams, concurrency tests |
| **CX** | Codex | GPT Astra | `lib/kie.ts` callback, storage, all UI, UI/authz tests |

**Why the split is shaped this way:** every task that can silently lose or
double-charge money, or that widens a security boundary, is CL's. Every task
that is fully specified by the plan and verifiable by reading it is CX's. ME
holds anything needing judgment, a real credential, or a human looking at a
screen.

---

## Ground rules for both agents

1. **Read `docs/image-generation-route-plan.md` first, in full.** It carries
   `[VERIFIED]` markers with file:line citations. Do not re-derive them; do not
   contradict them silently. If one is now wrong, stop and say so.
2. **`AGENTS.md` applies.** One task, one change. Ask when unsure. No "while I
   was here" refactors. No models, options or settings nobody asked for.
3. **Do not run tests, lint, tsc or prettier.** Husky and CI run them. Push and
   read CI. (`AGENTS.md`.) ME runs `make check` when a gate calls for it.
4. **Stay inside your file ownership** (table below). If you need a file you do
   not own, stop and hand off — do not edit it.
5. **Tick your own boxes in this file** as you finish, and note anything
   surprising inline under the task. This file is the shared state.
6. **Bun 1.4.2, Go 1.25, `gofmt -l .` prints nothing.**

### File ownership — no shared files between CL and CX

| File | Owner |
|---|---|
| `supabase/migrations/0082_*.sql` | **CL** |
| `web/lib/runs.ts` | **CL** |
| `web/lib/spend.ts` | **CL** |
| `web/actions/image-generator.ts` | **CL** |
| `web/lib/attempt-lifecycle.test.ts` | **CL** |
| `web/actions/image-generator.test.ts` | **CL** (money/authz) → **CX** appends UI cases after CL-6 |
| `web/lib/kie.ts` | **CX** |
| `web/lib/storage.ts` | **CX** |
| `web/types/db.ts` | **CL** (hand-patched at CL-2 — never regenerated, see CL-2) |
| `web/lib/version.ts` | **CL** (`EXPECTED_DB_VERSION`, bumped at CL-2a) |
| `web/app/(app)/projects/[id]/image-generator/page.tsx` | **CX** |
| `web/components/image-generator-form.tsx` | **CX** |
| `web/components/image-generator-history.tsx` | **CX** |
| `web/components/image-generator-form.test.tsx` | **CX** |
| `web/lib/project-rail.ts`, `web/components/project-rail.tsx` | **CX** |
| `docs/image-generator-todo.md` (this file) | anyone, append-only under your own tasks |

---

## Phase 0 — Prerequisites (ME)

- [x] **ME-1** Local stack running. Supabase up, 81/81 migrations applied,
      worker connected, `kvb.engo@gmail.com` promoted to `admin`/`active`.
      See `docs/local-development.md`.
- [x] **ME-2** Next free migration number confirmed: **`0082`**. The plan's note
      about `0079` is stale — `0079`, `0080` and `0081` are all taken on current
      `main`. Re-check at merge time if other PRs land first.
- [x] **ME-3 — DECIDED: mock first.** ("lets try mock first", 2026-09-06.)
      `MODE=development` returns `MOCK_IMAGE_URL` and never calls kie
      (`lib/kie.ts:392-395`), so the whole flow — reserve, settle, store,
      preview, history, download — is exercised free.
      **What mock does not cover, and what to do about it:** the settled cost
      path, where kie's *reported* charge overwrites the estimate. The mock
      returns `costUsd: null` (`lib/kie.ts:394`), so a mock run settles at the
      estimate and the overwrite never happens. That is a real gap, not a
      technicality — it is the difference between what we *think* an image cost
      and what it *did*. It is covered two ways instead:
      CL-7 asserts the overwrite against a stubbed kie result, and ME-9 stays
      open as the one real-money confirmation before this ships to production.
- [ ] **ME-4** *(deferred by ME-3, not cancelled.)* Before ME-9 only: fund the
      kie account and put a real `KIE_API_KEY` in `web/.env.local` and
      `worker/.env.local`. Note that `bun run db:env` blanks vendor keys, so
      re-running it undoes this.

---

## Phase 1 — Foundation (CL only — blocks everything else)

**Nothing in Phase 2 starts until CL-3 is ticked.**

- [x] **CL-1** `supabase/migrations/0082_image_generator.sql` written, applied
      locally, and smoke-tested. All six parts as one migration
      (plan → *Migration scope*):
      1. `generated_image` into `assets_kind_check` (drop-and-recreate, the way
         `0022` did for `poster`).
      2. `runs`: add `idempotency_key text`, `settled_at timestamptz`.
      3. Partial unique index on
         `(project_id, idempotency_key) where idempotency_key is not null`.
      4. Backfill `settled_at = created_at` on existing rows, so history is
         never swept as in-flight.
      5. `public.reserve_image_attempt(...)` — `security definer`,
         `set search_path = ''`, every object fully qualified.
      6. **`revoke execute ... from public, anon, authenticated;`** then
         **`grant execute ... to service_role;`** — not optional.
         `0007_grants.sql:26,45` grants execute on all public functions,
         *including future ones*, to `authenticated`. Skip this and any
         signed-in browser can spend money.

      **The three things most likely to go wrong here:** lock order — global
      `hashtext('image-generator:global-daily')` **then** owner, always that
      order, or two callers deadlock; owner derived from the **locked project
      row**, never a parameter; spend read via `public.user_spend_usd` and
      `public.spend_total_usd`, never by re-summing `runs` (since `0040` those
      union in `deleted_project_cost_history`, and re-summing under-counts
      anyone who deleted a project).

      **A fourth thing, not in the plan, found while writing it.** The spend
      reads must **not** use `p_now_ts` as their upper bound. `p_now_ts` is
      computed in TypeScript when the request starts — *before* the transaction
      blocks on the lock. Two requests racing for the last of a cap: A takes the
      lock, inserts with `created_at = now()`, commits; B then acquires the lock
      and reads with `to_ts = p_now_ts_B`, computed before any of that happened.
      A's row is newer than that bound, B never sees it, **both reserve.** The
      lock serializes them correctly and the timestamps throw it away.
      Implemented as `greatest(p_now_ts, clock_timestamp())`, evaluated after
      the lock is held, so it is always later than the commit of anything that
      queued ahead. **CL-7 must cover this**, and the concurrency test has to
      pass a deliberately stale `p_now_ts` or it will pass for the wrong reason.

      **Smoke-tested** (in a rolled-back transaction, so no data left behind):
      `reserved` / `duplicate` / `blocked` each returned exactly once;
      `blocked_by` correctly named `global_daily`, `weekly` and `daily`; a NULL
      cap raised instead of silently passing; `blocked` and `duplicate` wrote no
      row; and the boundary case — room for **exactly** one image — returned
      `reserved`, not `blocked`, which is the double-count bug reduced to one
      operator (`>` and not `>=`, with the reads before the insert).

- [x] **CL-2** Applied locally (`bun run db:push`) and types updated.

      ⚠️ **This task's original instruction was wrong and is corrected here.
      Do NOT run `supabase gen types` and commit the result.** `web/types/db.ts`
      is *not* purely generated — its own header says a regen "overwrites all of
      it". It carries a hand-maintained patch: the literal enum aliases
      (`AssetKind`, `ProjectStatus`, `ProfileRole`, …) that a CHECK constraint
      cannot convey to the generator, and `projects.render_settings` typed
      `unknown` rather than `Json`, deliberately — `Json`'s index signature
      forces a double cast that the file calls "a real type hole dressed up as a
      formality". A raw regen wiped all of it and produced a 1307-line diff for
      two columns. **Hand-edit `db.ts` instead**, and keep every alias in step
      with the CHECK constraint you changed, in the same commit.
      Done for 0082: `AssetKind` gained `generated_image`; `runs`
      Row/Insert/Update gained `idempotency_key` and `settled_at`; a
      `reserve_image_attempt` entry was added to `Functions` with `outcome` and
      `blocked_by` as literal unions rather than `string`.

- [x] **CL-2a** `web/lib/version.ts`: `EXPECTED_DB_VERSION` bumped `0081` →
      `0082`. Not optional and not discretionary — `version.test.ts` reads the
      migrations directory and fails CI the moment the constant and the repo
      disagree. **Any lane adding a migration owns this bump.**

- [x] **CL-3** 🚦 **GATE OPEN — the action signature is frozen.**
      `web/actions/image-generator.ts` is landed with the body stubbed (it
      throws; CL-6 fills it in). **CX may start.** This will not change.

```ts
export type GeneratedImage = {
  assetId: string;
  url: string; // signed, short-lived, preview only — mint a fresh one for download
  createdAt: string;
};

export type GenerateProjectImageResult =
  | { image: GeneratedImage; error?: undefined }
  | { error: string; image?: undefined };

// NOTE (corrected after CX flagged it): the duplicate messages are NOT
// exported. A "use server" file may only export async functions, so exporting
// a string from it is a build error that blocks the page from importing the
// action at all. They are module-private consts, the same shape as
// LOCKED_MESSAGE in actions/character.ts. Type exports are fine — they are
// erased at compile time. Nothing branches on the wording: render
// `result.error` as text.

export async function generateProjectImage(
  projectId: string, // bound via .bind(null, id) — NEVER a form field
  formData: FormData, // "prompt", "idempotencyKey"
): Promise<GenerateProjectImageResult>;
```

      Refusals come back as `{ error }`, never thrown — React redacts anything
      thrown from a Server Action in production to "Minified React error #441",
      so a thrown message is one the operator never reads. Render `result.error`
      as text; there is no separate "blocked" or "duplicate" discriminant to
      branch on, deliberately.

- [ ] **CL-3a** ⚠️ **Constraint CX must not break** (found while landing CL-3,
      recorded here because it decides how the page loads its data):
      `web/lib/guard-seam.test.ts` sweeps every page under
      `app/(app)/projects/[id]/` that guards with `requireProjectReadable` and
      **fails CI if that page `await`s an action guarded by the strict
      `requireProject`** — a readable door in front of a strict action
      `notFound()`s a non-owning admin out of a page they were just admitted to,
      mid-render. It reads the distinction off source text: `action.bind(null,
      id)` is treated as deferred-to-submit and allowed; `action(id)` is treated
      as awaited-during-render and checked.
      **So:** `generateProjectImage` may only ever be passed as
      `generateProjectImage.bind(null, id)`. The initial 20 history rows must
      come from a `lib/` query or an action guarded with
      `requireProjectReadable` — **never** from a strict-guarded action awaited
      in the page body.

---

## Phase 2 — CL and CX in parallel (after CL-3)

### CL — money and security

- [x] **CL-4** `web/lib/runs.ts`: `reserveImageAttempt`, `settleRunSuccess`,
      `releaseRun`, `holdRunBillingUnknown`, plus `attachKieTaskId`,
      `isRunInFlight` and `sweepStaleImageReservations`. `cost_usd = NULL`
      happens in `releaseRun` and nowhere else.
      Sweep expiry is `STALE_RESERVATION_MS = 5 min` — 3× the 100s poll ceiling,
      so it can never steal a live attempt, and erring long only means an honest
      estimate counts a little longer.
      `settleRunSuccess` may overwrite a held row (a real cost beats an
      estimate); `releaseRun` and `holdRunBillingUnknown` are restricted to
      `settled_at is null`, so a late failure can never free money already held
      conservatively.

- [ ] **CL-4a** ⚠️ **Plan-vs-repo conflict, decided in the plan's favour —
      someone should confirm the consequence.** The worker
      (`worker/internal/store/store.go:180`) documents `BillingUnknownPrefix`
      with a matching operational alert:
      `select ... from runs where error like 'billing-unknown:%' and cost_usd is null`.
      It keeps `cost_usd` **NULL** for a billing-unknown run. The plan's *States*
      table requires the opposite for this path: keep the **estimate** so the
      reservation stays counted ("Counts? **Yes**").
      Both cannot hold. I followed the plan, because dropping the estimate would
      free budget for a charge kie may well have made — the direction the plan
      exists to prevent. **The consequence: a held image attempt has the prefix
      AND a non-null cost, so the worker's existing alert query does not match
      it.** That query needs its `and cost_usd is null` clause widened, or
      billing-unknown image attempts go unnoticed by whatever watches it.
      Documented at `BILLING_UNKNOWN_PREFIX` in `lib/runs.ts`. **Not fixed here
      — it is the worker's query and outside this feature.**

- [ ] **CL-4b** Schema follow-on found while writing CL-4, already folded into
      `0082`: `settled_at` needed a **default of `now()`**. `recordRun` and the
      worker's three inserts (`store.go:491`, `:578`, `:1348`) never mention the
      column, so without a default every future run in **both services** would
      land as NULL — "in flight" by the column's own definition — and the sweep
      would eventually rewrite honest settled costs as billing-unknown. The
      default fixes both services with no Go change; `reserve_image_attempt` is
      the one writer that passes NULL explicitly. Column is added, backfilled to
      `created_at`, and only *then* given the default — attaching it at `add
      column` time would stamp every historical row with the migration's own
      run time. Verified locally: a reservation is in-flight, a `recordRun`-shaped
      insert is not.
- [x] **CL-5** `web/lib/spend.ts`: `resolveImageAttemptCeilings(userId, profile)`
      → `ImageAttemptCeilings`. Composes what already exists —
      `resolveAccountCaps`, `getEffectiveWeeklyCapUsd` (grants fold into the
      weekly ceiling only), `getUserDailyCapEnabled`, `GLOBAL_DAILY_CAP_USD`,
      and the Manila window helpers. `assertWithinSpendCaps` is not called.

      **One addition the plan does not mention, and the reasoning for it.**
      `assertWithinSpendCaps` folds `getInFlightSpend()` into all three of its
      checks — renders that are committed but have not written their `runs` row
      yet. The RPC reads `user_spend_usd` / `spend_total_usd`, which read `runs`
      plus the archive, and can see none of that. Ignoring it would let image
      spend past a ceiling every other paid path in the app enforces — **not a
      race, a standing hole.** Since ceilings are the only thing this function
      controls, in-flight is carried by **lowering the caps** rather than
      inflating a figure the RPC computes itself: same arithmetic, same answer,
      and the RPC stays the only place the comparison happens. Clamped at zero.
      Fail-soft on a read failure, logged, exactly as `assertWithinSpendCaps` is
      — throwing would refuse every image in the account on a transient error.
- [x] **CL-6** Fill in `web/actions/image-generator.ts`: `requireProject`
      (strict, owner-only) → kie funds check **outside** the transaction → lazy
      sweep of this project's stale reservations → RPC → `generateImage` with
      `onTaskCreated` → settle/release/hold → storage upload → `assets` insert.
      `projectId` bound via `.bind(null, id)`, never a form field. Delivered
      projects blocked.
      **Pick the sweep expiry window in code, with the reasoning in a comment** —
      it must exceed the observed 22s generation with margin (plan: *a few
      minutes is the obvious range*).

      ✅ **Done.** Order: `requireProject` → delivered check → prompt and key
      validation → kie funds (skipped in dev, as `assertWithinSpendCaps` skips
      it) → sweep (non-fatal) → `resolveImageAttemptCeilings` →
      `reserveImageAttempt` → `generateImage` with `onTaskCreated` →
      settle/release/hold → upload → `assets` insert → signed preview URL.

      **How release and hold are told apart — read this before changing it.**
      `lib/kie.ts` throws one `ImageGenerationError` for every failure and says
      outright that separating them by message is the fragile check the typed
      error exists to avoid. The reliable signal is whether kie ever returned a
      **task id**: before `createTask` there is no submission to bill; after it
      there is one that may have been. That is the same discriminator the Go
      side uses (`store.MarkFailed`, quoted in `lib/runs.ts`). So a failure with
      no task id **releases**, and a failure after one **holds** at the estimate.
      `MODE=development` returns before `createTask`, so a mocked failure
      releases — correctly, since nothing was submitted.

      **Settle happens BEFORE storage, deliberately.** The charge is real the
      moment kie returns an image, whether or not the file survives. Settling
      after a successful upload would lose the true cost every time storage
      failed. A storage failure therefore returns an honest message saying the
      image was charged and that generating again charges again — hiding that
      would hide a real cost from the person paying it. An `assets` insert
      failure cleans up the orphaned object and throws.

### CX — plumbing and UI

- [x] **CX-1** `web/lib/kie.ts`: add optional
      `onTaskCreated?: (taskId: string) => Promise<void>` to
      `GenerateImageArgs`, awaited immediately after `createTask` (`:257`) and
      **before** `pollForResult`. No existing caller changes. This exists so the
      task id reaches `runs` before a 100s poll window that a crash could
      otherwise strand.

      ✅ **Done by CX, verified by CL — 2026-09-06.** `lib/kie.ts:121` declares
      it; `:408-410` runs `createTask` → `await onTaskCreated` →
      `pollForResult`, in that order. Confirmed it is a real working-tree change
      (absent from `HEAD`), not something that predated this feature.

      **Do not reorder those three lines.** CL-6 decides release-vs-hold on
      whether the task id landed, so moving the callback after the poll would
      silently turn every unknown-billing outcome into a release — the one
      direction that gives budget back for a charge kie may have made.

      **Note for CL-7:** `MODE=development` returns *before* `createTask`, so
      `onTaskCreated` never fires under mock and task-id persistence is not
      exercised by a mocked run. Test it with a stubbed kie, not with dev mode.

      *(An earlier CX status note here said CX-1 was blocked by CL-3 and left
      unchecked. It was written before the gate opened and is superseded by the
      landed code above.)*

      **CX completion — 2026-09-06:** CL-3 is now checked and its frozen
      signature is present in `web/actions/image-generator.ts`; the earlier
      blocker is cleared. Added optional `onTaskCreated` to `GenerateImageArgs`
      and awaited it immediately after `createTask`, before `pollForResult`.
      Existing callers and the development mock are unchanged; callback
      rejection propagates without polling. Reviewed the source diff only;
      tests, lint, tsc and prettier were not run, per repository instructions.
      Still to do: CX-2 through CX-8; callback lifecycle coverage remains CL-7.
- [x] **CX-2** `web/lib/storage.ts`: expose `download` on `signedUrl` (`:556`)
      so Download sends `Content-Disposition: attachment`.

      **CX completion — 2026-09-06:** Codex added the optional fourth argument
      `download?: string | boolean`, passed through to Supabase. Download URLs
      and custom filenames have separate cache entries from preview URLs.
      Usage: `signedUrl(storageKey, undefined, undefined, true)` for an original
      file attachment. Existing callers keep their current behavior. Reviewed
      the source diff and installed SDK; no tests, lint, tsc or prettier run.
      Still to do: CX-3 through CX-8, including the Download UI and attachment
      coverage; browser verification remains ME-6.
- [x] **CX-3** `page.tsx` — `requireProjectReadable`. A non-owning admin sees the
      page with Generate disabled **and a reason shown**.

      **CX status — 2026-09-06:** Claimed by Codex. Reviewed the page guard,
      existing form controls and frozen action contract. **Blocked — handoff
      to CL:** `web/actions/image-generator.ts` has a top-level `"use server"`
      directive but exports the string constants `ALREADY_PROCESSING_MESSAGE`
      and `ALREADY_COMPLETED_MESSAGE`. Next.js permits only async function
      runtime exports from that module; importing it into the page would fail.
      Confirmed by reading the installed Next.js `action-validate.js` and
      TypeScript `server-boundary.js` rules; no checks were executed. CL owns
      that file and must resolve those runtime exports while preserving the
      action signature and result union. Its CL-6 body is also still stubbed.
      Still to do: CX-3 and its required CX-4 form together after the import
      blocker clears, then CX-5 through CX-8. No page/form code added and no
      tests, lint, tsc or prettier run.

      **CX completion — 2026-09-06:** The message constants are now private;
      the import blocker is cleared. Added the route with
      `requireProjectReadable`, bound the generation action via
      `generateProjectImage.bind(null, id)` without invoking it during render,
      and passed an explicit disabled reason for non-owning admins and
      delivered projects. The page states the 9:16 limitation and labels
      development placeholders. Implemented with its required CX-4 form.
      Source reviewed only; runtime access verification remains CX-7 / ME-6.
- [x] **CX-4** `image-generator-form.tsx` — prompt, estimated cost from
      `estimatedRefFrameCostUsd()` (**never hard-coded**), idempotency key
      generated client-side per press, Generate disabled while in flight.
      **Editors see credits; admins see credits + USD** via
      `formatAllowanceAmount("dual")`. State on the page that output is **9:16
      only**, a v1 limitation.

      **CX completion — 2026-09-06:** Added the prompt form and success preview.
      The page resolves `estimatedRefFrameCostUsd()` server-side; the form
      formats it with `formatAllowanceAmount` (editors: credits; admins: dual).
      `useAsyncAction` rejects overlapping submissions before minting a fresh
      client-side UUID for an accepted press; the payload contains only
      `prompt` and `idempotencyKey`. Generate and prompt editing are disabled
      in flight. Returned errors render as text; success previews the returned
      image and refreshes server data. No automatic retry. The form resets
      when the project changes. CL-6 is now checked and the action body exists;
      generation was not invoked. Reviewed source only; no tests, lint, tsc or
      prettier run. Still to do: CX-5 through CX-8 and ME browser verification.

      **CL handoff found while checking the callback integration:** in the
      current CL-6 action, `submitted = true` follows `await attachKieTaskId`.
      If that persistence write rejects after kie returned a task id, the catch
      still sees false and calls `releaseRun` for a potentially billed task.
      CL owns the action and its money tests; no money-path files changed here.
- [x] **CX-5** `image-generator-history.tsx` — newest first, 20 per page, Load
      More, thumbnail + `created_at` + download.
      **Cursor is `(created_at, id)`.** Ties are likely because `created_at`
      defaults to `now()`, and neither single-column comparison works: `<`
      **skips** rows on the boundary timestamp, `<=` **duplicates** them. Same
      tiebreaker `getInFlightSpend` and `projects/page.tsx` already use — copy
      it, don't invent one.

      **CX completion — 2026-09-06:** Added history and wired it into the page.
      The page's read-only Server Actions call `requireProjectReadable` first
      and query through the session client, restricted to this project and
      `kind = 'generated_image'`. Newest-first ordering uses both `created_at`
      and `id` descending; the validated cursor requests strictly older tuples.
      A 21st lookahead row controls Load More; only 20 images are signed and
      returned per page. Timestamp strings keep their database precision — no
      `Date.toISOString()` conversion at the pagination boundary.
      Thumbnails show Manila timestamps; Load More appends older pages, while
      a refreshed first page resets the loaded tail when its rows change.
      Download rechecks project access and asset membership on click, then
      requests `signedUrl(..., undefined, undefined, true)` for the original
      bytes as an attachment. No preview URL is reused for downloading.
      All changes are in the CX-owned page/component. Source reviewed only;
      tests, lint, tsc and prettier were not run. Still to do: CX-6 through
      CX-8, including pagination/attachment coverage, and ME browser verification.
- [x] **CX-6** Rail entry, always visible (`project-rail.ts` + `.tsx`).

      ⚠️ **Lane crossing, authorised:** completed by **CL**, not CX, at the
      user's explicit request after Codex hit its usage limit. Noted because the
      ownership table says this file is CX's — this is the exception, not a
      precedent.

      **What landed:** `RAIL_ENTRY_IMAGE_GENERATOR` plus a one-entry `images`
      group, `href` = `/projects/<id>/image-generator`, `status: "idle"`, no
      gate and no `lockedReason`. `project-rail.tsx` needed **no change** — it
      picks the active row by exact `href === pathname` match
      (`currentEntryId`), so the new route highlights itself.

      **Two design calls, in case they get revisited:**
      - **Not a fourth Setup row.** Setup's count answers "how much of this
        project's setup is filled in", and every row there derives `done` from a
        project column. The Image Generator has no such state, so a `done` for
        it would be either permanently false (Setup stuck at 3/4 forever) or
        permanently true (furniture). Either breaks that count.
      - **Placed last, after Cut**, because it is deliberately not part of the
        setup → scenes → cut pipeline. Nothing generated here feeds a render, so
        sitting it mid-pipeline would imply a flow that does not exist.

      A non-owner still sees the row: the page admits them read-only with
      Generate disabled and a reason, which beats a row that vanishes silently.
      Existing rail tests all select groups with `.find(g => g.id === …)` and
      none assert group count or order, so the fourth group breaks none of them.

- [x] **CX-6a** App sidebar entry — **added on the user's request, beyond the
      plan.** Decision C only called for the rail; the user asked for the main
      sidebar too.

      **Why it needed a new route rather than one line in `nav-links.tsx`.**
      That file already documents this exact decision for the other
      project-scoped surface: *"No /ugc entry: that route needs a project id,
      and a sidebar link has no id to carry."* Generating an image needs a
      project — cost is attributed `runs → projects → owner`, and a
      null-`project_id` run is invisible to every per-user cap
      (`lib/db-aggregates.ts`). So a bare sidebar link to a project-scoped route
      is not possible.
      **Resolved by giving the sidebar an id to carry:** a new app-level
      `web/app/(app)/image-generator/page.tsx` asks which project pays, then
      hands off to `/projects/<id>/image-generator`. The precedent's stated rule
      is "a sidebar link has no id to carry" — this link does not need one.

      Deliberately a plain list of links, **not** a second `/projects`: no
      filters, sort, pagination or spend column. Whoever lands here has already
      decided to make an image and only needs to name the payer. Uses the
      SESSION client so RLS does the filtering (editor sees their own, admin
      sees all) rather than a second ownership check. Capped at 50, newest-
      touched first; anyone with more should use `/projects` and the rail.

      Sidebar tests iterate expected link names and assert presence — none pin
      an exact set — so the extra link breaks none of them.

---

## Phase 3 — Tests

CL takes the concurrency and money tests because those are the ones that fail
silently and cost real money when wrong. CX takes the tests fully enumerated in
the plan's *Tests* section.

- [ ] **CL-7** `web/lib/attempt-lifecycle.test.ts` plus the money half of
      `web/actions/image-generator.test.ts`:
      - RPC returns exactly one of `reserved` / `duplicate` / `blocked`.
      - **The estimate is counted once, not twice** — an account with room for
        exactly one image gets `reserved`, not `blocked`.
      - Two concurrent RPCs with room for one → one `reserved`, one `blocked`.
      - **Two different users** racing for the last of the *global* daily cap →
        one `reserved`, one `blocked`. This is the case an owner-only lock
        misses, and the reason the global lock exists.
      - **Archived spend counts** — an owner with rows in
        `deleted_project_cost_history` blocks at the right point.
      - **An `authenticated` browser client cannot execute the function**; only
        service-role succeeds.
      - A caller cannot reserve against another project's owner.
      - `blocked` and `duplicate` write no `runs` row, and both call
        `generateImage` zero times.
      - `assertWithinSpendCaps` is **not** invoked on this path.
      - Lifecycle: success settles to kie's actual cost; known-unbilled failure
        releases; unknown outcome holds with the `billing-unknown: ` prefix; a
        settlement failure leaves the row **counting, never released**; the sweep
        settles stale rows and never releases them; backfilled historical rows
        are not swept.
      - `onTaskCreated` fires before polling; `kie_task_id` is on the row even
        when the poll then fails or times out.
- [ ] **CX-7** UI and authz tests — `image-generator-form.test.tsx` and the
      UI-facing half of `image-generator.test.ts`: owner can generate; non-owner
      cannot; non-owning admin cannot spend; delivered project blocked; a forged
      `projectId` field is ignored; empty and over-long prompts rejected before
      any reservation; the model recorded is `google/nano-banana`; the estimate
      is not hard-coded; admins see credits + USD and editors credits; history
      caps at 20; Load More has no repeats; **tied `created_at` values are
      neither skipped nor duplicated**; download uses attachment.
- [ ] **CX-8** Regression: `/ugc` unchanged, video upload unchanged, existing
      `runs` writers still work with the new nullable columns, other paid paths
      still use `assertWithinSpendCaps`, no `elements` row is written, and
      `loadConditioningRefs` never reads `generated_image` (`frames.ts:100-115`
      reads `character_ref` — reusing that kind would silently change what the
      wizard conditions on).

---

## Phase 4 — Verification and merge (ME)

- [ ] **ME-5** `make check` clean locally (the agents don't run it; CI and you
      do).
- [ ] **ME-6** Browser pass on `localhost:9000` under `MODE=development`:
      generate → preview → download → refresh → history persists. Confirm the
      cost shows *before* generating, and that you see **credits + USD** as an
      admin.
- [ ] **ME-7** In Studio (`127.0.0.1:54323`), confirm one `runs` row per
      generation with a settled `cost_usd`, and one `generated_image` asset.
      Then press Generate twice quickly and confirm **one** charge.
- [ ] **ME-8** Confirm a signed-in non-service-role client **cannot** call
      `reserve_image_attempt`. This is the security claim the whole design rests
      on — verify it yourself rather than trusting the test.
- [ ] **ME-9** *(only if ME-3 = real kie)* One real generation. Confirm the
      settled `cost_usd` is **kie's reported charge**, not the estimate.
- [ ] **ME-10** Re-confirm `0082` is still free against `main`, then review and
      merge.

---

## Restructure — image projects are their own kind (0083)

**Decided by the user on 2026-09-06, after seeing the sidebar picker list video
projects as image targets.** This supersedes the plan's `/projects/[id]/image-generator`
placement. The plan is not wrong about anything else; it simply never asked
*which* projects the generator attaches to.

**The argument.** The plan insists the generator is standalone — "the only link
is a human downloading a file and uploading it later" — yet placed it inside a
project whose whole shape is script → scenes → cut. Asking someone to pick a
video project to hold a standalone image is a question that should not exist.
`/ugc` hit this exact problem and answered it with `projects.kind = 'clip'` plus
its own route tree; images are the third console and take the same shape.

**Why a route tree and not just a kind.** Everything under
`app/(app)/projects/[id]/` inherits that segment's layout and its
Setup → Scenes → Cut rail. An image project has no script and no scenes, so it
would render locked "Compile the script" placeholders it can never satisfy — a
rail that reads as broken. `/ugc` lives outside that tree for the same reason.

- [x] **CL-8** `supabase/migrations/0083_image_project_kind.sql` — widens
      `projects_kind_check` to `('scripted','clip','image')`. Widening only; no
      existing row changes and `'scripted'` stays the default. Applied locally.
      `EXPECTED_DB_VERSION` → `0083`.
- [x] **CL-9** `ProjectKind` gains `"image"` (hand-patched in `db.ts`, per CL-2).
- [x] **CL-10** Page moved `projects/[id]/image-generator/page.tsx` →
      `images/[id]/page.tsx`. Codex's page needed no edits — it already took
      `params: Promise<{ id: string }>` and guarded with `requireProjectReadable`,
      both of which work unchanged in the new tree.
- [x] **CL-11** `createImageProject()` in `actions/image-generator.ts` —
      inserts `kind: "image"` and redirects to `/images/<id>`. `kind` is
      load-bearing: omitting it defaults to `'scripted'` and every project the
      button makes would open the six-step wizard, the exact trap
      `createClipProject` documents.
- [x] **CL-12** `projects-table.tsx` — the title link now goes through an
      exhaustive `switch` on `ProjectKind` instead of a `clip ? : ` ternary, so
      the next kind added is a type error rather than a row that opens the wrong
      screen.
- [x] **CL-13** `NewImageProjectButton`, on `/projects` beside the video button
      and on the `/image-generator` picker. The existing button's label changed
      `"New project"` → `"New video project"`: its comment justified the bare
      noun by being *the only* project button on that page, which stopped being
      true. No test pins that label (the "New project" hits in tests are project
      *titles*, and `NEW_CLIP_PROJECT_TITLE` is untouched).
- [x] **CL-14** Sidebar picker `/image-generator` now lists **only**
      `kind = 'image'` projects and offers the create button. Listing video
      projects was the defect that prompted this whole restructure.
- [x] **CL-15** Rail entry from CX-6 **removed** from `project-rail.ts`. It
      pointed into a route that no longer exists, and an images row has no
      business in a video project's rail now that images have their own.
- [x] **CL-16** `guard-seam.test.ts` sweep extended to `app/(app)/images/[id]`.
      The page uses the readable door with a strict-guarded action behind it —
      precisely the shape that file polices — and is safe only because it hands
      the action over as `.bind(null, id)`. The sweep keeps that true.

**Unchanged by all of this:** the money path. `runs → projects → owner`
attribution, the RPC, the ceilings and the lifecycle are identical — an image
project is still a project with an owner. 0082 needed no edits.

---

## Referencing and tagging (added on request — the plan excluded it)

The plan lists Elements, `registerElement` and `@element` tags under *Out, and
unchanged*. The user asked for them, then correctly pointed out that tagging is
useless without a way to create the reference — so this landed as the full /ugc
flow, reused rather than rebuilt.

- [x] **CL-17** `resolvePromptReferences` in `actions/image-generator.ts`. One
      `@tag`, two effects: the element's description is substituted into the
      prompt (`substituteElementTags`) **and** its picture is attached as a
      conditioning reference. Either alone is worse — description without the
      picture loses the likeness, picture without the description loses
      everything the operator wrote.
      **Authorization:** elements are read `where user_id = <caller>` and
      nowhere else. Names are not unique across accounts, so resolving globally
      would let anyone reference a stranger's saved photo by guessing its name —
      invisibly, since the only evidence is a better image than they should have
      got.
      Capped at **3** references, for time not money. Picture-vs-sound is read
      off `assets.kind`, never the element's category label: a reference saved
      before `0081` is filed as "character" and is still a picture.
      Fail-soft on lookup failure, matching `resolveElementTags` in
      `actions/ugc.ts` — an unsubstituted tag is a worse image, not a lost one.
- [x] **CL-18** Model selection now flows from the refs. `modelForImageArgs` is
      called with `{ prompt, refImageUrls }`, so a tagged prompt goes to
      `google/nano-banana-edit` and `runs.model` records it — including on the
      failure path, where `generateImage` throws before returning anything.
      **The base model silently DROPS `image_urls`**, so a literal here would
      lose every reference without erroring.
- [x] **CL-19** `lib/element-library.ts` — `loadElementTags(supabase, ownerId)`,
      lifted from `ugc/[id]/page.tsx` so both consoles resolve the same library
      the same way. Scoped to the **project owner**, not the viewer: a prompt is
      written in its author's tags, and scoping to the viewer would make every
      tag in an admin's read-only view render as a typo.
      `ugc/[id]/page.tsx` still has its own inline copy — identical, left alone
      rather than refactored mid-feature.
- [x] **CL-20** The form now uses **`UgcPromptEditor`** (the same `@`
      autocomplete and undo/redo /ugc has) instead of a plain `Textarea`, plus
      **`UgcReferencePicker`** — which is the answer to "how do I tag a
      reference if I can't upload one?". The picker registers an upload as an
      element immediately, so a reference created there is taggable in the box
      above it without leaving the page.
      Picking **inserts the `@tag`** rather than holding a separate selection:
      the server resolves references from tags in the prompt, so a reference
      chosen in the dialog and not named in the text would be silently dropped
      at generate time. One mechanism, visible in words the operator can edit.

- [x] **CL-22** Pictures only — no MP3s anywhere in the image path.
      `UgcReferencePicker` gains `imagesOnly` (**default false**, so /ugc, which
      really does send both, is untouched). It narrows the file input's
      `accept`, drops audio from the drag-and-drop filter, hides the Audio
      category tab, and swaps the copy that would otherwise name upload rules
      for a file type the input will not even open.
      The images page also filters audio out of the element list **before** it
      reaches the form, so the `@` MENU cannot offer one either: a voice clip
      that autocompletes in the prompt and is then dropped server-side is worse
      than one never offered — it looks like it worked.
      Filtering is on `assets.kind`, not the category label: a reference saved
      before `0081` is filed as "character" and is still a picture.
      The server-side drop (`resolvePromptReferences`) stays regardless — it is
      the actual guarantee; the UI changes are what stop the operator being
      invited to try. The existing picker test asserting the both-kinds drop
      message still passes: that path's string is byte-identical.

- [x] **CL-23 — BUG, found by the user: uploading a reference generated an
      image.** A real charge from a click that said "Upload".

      **Cause.** `UgcReferencePicker` was rendered INSIDE the generate `<form>`.
      Its dialog is portalled to `document.body`, so its own `<ActionForm>` was
      never a DOM descendant and devtools showed no nested `<form>` — but React
      propagates events through the **React tree, not the DOM tree**, so the
      upload form's submit bubbled out of the portal into the generate form's
      `onSubmit`.

      **Not** the usual `type="button"` story: the dialog trigger already has
      it, and the submit came from *inside* the dialog, not from the button that
      opens it. `stopPropagation` on the trigger would not have helped either.

      **Fix:** the picker now sits outside the `<form>`, above it. It only
      appends an `@tag` to React state, so it needs no form participation at
      all — nothing to gain by nesting it, and a live vendor charge to lose.

      **Worth testing for.** This is the kind of defect that costs money on the
      first click and looks like a UI nit in review. CX-7 should assert that
      opening the picker and uploading fires the generate action **zero** times.

**Cost is unchanged and that is measured, not assumed.** `lib/kie.ts`'s header
records both models at 4 credits = $0.02, each verified with a real paid call.
They differ in TIME, not price.

⚠️ **CL-21 — the consequence to watch.** The edit model was measured at **70s**
against a **100s** poll budget, and `kie.ts` notes platform proxies cut blocked
requests somewhere in the **30–100s** range. Reference-conditioned generation is
therefore materially more likely to time out than plain text-to-image — and a
timeout after `createTask` is held as `billing-unknown`: **charged, no image.**
Not a defect, and the conservative direction by design, but tagging turns that
path from rare into ordinary. If it bites in practice the fix is the background/
webhook path the worker's video renders already use, not a longer budget — the
budget is already racing the proxy.

---

## Sequences — images as scene iterations (added on request)

**The use case, in the user's words: "pictures count as iteration of scenes."**
Not a batch of tries at one shot, and not unrelated images — a storyboard where
each picture continues the last. Both modes exist because independent one-offs
are still wanted sometimes; continuity is the common case.

- [x] **CL-24** `compileImageSequence` (`lib/claude.ts`) turns a free-text
      request into ordered beats, capped at `MAX_SEQUENCE_BEATS = 6` — a
      ceiling, not a target, since every beat is a separate paid image AND a
      separate ~70s call.
      **Why not a regex.** A pattern gets the count and then sends the same
      prompt N times, which returns N variations of ONE shot. The beats are the
      point; the count falls out of them.
      Two things the system prompt is emphatic about: every beat must **stand
      alone** (the model drawing beat 3 has never seen beat 1, so "the same man"
      or "as before" breaks it), and `@tags` must be **carried through
      verbatim** — a tag rewritten to "@the man" resolves to nothing and
      silently drops the reference it stood for.
- [x] **CL-25** `compileProjectImageSequence` — charges the **compiler** model
      via `assertWithinSpendCaps`, records it in `runs`, and draws nothing. This
      is the one call in the file that uses `assertWithinSpendCaps`, and it is
      not a contradiction: a compile reserves no image, so there is no
      reservation to double-count. Putting it through the RPC would file a
      Claude charge in a table of image attempts and leave the sweep unable to
      say what it was looking at.
- [x] **CL-26** Chaining. `generateProjectImage` accepts `chainFromAssetId`; the
      previous beat's image is signed and sent **first** in `refImageUrls` — the
      dominant conditioning — with tagged references after it, and the whole
      list capped at `MAX_REFERENCE_IMAGES`.
      **The id is filtered to this project and to `kind = 'generated_image'`,
      and that is the security check, not tidiness:** it arrives from the
      browser, and this uses the admin client, so RLS is not the backstop. A
      missing id is non-fatal — that beat generates without continuity rather
      than killing a sequence over a reference that is merely absent.
- [x] **CL-27** **The browser drives the chain**, and that is the reason
      sequences are possible without a worker. Each beat is ~70s
      reference-conditioned; three on the server is ~210s, well past the 30-100s
      window a platform proxy allows one blocked request (`lib/kie.ts`). Looping
      client-side makes each beat its own request, inside its own budget.
      **Stops on the first failure** — a sequence whose beat 2 failed has lost
      its continuity, and pressing on would spend money conditioning against a
      picture that does not exist. Everything generated before the failure is
      kept, stored and charged for.
      **Accepted limit:** closing the tab ends the run. Each beat settles
      independently, so an abandoned sequence leaves finished images and no
      half-charged one. The worker path only becomes worth building if someone
      wants to close the tab and come back.
- [x] **CL-28** Beats are **editable before generating**. The compile is a
      proposal, not a decision — a beat you cannot fix is one you pay for and
      then regenerate. One idempotency key per beat, so a retry resolves to that
      beat's attempt and never its neighbour's.

---

- [x] **CL-29** The beat count follows the **request**, not a default.
      Two things were wrong and one of them was only visible in dev:
      - `MAX_SEQUENCE_BEATS` was **6**, which silently truncated "8 images" to
        six — answering a different question than the one typed. Now **24**, and
        reframed in its own doc comment as a guard against a typo ("100 images")
        rather than a cap on intent. Nothing between 1 and 24 is second-guessed,
        and the total is priced on screen before any image draws.
      - **The dev mock returned three beats flat, whatever was typed** — so
        anyone testing "make me 5 images" under `MODE=development` saw three and
        would reasonably conclude the count was ignored. It now reads the number
        out of the request. A crude digit match is right for a fixture; the real
        compile reads "a four-part sequence" too, and the mock only has to stop
        contradicting it on the plain case.
      The system prompt now says THE REQUEST DECIDES: honour a named number
      exactly, not one more or fewer, even where the model thinks the moment
      would be told better differently — the operator is paying per beat and has
      already been quoted for the number they asked for. It only chooses when no
      number is named.
- [x] **CL-30** The preview shows the **whole sequence**, not the latest image.
      Showing one would throw away what was just paid for: a sequence is the
      images together, in order, and beat 3 alone says nothing about whether the
      continuity held. Rendered from each beat's own state, two columns (at 9:16
      a row of four is four slivers, and comparing whether the man is the same
      man is the entire reason to look), with a per-beat placeholder so the grid
      keeps its shape while it fills in. Empty frames appear only once
      generation starts — a freshly compiled plan is a list of prompts, and four
      empty frames would promise pictures nobody has paid for yet.

- [x] **CL-31** Re-prompt and re-render one beat. Each generated (or failed)
      beat gets its own **Regenerate**, and its prompt was already editable, so
      fixing one picture no longer means re-running the sequence.
      **Still chained:** it conditions on the beat BEFORE it, exactly as the
      original run did, so a re-prompted beat continues from the same place
      rather than starting a new sequence in the middle of an old one.
      **A new idempotency key**, deliberately: this is a new attempt and a new
      charge, and reusing the beat's original key would resolve to the existing
      run and hand back "already completed" instead of a picture.
      **Beats after it are marked "no longer follows"** — in the list and on the
      preview tile. Those images were conditioned on the picture just replaced,
      so they genuinely do not continue from it any more. They are NOT
      regenerated automatically (that spends money on beats nobody asked to
      redo) and NOT left looking fine (that hides a broken sequence behind a
      finished-looking grid). The operator sees it and decides.
      Only beats that already have an image can go stale; an ungenerated one
      downstream is simply still waiting.

## Model selection (added on request — the plan said "No model selector")

- [x] **CL-32** `scripts/measure-image-model.ts` — probes a kie model id and
      prints the **receipt**: accepted or rejected, elapsed time, and kie's own
      `creditsConsumed`. AGENTS.md requires a measured price before a model is
      offerable, and a wrong id costs nothing (kie answers `code=422` at
      `createTask`, before work is queued), so it doubles as a cheap way to
      discover ids.
      Talks to kie's HTTP API directly rather than through `lib/kie.ts`: that
      module picks its own model and takes no override, and teaching production
      code a test-only parameter to satisfy a script is the wrong trade.

      **Measured 2026-09-06** (total spend $0.13):

      | Model | kie id | Credits | Cost | Time |
      |---|---|---|---|---|
      | Nano Banana | `google/nano-banana` | 4 | $0.02 | 22s |
      | Nano Banana 2 | `nano-banana-2` | 8 | $0.04 | 23.4s |
      | Nano Banana Pro | `nano-banana-pro` | 18 | $0.09 | **162.9s** |

      **The ids have no vendor prefix.** Every `google/`-prefixed spelling was
      rejected; the bare ids were accepted. kie's naming is inconsistent with
      the existing `google/nano-banana`, which only surfaced by trying it.
- [x] **CL-33** `IMAGE_MODELS` registry in `lib/models.ts`, `model?` override on
      `GenerateImageArgs`, per-model pricing through the action. The estimate
      the UI quotes and the estimate the reservation holds are the same field on
      the same descriptor.
- [x] **CL-34** **Nano Banana 2 has no edit variant** — `nano-banana-2-edit` is
      rejected by kie. Base endpoints SILENTLY IGNORE `image_urls`, so it cannot
      carry an `@tag` or a chained beat.
      Handled by **refusing**, not downgrading: `kieIdForImageModel` returns
      null and the action returns a clear message. Silently swapping to another
      model would be its own surprise, on the bill; sending it anyway would
      charge for a picture that used none of the references and say nothing.
      The form warns **before** planning, since a sequence is references by
      construction and would otherwise fail on beat 2 with beat 1 already paid.
- [ ] **CL-35** ⚠ **Nano Banana Pro is deliberately NOT offered.** It works and
      is measured, but 162.9s against `lib/kie.ts`'s **100s** poll budget — and
      that budget is chosen to beat the platform proxy, which cuts a blocked
      request at 30-100s, so raising it does not help. Offered today it would
      time out every time, hold as `billing-unknown`, and charge **$0.09 for no
      image**: a control that looks like a feature and silently bills.
      Offerable once generation moves to the background/webhook path
      `lib/kie.ts` already names as the real fix. The reasoning is written at
      `IMAGE_MODELS` so it is read before anyone adds it back.
- [x] **CL-36** Compiler model switched to `claude-sonnet-5` (`CLAUDE_MODEL` in
      `web/.env.local`). Verified against the real API: richer framing, and no
      back-reference warnings, where Haiku produced "continuing" in two of three
      runs. Costs more per compile ($0.12 flat ceiling vs Haiku's) — worth it
      for the one call that decides how many images get bought.

---

- [x] **CL-37** Rename an image project, from its own page. Reused
      `UgcTitle` — despite the name it is a generic project-title editor
      (`projectId`, `title`, `readOnly`) calling `saveTitle`, which goes through
      `updateProject` and is not /ugc-specific. Renaming the component would
      touch the clip console for a cosmetic gain, so the odd name stays with a
      comment at the call site saying why.
      `readOnly={!isOwner}` mirrors the server: `saveTitle` guards with the
      strict `requireProject` and refuses a non-owning admin regardless, so this
      only stops the page offering a control that could only fail.
      No guard-seam concern: the action is imported by the component and fired
      on submit, never awaited in the page body.

## Known gaps in v1 — accepted, not oversights

State these plainly in the PR so nobody reads them as bugs later.

- **The global cap is atomic between image generations only.** No advisory lock
  exists anywhere in this repo today, so no video or other paid path takes this
  lock. A simultaneous video render still races the company daily cap exactly as
  it does now. Making that genuinely atomic means every paid path taking the
  lock — outside this feature.
- **`/spend` over-reports for ~22s per generation**, because in-flight
  reservations count. Over-reporting for seconds beats under-reporting real
  money.
- **A duplicate never links to the specific image.** There is no durable
  `runs`↔`assets` link (`runs` has no `asset_id`, `assets` has no `run_id`), so
  the settled response says "refresh the image history" rather than pointing at
  one image. Adding the link is a v2 option.
- **Held `billing-unknown` rows are not reconciled against kie.** The task id is
  persisted so it becomes possible; until then those charges stay counted, which
  is the conservative direction.
