# Roadmap

Two developers, split by service rather than by layer. One owns `web` (Next.js), one
owns `worker` (Go). Neither needs to read the other's language.

---

## Phase 0 — Prompt compiler, CLI only

**~1 week. Under $50. This is the phase that de-risks the project.**

No UI, no database, no deploy.

```bash
make compile SCRIPT=ad.txt
```

Deliverable: 30 video prompts from a real ad script, read by a human who can judge
whether they would produce usable video.

- [x] `web/lib/claude.ts` — structured output, versioned system template
- [x] `web/scripts/compile.ts` — CLI entry
- [x] Generate reference frames for 3 scenes, eyeball character consistency —
      held across all three, same face throughout
- [x] Render 3 real clips end-to-end to confirm prompts survive the model — a
      full demo-shaped ad (3 A-roll scenes, 32s, LTX with audio) came in at
      **~$1.46**, with the product pouch still legible in motion
- [ ] Compare Sonnet 5 vs Opus 5 on the same script — **measure, don't guess**.
      Still never measured. Opus is present in `web/lib/models.ts` but disabled.
- [ ] Render one scene both ways — Kling+audio vs LTX+TTS — and show the client.
      This answers the question worth ~$4,000/month. **Partly closed
      2026-08-24**: a Kling render against a real face and a real dialogue line
      was watched manually and the lip-sync read as clean. What is still
      missing is the *controlled* half — nobody has put an LTX clip and a
      Kling clip of the same scene side by side, so "looks good" and "worth
      2.8x LTX" remain different, unanswered claims. This is now the blocking
      question for a live vendor decision (comparing our cost against
      Higgsfield), not just an internal nice-to-have.
      **Protocol: `docs/kling-lipsync-test.md`** — a controlled per-scene
      comparison costing ~$1.82, using `scenes.render_settings_override` so the
      two clips differ in the model and nothing else.

**Exit criterion:** an operator looks at the prompts and says these would work.
If they don't, we learned it for $50 instead of after six weeks of UI.

---

## Phase 0b — Foundations (parallel, Dev A)

Phase 0 has no infrastructure work, so the first week goes to what unblocks everyone.

- [x] Render services (web + worker, Singapore), Supabase project, secrets, CI
- [x] `supabase/migrations/0001_init.sql` — agreed jointly, this is the contract
- [x] **Mock fal mode** — canned responses on a 3s delay, 10% synthetic failure rate.
      Dev B cannot build UI without it at $19 per test run.
- [x] Go project skeleton, Dockerfile with ffmpeg, health check (not yet deployed)

---

## Phase 1 — The pipeline

**~3–4 weeks.** The usable product.

### web — complete, running end-to-end against a real Supabase project and real fal in production

- [x] Auth — email + password. No SSO, no public signup; accounts are provisioned
      by an admin in the dashboard. Roles: admin reads everything, editor reads and
      writes only their own.
- [x] Projects list, new project, duplicate (the sanctioned way to iterate on a
      locked project, and the only way an admin acts on someone else's work)
- [x] Character setup — generated or uploaded reference, plus product photo
- [x] Compile → scenes, with live cost estimate
- [x] **Gate 1: Review Brief** — autosaving edits, A/B-roll toggle, cost reacts optimistically
- [x] Reference frame generation + **Gate 2: Review Frames**, per-frame regenerate
- [x] Enqueue (`status='queued'` — nothing more; verified no video call exists in web/)
- [x] Realtime progress UI
- [x] Per-scene retry
- [x] Per-user daily spend cap
- [x] Deliver: clips + manifest

Originally built and verified under `MOCK_CLAUDE=1` / `MOCK_FAL=1`; both services have
since run a real end-to-end render against real fal and a real database in production.

### worker — complete, running against real fal and a real database in production
- [x] fal client — submit, status, result over raw HTTP
- [x] Model routing + per-model pricing
- [x] Dispatch loop with concurrency cap and round-robin fairness
- [x] Webhook: signature verification, idempotency, copy-to-storage
- [x] Reconcile loop
- [x] Per-clip normalise on arrival
- [x] `runs` cost + latency accounting
- [x] **Per-user daily spend cap** — enforced in web at enqueue time

The model roster has grown past the LTX-only picture this phase was written against,
and then been cut back down. Between 2026-08-19 and 2026-08-28, LTX-2.3 Fast, Kling
3.0 Pro and all four Seedance tiers (2.0 Mini, 2.0 Fast, 2.0 Std, 2.5) were enabled on
fal after paid probes. On 2026-08-29 the operator narrowed the offered video models to
exactly two — **Seedance 2.5 and Kling 3.0 Pro** — so LTX-2.3 Fast and the three
Seedance 2.0 tiers are disabled again; their own probes still stand (see each
descriptor's `DisabledReason` in `worker/internal/fal/models.go`), this was a product
decision, not a retraction of any finding. Veo 3 Fast stays disabled; its request shape
has never been billed against. Seedance 2.5 is the first model here with a measured
1080p rate (the 2.0 tiers were 720p-only, upscaled on delivery); see
`worker/internal/fal/models.go` for the per-model rates and caveats, mirrored in
`web/lib/models.ts` for the operator-facing estimate. Disabling LTX also moved the
routing/default fallback: `Seedance25`, not `LTX23Fast`, is now `DefaultModelID` and
what `PickModel` substitutes a disabled/ineligible selection to (see `Seedance25`'s own
`Enabled` doc comment for the real cost consequence of that — every silent scene's
fallback rate went from $0.06/s to $0.4671/s+).

### 2026-08-31 — measured on kie, and the shape of the prompt

Everything below was read off the kie credit balance around one billed render,
never taken from a vendor's page.

| Model | Resolution | Rate | Note |
| --- | --- | --- | --- |
| Kling 3.0 Pro | 1080p | **$0.135/s** with sound | 405 credits for 15s |
| Kling 3.0 Pro | 1080p | **$0.090/s** silent | 54 credits for 3s |
| Hailuo 2.3 Pro | 768P | **$0.045/s** | 90 credits for 10s; enabled the same day |
| Seedance 2.5 | 720p | $0.315/s | measured 2026-08-28 |

A finished 24s four-scene ad with audio: **$2.97**, about $0.124 per delivered
second including compile, frames and captions. At the old fal-quoted rates the
same ad was $7.56 in renders alone.

**`billedSecondsMultiplier: 1.2` misdescribes kie.** On fal it was literal — a
6s request billed as 7.2 seconds. The two Kling measurements above show kie
charging a ~50% surcharge for AUDIO instead. The totals agree today only
because `PickModel` reaches Kling exactly when a scene is talking-head and
audio is on, so sound is never off where that rate is quoted. What it hides:
silent Kling is $0.09/s at 1080p, cheaper than Seedance at 720p and higher
resolution, and nothing in the app can reach it.

**Captions are off.** `CAPTIONS_ENABLED=0` on both services (2026-08-31,
operator decision). Whisper was the last live fal route — `runs` shows
`fal-ai/whisper` as the only fal model still billing anything — so with
captions off, nothing calls fal at all. That removes the blocker on deleting
fal as a vendor and makes `FAL_KEY` unnecessary in production. The code is
still there and still dormant.

**Template v9 restructured `video_prompt`.** Nine labelled sections instead of
one paragraph, the load-bearing one being Cross-Frame Rules: what must not
change between scenes. Written after a four-scene ad came back with the
presenter's face changed between scenes 3 and 4 — a paragraph has nowhere to
put a continuity rule. The format was observed in a competitor's workflow
running the same model we do; the difference was the prompt, not the vendor.
See `0061_seed_template_v9.sql`.

**Still open:** their tagged multi-references (`@greta_ref`) and an uploaded
MP3 voice reference. kie's `image_urls` is already an array and was proven to
accept two entries; `lib/reference-selection.ts` puts exactly one composite in
it. No known audio input on any kie video model — and it must NOT be probed
with `createTask`, which accepts unknown fields, returns 200, and bills the
render.

**A second video vendor is live for both enabled models.** (Written when kie was the
SECOND vendor. It is now the only one — fal was decommissioned 2026-08-31, and
`KIE_ENABLED` / the vendor-routing layer went with it: there is nothing left to route
between, so `KIE_API_KEY` is simply required in production. The probe findings below
are still current.) kie.ai was wired as a second vendor (`worker/internal/kie`, routed
at runtime by `worker/internal/loop/vendor_routing.go`'s `effectiveVendor`, not by a
Descriptor's own `Vendor` field) behind `KIE_ENABLED` + `KIE_API_KEY` + `KIE_MODELS`. Probed live on 2026-08-28 (Seedance 2.5) and 2026-08-29 (Kling 3.0 Pro):
kie carries exactly these two models and no others — every Seedance 2.0 tier and LTX
were tried and refused (422 "model name not supported"). Kling's request shape on kie
differs entirely from Seedance's (`mode`/`sound`/`multi_shots` instead of
`resolution`/`generate_audio`; see `worker/internal/kie/models.go`'s `kieModels` for
both). kie's insufficient-balance signal is now measured too — a `code: 402` envelope,
`kie.ErrInsufficientBalance` — after `worker/internal/fal/client.go`'s own version
(`fal.ErrInsufficientBalance`) is still an unconfirmed guess.

**Exit criterion:** someone on the team makes a real ad with it, unaided.

---

## Phase 2 — Operations

**~2 weeks.**

- [x] Cost dashboard off `runs` — per project, per user, per month. Shipped as `/spend`:
      iterate-vs-render split, a manual fal top-up ledger, and burn-rate runway.
- [x] Spend alerting — shipped as enforcement rather than notification. Four ceilings are
      checked before every spend (fal balance, team daily, account weekly, account daily)
      and the request → admin-grant workflow is how an editor asks for more.
- [ ] Template management and versioning UI — still nothing. Every template
      version ships as a hand-written seed migration (v8 is `0051`), which is
      the pain this would remove.
- [x] ffmpeg assembly — shipped (`worker/internal/loop/assemble.go`), and
      word-synced burned-in captions ride on it. ASR supplies timing only; the
      caption text comes from `scenes.script_line`, because Whisper rendered
      "CANOCO" for *Kinoko* and in a branded ad the brand name is the one word
      that cannot be wrong.
- [ ] Saved projects, delivery polish

---

## Verification

What the test suites actually prove, as distinct from what they appear to.

- **1747 web tests across 143 files**, plus a Go suite (`worker/internal/{config,http,
  ingest,kie,loop,media,store}`, all passing). Every file in `web/lib/`, `web/actions/`,
  and every route handler has a test. Untested and left so deliberately: most
  presentational components, `worker/internal/logging`, `worker/cmd/worker`.
  (`captions` and `fal` are gone from that list because both packages were deleted —
  captions with the feature, fal with the vendor.)
- **The `/ugc` console is covered at the component level** — column, scene strip, version
  rail, prompt editor, title, reference picker — which is a departure from "presentational
  components are untested". They are not presentational: each one holds a rule with a
  wrong answer that costs money, and each test was verified by breaking that rule and
  watching the named assertion fail. What is still NOT covered, and cannot be here, is
  whether the prompt editor's transparent mirror lands pixel-on-pixel over its textarea —
  jsdom computes no layout, so that stays an eye check.
- **DB-backed store tests now run.** They were gated on `TEST_DATABASE_URL` and had
  never once executed, because CI had no database. CI now has a `postgres:15` service
  and `scripts/ci/test-db-bootstrap.sql` stubs the Supabase-managed schemas a bare
  image lacks; `make db-test` does the same locally. Switching them on immediately
  exposed two bugs they had been hiding — a seed helper fighting the
  `on_auth_user_created` trigger, and `defer s.Close()` beating `t.Cleanup` to the
  pool. The `MarkDone`/`MarkFailed` double-completion guards are now genuinely
  verified rather than assumed.
- **RLS is tested on every table**, as the non-superuser `authenticated` role with a
  real `auth.uid()` reading the `request.jwt.claims` GUC, so policies are enforced
  rather than bypassed. Every covered policy has a negative control — broken
  deliberately, with the matching assertion watched to fail.
- **`ingest.FromResult` is covered** — the point where the webhook and reconcile paths
  converge. Ordering is asserted, because marking a scene done before the upload lands
  leaves it pointing at an object that is not there.

### Three traps this suite exists to remember

These each produced a test that looked like coverage and provided none. Eight were
found; **not one was caught by reading a test.** Every one surfaced by mutating the
code and watching what failed.

1. **Denial-only assertions.** A targeted `update ... where id = <other user's row>`
   proves nothing about an UPDATE policy: SELECT policies filter the `WHERE` lookup
   first, so it reports 0 rows even against `using (true)`. Only an *unqualified*
   write exercises a write policy. The same shape appears wherever a test asserts
   only that something is absent, denied, or zero — ask whether it would still pass
   if the subject denied *everyone*.
2. **Setup that can fail silently.** The `anon`-grants test reported every subtest
   green against a database whose migrations had not applied: "no grants on X" is
   trivially true when X does not exist. Scans and parsers need the same treatment —
   assert the parse found the expected number of things, or a broken regex passes
   forever while comparing nothing.
3. **Fixtures that never reach the branch.** Deleting an entire load-bearing pass from
   the credential redaction left all sixteen of its tests green, because no fixture
   was shaped to reach it. A mutation that no test notices means the coverage is
   missing, not that the code is fine.

The habit that works: break the thing a test guards, watch it fail, restore. Where a
test infers something indirectly — `worker/internal/ingest` infers "the store was
never touched" from a nil receiver panicking — pin the inference itself, so the test
cannot quietly stop meaning what it says.

### What the harness still does not cover

- **`anon` is held out by GRANTs, not by policy.** `characters_select` is
  `using (true)` with no `to authenticated`; a `GRANT ... TO PUBLIC` would admit an
  unauthenticated caller outright. A test pins the invariant via
  `has_table_privilege`, which resolves PUBLIC and inheritance — a grant-catalog row
  count does not.
- **The exact `Asset`/`Run` fields `MarkDone` receives** — vendor, model, cost,
  latency — feed the spend aggregates and are only observable over a real Postgres
  connection. Testing them needs a narrow interface seam on `ingest.Deps`.

### kie.ai: measured vs still assumed (2026-08-29, before editors)

Reading the code cannot settle a vendor's prices or a vendor's wire format. What
follows separates what was PAID FOR and observed from what is still inference, so
nobody reads a fallback as a measurement.

**Measured, on real billed calls:**

- Seedance 2.5 @720p — 63 credits/second at kie's published $0.005/credit, i.e.
  **$0.315/s**, a third under fal's $0.4671. Lives in `kiePricePerSecondUsd`
  (`web/lib/models.ts`) and `KiePricePerSecondUSD` (`worker/internal/fal/models.go`),
  kept in step by `models-drift.test.ts`.
- Reference images — `google/nano-banana` and `google/nano-banana-edit` both bill
  **4 credits = $0.02**, half fal's $0.0398, matching `KIE_REF_FRAME_COST_USD`.
- kie fetches a Supabase **signed URL** perfectly well as an edit-model input — the
  case the earlier probes had NOT covered, since they passed a kie-hosted image.
- Image latency: **13.7s** and **17.0s** end to end, against a 100s poll budget
  (`web/lib/kie.ts`) sized off a single earlier 70s observation. Far more headroom
  than that one sample implied, though still a blocking call inside a server action.
- `creditsConsumed` arrives as a JSON **float** (`4.0`, `378.0`). Decoding it as an
  int fails the WHOLE response, which hung a render once.

**Still assumed, and the assumption is in the unsafe direction:**

- **Kling 3.0 Pro has never been billed on kie.** Both sides fall back to fal's
  $0.14/s. The reasoning that falling back is "safe" generalises from Seedance and
  images, and Kling is a licensed model kie could as easily mark up. If kie's rate is
  higher, every Kling quote and every spend-cap check understates — the one direction
  this codebase forbids. One paid render of any length settles it.
- Seedance @1080p on kie, likewise unmeasured; keeps fal's $1.1497.

### The webhook has never once been delivered

Every render this project has completed came in through the reconcile poll:
twenty `reconcile: ingested render whose webhook never arrived` lines across six
days and both vendors. That phrasing points at the vendor and is wrong — a live
probe of `/webhooks/kie` returns **401, not 404**, so kie is calling and the handler
was turning it away in silence.

The cause was a guessed signing scheme, wrong in all three parts. kie's actual
convention (docs.kie.ai/common-api/webhook-verification) is `X-Webhook-Signature`
plus `X-Webhook-Timestamp`, signing `taskId + "." + timestamp` — not the body — and
base64, not hex. That is implemented now, along with a log line saying WHICH of the
three failure reasons applies, since the silence was the real defect.

**It still will not fire.** kie's signing is opt-in: someone must generate a
`webhookHmacKey` in the kie settings page and set `KIE_WEBHOOK_SECRET` on
`ugc-worker` (declared in `render.yaml`, currently empty), then redeploy — an env
change alone does not trigger one here. Until then every completion arrives 45-90s
late through the poll, which is slow rather than broken.

The worker now says so at startup rather than leaving it to be inferred: an empty
`KIE_WEBHOOK_SECRET` logs a warning naming the consequence, not just the missing
variable (`config.Config.Warnings`). (`KIE_ENABLED` no longer exists — kie is the only
vendor, so there is no opt-in to gate it behind.) It is a warning and not a startup error on
purpose — kie's signing is opt-in on their side, so a deployment without the key is a
legitimate state.

---

## Timeline

**~6–7 weeks to daily internal use.** Assumes fal for all generation and no Cartoon
pipeline in v1. Cartoon adds roughly 3 weeks.

---

## Work split

### Dev A — `worker/` (Go)

Owns the entire Go service. No React, no TypeScript.

| Area |
|---|
| Render + Supabase projects, environments, secrets, CI |
| fal client and model routing |
| Dispatch, reconcile, assemble loops |
| Webhook: signature, idempotency, storage copy |
| ffmpeg normalise + concat |
| `runs` cost accounting, spend caps, alerting |
| Structured logging |
| Mock fal mode |

### Dev B — `web/` (Next.js)

| Area |
|---|
| All screens, SSR, Server Components |
| **The prompt compiler** — highest-value, highest-risk component |
| Supabase schema, RLS, Realtime subscriptions |
| Both review gates |
| Auth |

### Interface

Agree `0001_init.sql` and the scene state machine on **day one**, then work
independently. After that the two services never need to coordinate.

```
web  writes scenes: draft → frame_ready → queued.  Reads everything.
go   writes scenes: queued → rendering → done/failed.  Owns assets + runs.
```

---

## Risks

- **Two languages, two people, no overlap.** Each service has a bus factor of one.
  Acceptable for an internal tool; worth knowing.
- **Nobody reviews anybody.** Neither developer reads the other's language well enough
  for meaningful review. Design the schema and state machine jointly so the shared spine
  gets four eyes — it is the only part where a mistake hurts both sides.
- ~~**Pricing appears twice**~~ — still duplicated (`web/lib/models.ts` for UI estimates,
  `worker/internal/fal/models.go` for actual spend), but **drift now fails CI**:
  `web/lib/models-drift.test.ts` parses the Go file and compares model ids, endpoints
  and per-resolution prices. It also asserts the parse found the expected number of
  models, so a refactor that breaks the regex fails loudly rather than quietly
  comparing nothing.
- **Perf under real load is unverified.** Instrumentation shipped
  (`PERF_LOGGING_ENABLED=1`, emitting `perf_render:` / `perf_boot:`), but the logs have
  not been read yet.
- **Vendor rates move under us with nothing scheduled to re-check them.** whisper's
  rate read $0.0008/compute-second on 2026-08-24; re-reading fal's billing API on
  2026-08-28 found it had moved to $0.00125 with no notice, and every caption pass
  in between had been under-recording cost by 56% (`ab60844`,
  `web/lib/models.ts`'s `WHISPER_COST_PER_COMPUTE_SECOND_USD`). `checkVendorPrices`
  (`web/lib/ledger-reconcile.ts`) reads fal's own billing API and would have
  surfaced the gap on any press of the reconcile button — the gap was that nobody
  had pressed it, not that the check was missing. Nothing presses it on a schedule.
- ~~**The allowance-refund-on-delete hole.**~~ **Closed** by
  `0040_include_archived_cost_in_spend_reads.sql`, which rewrote all five spend-read
  functions (`spend_total_usd`, `user_spend_usd`, `spend_totals_by_user`,
  `spend_category_totals`, `spend_category_totals_by_user`) to include the archive
  `0038` writes. Deleting a project no longer refunds the allowance it spent.
- ~~**The compiler never sees the reference image, only text**, so it invents product
  containers and packaging. A proposal to store the product's packaging appearance on
  the project is pending a decision.~~ **Shipped.** `0041_product_appearance.sql` adds
  `projects.product_appearance`; `web/lib/claude.ts`'s `buildProductAppearanceSection`
  puts it in the prompt, and `actions/compile.ts`, `actions/brief.ts` and
  `actions/character.ts` all thread it through. The compiler still never sees the image
  — it now gets the operator's description of it instead, which is what the proposal
  asked for.

---

## Open questions

Blocking, in order of impact:

1. **Should admins have read access to other people's projects?** `0002_rls.sql`'s
   `projects_select` currently grants `is_admin()` read-everything; undecided whether
   that's the intended long-term policy.

2. **Should Kling be restricted to `trusted_editor`?** A ~3-scene Kling ad runs ~$4.35
   against a regular editor's $5/day cap — close enough to the ceiling that one ad can
   exhaust a day's budget.

3. **Remaining non-code handoff steps before real use:** fund the fal account, set
   `SIGNUP_ALLOWED_DOMAINS`, and swap the placeholder accounts for a real admin — in
   this exact order, because each step is what makes the next one possible:

   1. **Create the real admin account.** Signing it up self-serve leaves it `pending`
      (`0052_account_approval.sql` flips the column default after backfilling existing
      rows), so it cannot reach `/users`, `/allowances`, or anything else yet.
   2. **Approve it from `/users`, signed in as an existing placeholder admin.** The
      placeholder accounts predate `0052` and were backfilled to `active`, so they are
      the only accounts that can still get in to do this.
   3. **Only then delete the placeholder accounts.**

   Deleting first leaves nobody able to approve — neither the new admin (held at
   `/pending` by its own status) nor anybody else (an approval needs an admin who can
   sign in), and no allowance request has an approver either. Recovering from that
   means a hand-written `UPDATE profiles SET status = 'active'` in the Supabase
   dashboard, which is exactly the manual step this ordering exists to avoid.

4. ~~**Migrations unapplied.**~~ **Applied 2026-08-22.** The remote turned out to be at
   `0043`, not `0045`, so five went up together: `0044` (sidebar snapshot RPC), `0045`
   (per-scene render settings), `0046` (applied_schema_version), `0047` (template v7)
   and `0048` (media policy fix). `0031`-`0033`'s "reviewed and staged, not run" notes
   were stale — all three were already applied. Verified against production after the
   push: `applied_schema_version()` returns `0048`, `prompt_templates` is at version 7,
   and all four `media_*` policies read `[2]` with `'projects'` pinned. (Those two
   figures are what was true on the day, not now — as of 2026-08-25 the remote is at
   `0051` and `prompt_templates` is at version 8.)

   **2026-08-31, and the one that needs care:** the branch now carries `0058`-`0070`.
   Most are additive, but **`0070` is a rename** — `scenes.fal_request_id`,
   `runs.fal_request_id` and `deleted_project_cost_history.fal_request_id` all become
   `kie_task_id`, and `fal_topups` becomes `kie_topups`.

   A rename is the one shape where schema-leading-the-code does NOT hold. Old code
   cannot read `kie_task_id` and new code cannot read `fal_request_id`, so the migration
   and the deploy have to land together rather than in the safe order everything above
   assumes. There is no window in which both work.

   `0070` also recreates `archive_project_cost_history`, and that is the reason it is a
   migration rather than a sequence of `ALTER`s: the trigger builds its `INSERT` as a
   dynamic SQL string, which a column rename cannot reach inside. Postgres would accept
   every rename and leave the function naming a column that no longer exists — failing
   not at migration time but the next time somebody deleted a project, which is the one
   moment that trigger exists for. Any future rename must grep `pg_get_functiondef` for
   the old name, not just the column list.

   **Since then:** `0052` (account approval) and `0053` (the `is_active()` gate on
   scene/asset/run write policies — the half of the spend chain `0052` left open)
   merged via PR #10; `0054` (a deleted scene no longer takes its spend out of the
   project's totals) via PR #12; `0055` (admins bypass account approval by role,
   rather than needing a second approval decision) via PR #11; and `0056` (a
   Seedance render counts as a render, not iteration, in the `/spend` split) via
   PR #14. The hosted database was checked directly on 2026-08-28 and reports
   `0055` — **`0056` is written and merged but not applied.**

   **`0057` (2026-08-29) reverses the ordering, and unlike `0056` it does not fail
   quietly.** It adds `projects.character_desc_edited_at` /
   `product_appearance_edited_at`. The two halves behave differently against a
   `0055`/`0056` database, and only one of them is safe:

   - **Reads degrade, as intended.** `requireProject` fetches `select("*")`, so an
     older database simply returns a row without those keys; `isDescriptionStale`
     (`web/lib/description-staleness.ts`) reads the missing value as absent and
     answers "not stale". The banner does not appear, and nothing throws — the same
     null-means-not-stale default `0057`'s own header argues for.
   - **The write breaks.** `saveCharacterSetup` (`web/actions/character.ts`) sets
     `character_desc_edited_at` / `product_appearance_edited_at` in its update
     whenever either text actually changed, and PostgREST rejects an update naming a
     column that does not exist. So Save fails on exactly the saves that matter —
     the ones where the operator edited a description — while a title-only save
     still succeeds. That is a worse shape than a page that is plainly down: it
     works until it doesn't, on the repo's most-used screen.

   So the order is load-bearing rather than merely tidy: **apply `0056` and `0057`
   first, then deploy.** (That was the state on the day. As of 2026-08-31 the branch
   carries migrations through `0070` and `EXPECTED_DB_VERSION` is `0070` — see the note
   at the end of this item.) `web/lib/version.ts`'s `EXPECTED_DB_VERSION` was at `0057`
   and the sidebar and `/api/health` both print the applied version, so the gap is
   visible — but that is a diagnostic, deliberately never a gate (see that file), and
   it will not stop a deploy that goes out in the wrong order.

   Everything before `0057` left **the schema leading the code**, which is the safe
   direction and exactly what `0044`'s commit asked for. Two consequences while the
   branch is unpushed:
   - ~~The camera fix is **half-deployed**. Template v7 is live, but the deployed code
     still only prepends the override instead of replacing it, so static-mode prompts
     keep the same contradiction they already had — no worse, no better, until the
     branch ships.~~ **Shipped** in `ea9f06d` (replace, not prepend) and `62ce8c1` (keep
     the OVERRIDE sentence only when propped-phone wording survives elsewhere);
     `web/lib/claude.ts`'s `applyCameraMovementOverride` carries both.
   - `0048` changes nothing observable yet: storage is reached only through the
     service-role client, which bypasses RLS. It becomes real protection the day
     anything reads storage as `authenticated`.
