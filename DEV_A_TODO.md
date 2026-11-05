
# Dev A TODO

Dev A owns the Go worker, render infrastructure, fal.ai integration, worker-side
cost accounting, concurrency, reconciliation, and operational alerts.

**Baseline: `fix/go-review-wave2` @ `44c9ca0`, 2026-08-30** (`main` is
`c89fb7e`). That one commit closes C4, X2, X3 and X5, fixes the cost-accounting
row in `AGENTS.md`, and lands migration `0058` unapplied. Pushed; the PR is not
open yet (`gh` is not installed on this machine — the body is ready to paste).
Previous baseline was `fix/c1-persist-fal-request-ids` @ `29c52a8`, 2026-08-24.

IDs match the 2026-08-22 Go review (`C*` = money and state path, `X*` = fal,
media, config path), so the two documents refer to the same findings.

## Closed since the 2026-08-22 baseline

- **C1 — fal request IDs are now persisted per render attempt.** Landed as
  `29c52a8`. Migration `0050_runs_fal_request_id.sql` adds nullable,
  indexed `fal_request_id` columns to `runs` and
  `deleted_project_cost_history`, and preserves the value through both archive
  triggers. The worker carries the accepted request ID through successful video
  ingest, webhook/reconcile failures, lost-local-ID recovery, and Whisper runs;
  pre-submission and billing-unknown failures correctly leave it null. Store-seam
  and DB-backed tests assert the ID reaching `MarkDone`, `MarkFailed`, and
  `InsertRun`. The affected Go packages pass locally. **Rollout is still open:**
  apply `0050` to the live project and read a representative row back before
  calling the production proof complete.
- **C3 — compensating writes no longer run on the context that just died.**
  `recoveryCtx` (`dispatch.go:53`) is `context.WithTimeout(context.WithoutCancel(parent), 5s)`,
  and both sites use it: the lost-request-id branch (`dispatch.go:264`) and
  `failScene` (`dispatch.go:410`). Two tests hold it —
  `TestRecoveryCtxSurvivesCancelledParent` pins the context decision,
  `TestDispatchScene_LostFalRequestID_RecordsBilledRun` pins what actually
  reaches `MarkFailed`: a run row carrying the billed cost, not a $0 failure.
  Landed as PR #6 (`ddf0502`) plus `ec09f68`.
- **C11 — `.gitattributes` exists** with `* text=auto eol=lf` and explicit
  `binary` for `.ttf/.png/.ico/.mp4`, which is the stricter version of what this
  file asked for: it covers the whole repo, not just `*.go`, and it exempts the
  fixtures a newline rewrite would have corrupted (Anton's font, `clip.mp4`).
  `gofmt -l ./internal/...` is clean on a Windows checkout.
- **C4, X2, X3 and X5 — closed 2026-08-30 in `44c9ca0`.** The render ceiling is
  enforced inside the claim's own statement (`CountRendering` deleted, from
  `store.go` and from the `loop.Store` interface), ffmpeg and ffprobe have
  deadlines, integer config rejects zero and negative values, and the Whisper
  prompt cap slices runes. Each item below carries its own proof line. The one
  structural note worth carrying forward: `loop.Store` is 14 methods now, not
  15.
- **`AGENTS.md`'s cost-accounting invariant is no longer backwards** (same
  commit), and `docs/architecture.md`'s dispatch sketch was corrected with it.
  Both had drifted in the same direction — describing a `runs`/claim shape the
  code stopped having — so anything either file says about money or the queue is
  worth checking against `store.go` before trusting it again.

### Landed by Dev B, but it changes how Dev A works

- **`loop.Store` is now an interface** (`deps.go:20`, 14 methods since C4 removed
  `CountRendering`, with
  `var _ Store = (*store.Store)(nil)` pinning it). `fake_store_test.go` gives the
  package a fake that records what it was asked to write. **This is the biggest
  change to the proof burden below:** items that used to need `TEST_DATABASE_URL`
  and a live Postgres to observe anything can now be proven with a table test.
  Where an item's *Proof* line says "assert what MarkFailed/InsertRun received",
  that is why.
- **`BalanceGate`** (`balance_gate.go`, wired in `main.go` as a process-wide
  pointer) stops a drained fal account from converting 1,200 scenes an hour into
  `failed`. It sits **ahead of** `ClaimQueuedScenes` (`dispatch.go:67`), which
  is where C4 left it — but anyone touching the claim must keep it there, and
  `dispatch_balance_test.go` asserts exactly that ordering, by panic, on a
  `fakeStore` that deliberately answers nothing.
  Its doc comment also settles a question this file used to carry implicitly:
  **the worker cannot read the fal balance at all** — that endpoint needs admin
  scope, `FAL_KEY` is API scope and gets a 403. The worker learns it is broke by
  being told no.
- **Caption colour is per-project** (migration `0049`, `captions/color.go`,
  `store.CaptionStyleForProject`). ASS's reversed `&HAABBGGRR&` byte order lives
  in exactly one place now; get the swap wrong and a perfectly valid video
  renders in the wrong colour with nothing to fail on. Worker code, so it is ours
  to maintain.
- **`/spend` → "Reconcile against fal"** (`web/lib/fal-usage.ts`,
  `web/lib/ledger-reconcile.ts`, `web/actions/reconcile.ts`) reads
  `GET /v1/models/usage` with `FAL_ADMIN_KEY` and compares fal's own `unit_price`
  and `cost_total` against `runs` for a window. See the "Needs an answer" table —
  this changes how the pricing question gets settled, and puts a hard ceiling on
  what reconciliation can ever prove.
- **`docs/spend-model.md`** is the money walkthrough, with diagrams. Read it
  before answering anything containing the word "credit".

Still true from the previous baseline: `0045_scene_render_settings_override.sql`
lets a retry re-render one scene on a different model, and `store.go` merges
`p.render_settings || coalesce(s.render_settings_override, '{}')` in
`ClaimQueuedScenes`, `SceneByFalRequestID`, and `StaleRendering`. Anything that
prices a run must price the scene's *effective* settings, not the project's.

**Migrations through `0061` are applied.** Re-read 2026-09-02 via
`applied_schema_version()` against the hosted project: it reports `0061`, not the
`0055` this line carried since 2026-08-28. `scene_versions` (`0058`) and
`final_versions` (`0060`) both read back, so there is no gap in `0056`-`0061`.
C1's remaining proof is unchanged and still open: read a representative `runs`
row back and confirm `fal_request_id` is populated.

**Unapplied, as of 2026-09-02:** only `0062` (peer approval, `docs/credit-plan`).
`0056`-`0057` shipped with the rest.

**C5/C6's migration is not in this tree.** `0058` here is `0058_scene_versions.sql`;
the `0058_one_clip_one_final.sql` this file describes exists only on
`fix/go-review-wave2`. It needs renumbering past `0062` before anyone applies it —
check the directory, never this file, for the next free number.

## P0 — the ledger cannot be reconciled to fal's invoice

`runs` holds one row per attempt — `MarkFailed` inserts one inside the same
`WHERE status = 'rendering'` transaction that takes the scene out of flight, so
a failure is billed exactly once. C1 now gives each trustworthy fal attempt its
own request identity. Costs are still our own arithmetic rather than observed
per-request charges because fal's usage line items expose no request ID.

- [x] **C1 · Persist `fal_request_id` per attempt.** Landed as `29c52a8` with
      migration `0050`. `store.Run.FalRequestID` is written at every trustworthy
      paid-attempt site and archived with deleted cost history. It stays null for
      pre-submission and billing-unknown outcomes, where inventing an ID would be
      false accounting. fal's usage line items still carry **no request id**, so
      this makes our ledger self-sufficient for investigation rather than creating
      an automatic invoice join.
      *Code proof:* Store-seam and DB-backed assertions cover `MarkDone`,
      `MarkFailed`, and `InsertRun`; the affected Go packages pass locally.
      *Rollout proof still due:* apply `0050`, run one mock render, then verify
      `select fal_request_id, cost_usd from runs order by created_at desc limit 1`
      returns the attempt ID and cost.
- [x] **Apply and verify migration `0050` in the live project.** Trust
      `supabase migration list`, not the migration header or expected-version
      constant, then read back one `runs.fal_request_id` as above.
- [~] **C5 · Two `clip` assets can exist for one scene.** Migration written,
      not applied. `0058_one_clip_one_final.sql` adds
      `create unique index assets_one_clip_per_scene on assets (scene_id) where kind = 'clip'`
      — reapplied from the stash's `0045_one_clip_one_final.sql`, renumbered
      after checking the directory (0051-0057 were taken). Re-verified against
      the tree before landing: the only unique index on `assets` is still
      `assets_product_ref_position_key` (`0023:123`), `unfreezeScene`
      (`web/actions/brief.ts:409`) still sets `frame_ready` before deleting,
      and `MarkDone` (`store.go:377`) still INSERTs the clip and UPDATEs the
      scene in one transaction with no `ON CONFLICT` — so a 23505 rolls the
      claim back and leaves the scene `rendering` for reconcile, which is the
      intended loud failure.
      *Rollout proof still due:* run the two duplicate-hunting queries in the
      migration header (both must return zero rows — a row is one of these
      bugs having already happened in production and needs a keep-which
      decision first), then apply and read the index back.

- [~] **C6 · Two `final` assets can exist for one project.** Same migration,
      `0058`: `create unique index assets_one_final_per_project on assets (project_id) where kind = 'final'`.
      `ProjectsReadyToAssemble` (`store.go:563`) and `InsertFinalAsset`
      (`store.go:733`) are unchanged and still a read-then-write, so this stays
      latent at one instance and constrained at any number. Same rollout proof
      as C5 — one migration covers both.

- [x] **C4 · The global render ceiling is now enforced in one statement.**
      `CountRendering` is deleted — from `store.go`, from the `loop.Store`
      interface (now 14 methods), and it was never on `fakeStore`.
      `ClaimQueuedScenes`' parameter is now `ceiling`, not `limit`, and the
      candidates CTE ends
      `LIMIT greatest(0, $1 - (SELECT count(*) FROM scenes WHERE status = 'rendering'))`,
      so the count and the candidate set share one statement's snapshot.
      `Dispatch` hands it `deps.Config.RenderConcurrency` and does no
      arithmetic. Net negative diff, as predicted.
      *Sequencing held:* `BalanceGate` is still the first thing `Dispatch`
      does; `dispatch_balance_test.go` passes unchanged in behaviour (its two
      tests still assert by *panic* on an unoverridden `fakeStore`, which is
      why the new claim recorder is a separate type in
      `dispatch_ceiling_test.go` and not an override on the shared fake —
      teaching `fakeStore` to answer `ClaimQueuedScenes` would silently defeat
      both).
      *Proof:* `TestDispatchPassesTheCeilingNotTheSlots` (fake, runs
      everywhere) pins that the number reaching the claim is
      `RenderConcurrency` and not a pre-subtracted slot count — verified to
      fail when Dispatch subtracts. `TestClaimStopsAtTheRenderCeiling`
      (DB-backed, `TEST_DATABASE_URL`, **not run here**, no Postgres in this
      environment) pins the SQL arithmetic. Neither proves the two-instance
      race itself; that is structural, and the old two-statement shape would
      have passed both. `gofmt`/`go vet`/`go test`/`go build` clean.
      Round-robin fairness untouched — the `row_number()` partition is
      byte-identical, only the LIMIT expression changed.

### Done when

- [ ] Every fal attempt whose request ID was returned is traceable to one `runs`
      row and that request ID in production. *(C1 code is landed; `0050`
      apply/read-back remains.)*
- [x] A cancelled dispatch cannot record a billed render as $0. *(C3)*
- [~] Duplicate clip and duplicate final are unrepresentable in the schema, not
      merely unlikely in application ordering. *(`0058` written; apply/read-back
      remains.)*

## P0 — the vendor client can replay a paid submission *(closed 2026-08-24)*

- [x] **X1 · The shared retry layer replays billable POSTs.** *Landed.* `doOnce`
      now routes every ambiguous outcome — network error, body-read failure, 5xx,
      and 408 — through `classifyAmbiguousFailure` (`fal/client.go:562`), which
      retries only for `GET`. A non-GET gets `ErrSubmissionOutcomeUnknown`
      (`:438`) and is never replayed. An explicit 429 still retries for every
      method (fal refused before starting work) and still honours `Retry-After`.
      Reused the stash hunk; `whisper.go:102`'s multipart initiate still bypasses
      `doJSON` untouched.
      *Proof:* `TestClient_Submit5xxIsNotRetried`,
      `TestClient_SubmitNetworkErrorIsNotRetried`, `TestClient_Submit408IsNotRetried`
      each assert one call to the server plus `errors.Is(ErrSubmissionOutcomeUnknown)`;
      `TestClient_Status5xxRetried` pins that idempotent GETs still retry.
      `go vet ./... && go test ./... && go build ./...` clean.
- [x] **XC1 · Route the ambiguous outcome away from `failScene`.** *Landed.*
      `failScene` (`dispatch.go:385`) tags the run's error with
      `store.BillingUnknownPrefix` (`store.go:128`, `"billing-unknown: "`) when
      `errors.Is(cause, fal.ErrSubmissionOutcomeUnknown)`. `cost_usd` stays nil —
      writing the estimate would fabricate a charge fal may never have made — so
      the prefix is what separates it from an ordinary unbilled failure. Tagged in
      `failScene` rather than at the call site: every path that can carry that
      error routes through it. The alert query is
      `select ... from runs where error like 'billing-unknown:%' and cost_usd is null`.
      *Proof:* `TestDispatchScene_AmbiguousSubmission_RecordsBillingUnknown`
      (`dispatch_test.go`) drives a real `fal.Client` over an always-502 transport
      and asserts one submit, `CostUSD == nil`, and the prefix on the `Run` reaching
      `MarkFailed`.

## P1 — concurrency, and what the worker can tell you

- [x] **X2 · ffmpeg and ffprobe now have deadlines.** All four
      `exec.CommandContext` sites take a `context.WithTimeout` child:
      `ffmpegTimeout` 30m (generous enough for caption burn-in of a full
      assembled video on one CPU), `ffprobeTimeout` 30s (metadata only). In
      `run` the timeout starts *after* the semaphore slot is acquired, so
      queueing for a slot does not eat the render's budget.
      *No automated check.* The change is two constants and a wrapper with no
      branch, and proving a 30-minute deadline fires needs either a 30-minute
      test or a production seam to shrink it — neither earns its keep. `go vet`
      catches a lost cancel; the rest is read.
- [x] **X3 · Integer config is bounded.** `intVar` is now
      `positiveIntVar` and rejects `n <= 0` in the shared function, so one guard
      covers all four callers (`RENDER_CONCURRENCY`, `FFMPEG_CONCURRENCY`,
      `PORT`, `RECONCILE_GIVE_UP_AFTER_MINUTES`) rather than four bound checks in
      `load`. `PORT` additionally rejects `> 65535` at its call site, the one
      upper bound that is not shared.
      *Proof:* `TestLoad_NumericVarsMustBePositive` (4 vars × {0, -1}) and
      `TestLoad_PortMustFitTCPRange`; both assert the error names the offending
      variable, since `load` reports every bad var at once.
- [x] **X5 · The Whisper prompt cap now slices runes.** `biasPrompt`
      converts to `[]rune` before truncating, so `maxPromptChars` finally means
      characters, as its own doc comment always claimed.
      *Proof:* `internal/captions/prompt_test.go` —
      `TestBiasPrompt_TruncatesOnRuneBoundary` builds a 250-rune CJK script (3
      bytes/rune, so a byte cut at 200 lands mid-rune) and asserts
      `utf8.ValidString` plus a 200-rune result. Verified to fail on the old
      code: it returned 68 runes ending in a bare `ä¸`.
- [ ] Confirm fal's real account concurrency limit, and whether it applies per
      model, endpoint, account, or API key. `render.yaml:266` still pins `10` with
      the note "raise once fal's account limit is confirmed" — provisional in both
      directions, and if the true limit is below 10 the worker already
      oversubscribes. Do not probe by submitting renders.
      *Newly possible:* `FAL_ADMIN_KEY` now exists on `ugc-web`
      (`web/lib/fal-balance.ts`, `web/lib/fal-usage.ts`). If fal exposes the limit
      under admin scope, this is answerable from that key instead of from support.
      The worker still cannot read it — API scope, 403.
- [ ] Set `RENDER_CONCURRENCY` from that evidence. C4 makes whatever number is
      configured actually hold; the number itself is a separate question.
- [x] Preserve round-robin fairness (`row_number()` partitioned by user) through
      any change to the claim. *(C4 changed only the `LIMIT` expression; the
      `ranked` CTE is byte-identical.)*
- [ ] Emit distinguishable events for submission, success, paid failure, unbilled
      failure, billing-unknown, and retry. **Today the alert surface is structured
      `slog` lines only** — no counters, thresholds, export, or aggregation, and
      `BalanceGate` added no metric either, only more log lines. Nothing separates
      a paid failure from an unbilled one at emission time; that distinction
      exists only as `runs.cost_usd IS NULL`, after the fact. Scope alerting from
      that, not from a wish list.
- [ ] Alert when fal accepts a request but its id cannot be persisted, and on
      billing-unknown attempts that stay unresolved. C1 and XC1 now provide the
      durable fields; aggregation and notification still do not exist.
- [ ] Alert when `BalanceGate` trips. It is the one condition that silently stops
      all rendering, it backs off to an hour between probes, and right now the
      only evidence is a log line nobody is watching at 3am.

## P1 — infrastructure hygiene

- [ ] **C10 · Pin the worker base images.** `golang:1.25-alpine` (`worker/Dockerfile:3`),
      `alpine:3.20` (`:20`), and `apk add --no-cache ffmpeg` (`:22`) all float.
      ffmpeg is the normalize, caption, and concat engine, so a silent minor bump
      changes output between two deploys of byte-identical source. A digest pin
      does **not** pin ffmpeg — `apk` still fetches the live index at build time —
      so this needs a version assertion in the build, not just a base-image digest.
      *Proof:* build the image and run it. Static inspection does not count.
- [x] **AGENTS.md's cost-accounting invariant is corrected.** The row now
      reads "a row per *attempt*, not per success", names the same-transaction
      `WHERE status = 'rendering'` guard that makes a paid failure bill exactly
      once and a twice-observed one not at all, and points at `cost_usd IS NULL`
      plus the `billing-unknown: ` prefix as the only signal separating an
      unbilled attempt from a paid one. Verified against `store.go:485` before
      rewriting, not from this file's summary of it.
      `docs/architecture.md` § "Dispatch — the queue" got the same treatment
      while C4 was in hand: its SQL sketch still showed `DISTINCT ON` and a
      caller-side `slots = CEILING - count(...)`, both of which the code
      contradicts.

- [ ] Land the worker-specific agent guide. Its 213-line first half — mission and
      boundary, code map, correctness invariants, money-safe development,
      verification — is in `stash@{0}` and still exists nowhere in the repo
      (`worker/AGENTS.md` does not exist); repo-wide `AGENTS.md` does not replace
      it. Land that half only; the review log attached to it does not belong in a
      standing guide. Its verification section needs one edit before landing: the
      Store seam means "needs a live Postgres" is no longer true of the loop
      package.

## P2 — role-based account cost controls

**Blocked, not started.** Do not implement until the team resolves the open
decisions in `docs/Account_Usage_and_Cost_Control_Plan_Proposal.md`. C1's code is
now landed, removing the ledger-identity prerequisite, but production still needs
the `0050` rollout and the proposal's product decisions remain unresolved.

## Needs an answer before code

None of these requires a paid render.

| Question | Blocks | How it gets settled |
|---|---|---|
| What fal actually charges, and how it bills a mid-generation failure | **C2, C9** — every `runs.cost_usd` is `fal.EstimateCost`, including failures priced at the full success rate | **Half-answered.** `/spend` → "Reconcile against fal" now pulls fal's own `unit_price` and `cost_total` per endpoint and diffs them against `runs` for a window. Run it and read the result — that settles the *rate*. It does **not** settle mid-generation failure billing: fal's line items carry no request id, so a discrepancy points at a model and a window, never at one render (`docs/spend-model.md:167`) |
| Whether fal exposes a cancel endpoint | **C7** — `pastTimeout` (`reconcile.go:220`) fails a scene at 20 min but never cancels at fal, so a late-completing render is paid for twice and the clip discarded. Still no cancel call anywhere in `fal/client.go` | fal API docs or support |
| fal's written queue-submit deduplication guarantee | Whether X1's no-replay policy can widen to match the official SDK's retry set | fal support, in writing |
| ~~How a billing-unknown attempt is recorded~~ | ~~XC1~~ | **Settled 2026-08-24, as recommended:** `cost_usd` null, `error` prefixed with `store.BillingUnknownPrefix`. Landed with XC1 |
| Production `DATABASE_URL` is the session pooler on 5432, not the IPv6-only direct host | Nothing — confirmation only | Render dashboard, `ugc-worker`, Environment. Declared `sync: false`, so it cannot be read from the repo |

## Work already written, in `stash@{0}`

`stash@{0}: On fix/go-review-wave1: wave1 + go review 2026-08-22 (pre fresh-start)`
— still present. **One item left in it:** the worker agent guide's first half.
Everything else below is landed or superseded, so the next person to open this
stash should expect to take one file out of it and then drop it.
Reusable rather than rewritable: `git stash show -p stash@{0} -- <path>`.

- C1's migration, `Run.FalRequestID`, and all three INSERT sites — **already
  landed as `29c52a8`; skip them.** The landed version also covers Whisper,
  archive triggers, web DB types, and the expected schema version.
- ~~C4's folded ceiling, with `CountRendering` deleted~~ — **landed 2026-08-30**,
  written fresh against the current `ClaimQueuedScenes` rather than restored
  (the stash's `store.go` predates the `0045` merge and `CaptionStyleForProject`)
- ~~X2, X3, and X5 implemented, with tests~~ — **landed 2026-08-30.** X3's and
  X5's hunks applied as-is; X2's constants and wrapper were reused, its stale
  `AudioEnabled`/`CaptionsEnabled` comment churn was not. The stash's
  `captions_test.go` was not used; `prompt_test.go` covers X5 instead
- X1's `client.go`/`client_test.go` hunks — **already landed, skip them.** They applied
  cleanly with `git apply -3` on 2026-08-24 and are now in the tree
- C3's `recoveryCtx` and both call sites — **already landed, skip it.** What
  shipped is equivalent; do not reapply this hunk.
- The worker agent guide's first half

The stash's `0044_runs_fal_request_id.sql` is superseded by landed migration
`0050`; do not restore it. Its `0045_one_clip_one_final.sql` **landed as
`0058_one_clip_one_final.sql`** on 2026-08-30 — 0051-0057 were already taken,
which is why that number is checked against the directory and never trusted from
this file.

`store.go` and `dispatch.go` conflict with everything that has landed since —
Dev B's `0045` merge, the `recoveryCtx` work, `CaptionStyleForProject`, the
`loop.Store` interface (any new store method must be declared on it too), and
now C4's rewritten claim. Nothing left in the stash needs either file, which is
the point: do not restore them wholesale.

## Proof rules

From `AGENTS.md`, restated because they are what these items get judged on:

- `cd worker && gofmt -l <edited files> && go vet ./... && go test ./... && go build ./...`
- SQL: apply it to the approved project, read a representative row back, paste it here.
- Dockerfile: build the image and run it.
- Webhook: send the same `request_id` twice and prove one asset and one run row.
- Never report behavior as working when its command was not actually run.
- `MOCK_FAL_VIDEO=1` for all normal development. A real render needs explicit
  authorization for the spend.
- New: a claim about what the worker *writes* is now provable in-package with
  `fakeStore`. Prefer that over "I inspected the SQL" — the latter is not proof.

## Not Dev A

Dev B owns web screens and Server Components, the prompt compiler,
editor/approver/admin dashboards, review-gate UI, auth UI, and template UI.
`web/lib/models.ts` and `web/lib/estimate.ts` are read-only here, for price parity
only — and `models-drift.test.ts` enforces that parity, so a worker price change
that forgets the web side fails CI.

`docs/kling-lipsync-test.md` is a written procedure for settling whether Kling's
native audio actually lip-syncs. It costs one paid render, so it needs
authorization; the doc says what to look for either way.
