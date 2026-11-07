# Architecture

## Two services, one database

```
Browser ──► web (Next.js, SSR)  ──── read/write ────┐
                                                     ▼
                                              ┌────────────┐
kie webhook ──► worker (Go)     ──── jobs ───►│  Postgres  │
                                              └────────────┘
```

The two services **never call each other**. There is no REST API between them, no
GraphQL, no shared client library, and no cross-language type generation. Postgres is
the interface.

This is the decision everything else follows from. The alternative — Next.js as a thin
frontend calling a Go API — costs roughly 35% more code (endpoint + validation + fetch +
loading state for every feature) and requires hand-syncing Go structs against TypeScript
types, which the compiler cannot check. Sharing a database removes the boundary and
keeps full server-side rendering with no additional network hop.

### The contract

`scenes.status` is the only column both services write, and each owns a disjoint half:

```
web  →  draft → frame_ready → queued
go   →  queued → rendering → done / failed
```

**web never touches `rendering`. go never touches `draft`.** When the editor clicks
Render, the web app performs one update — `status='queued'` — and its involvement ends.

This rule belongs in the migration comments. It is the first thing a new contributor
will break.

---

## Responsibility split

| | web (Next.js) | worker (Go) |
|---|---|---|
| SSR, Server Components | ✅ | |
| Auth | ✅ | |
| Read projects / scenes | ✅ | |
| Prompt compiler (Claude) | ✅ | |
| Reference frame generation | ✅ | |
| Edit prompts, toggle A/B-roll | ✅ | |
| Enqueue a render | ✅ *(status only)* | |
| Submit to kie | | ✅ |
| Receive webhooks | | ✅ |
| Dispatch loop, concurrency cap | | ✅ |
| Reconciliation | | ✅ |
| ffmpeg normalize + concat | | ✅ |
| Cost accounting | | ✅ |

The rule: **web owns the human, go owns the machines.**

---

## User flow

Costs below are for a **30-scene project at 720P on Seedance 2.5** — the large end.
Scale is close to linear in scene count, because step 7 dominates. Every figure here is
derived from the rate points in "Cost model" below; nobody has re-measured a whole ad
end to end since kie replaced fal, so treat the total as arithmetic rather than as a
receipt.

```
1. New Project      paste script                              free
2. Character setup  persona description or reference photo    ~$0.04
3. Compile          Claude splits script into scenes          ~$0.07
4. ▸ REVIEW BRIEF ◂ operator edits prompts                    GATE — free
5. Ref frames       one image per scene                       ~$1.19
6. ▸ REVIEW FRAMES ◂operator regenerates bad ones             GATE — $0.04 each
7. Render           N clips via kie                           ~$76  ← the money
8. Watch            Realtime progress, per-scene retry
9. Deliver          clips + manifest, or assembled mp4
```

**Everything before step 7 costs under a dollar. Step 7 is irreversible.** The two gates
exist so nobody reaches step 7 with a brief nobody read. The render button shows the
estimated cost, recalculated live as the operator toggles scenes between models.

---

## The second route: `/ugc`

Everything above describes the **scripted pipeline** — paste a script, compile it into
scenes, review, render them all, assemble. `/ugc` is a different product on the same
spine, and it exists because that is not how the operator this was built for actually
works.

Their loop is: paste one prompt, attach references, render a clip, download it, repeat,
and assemble the results in CapCut. So this route deliberately does **not** touch the
compiler, frame generation, ffmpeg assembly, captions or delivery. It is one screen: a
prompt, a per-scene references box, a model/resolution/duration picker, and a button
that spends. The picker defaults a new scene to Seedance 2.5 at 480p/4s but is not
pinned to it — it offers every `offerable()` model/resolution pair and follows whichever
the selected scene actually used (see `AGENTS.md`'s "`/ugc` is a picker now" for the
mechanics: the References box, the Kling start+end-frame flow, retry, and the optimistic
Generate tile all live there rather than being re-explained here).

```
/ugc/[id]   one clip project
  ├── scene strip      every clip in this project, horizontal, ?scene= selects
  ├── column           prompt + reference + model + duration + Generate/Regenerate
  └── version rail     every ATTEMPT at the selected clip, vertical
```

Three distinctions carry the whole design, and each has a wrong answer that costs money:

- **A clip is a scene.** Every press of Generate appends a row to `scenes` in a real
  project. That is not an implementation detail dressed up as a feature — it is the
  reason the spend caps, allowance grants and RLS policies apply to this route at all,
  since every one of them hangs off `projects` and `scenes`.
- **Selected is not current.** The rail shows every attempt; looking at one changes
  nothing on the server. Only "Make current" writes `scenes.active_version_id`.
  Conflating them is how a good take gets demoted by a click meant to inspect it.
- **The button follows the result box.** Generate while it is empty, Regenerate once it
  holds something. Both spend, so the word has to be right before the press.

A project is created as `kind='clip'` (`0064`), which is what makes its title open this
console rather than the six-step wizard.

`actions/ugc.ts` is the money path, and its ordering is **not** `enqueueScene`'s:
enqueueScene validates a scene that already exists, while `generateClip` creates the one
it is about to render, so the cap check runs BEFORE anything is written. A refusal must
not leave an orphan scene and an uploaded image behind.

---

## Development mode

`MODE=production | development` is read once at startup, on both services. It replaced
three independent per-vendor mock flags (`MOCK_CLAUDE`, `MOCK_FAL_IMAGE`,
`MOCK_FAL_VIDEO`), whose shape was itself a money bug: three switches meant a
half-mocked run was a legal configuration.

In `development`:

- **web** mocks every vendor call — Claude compile, kie image generation — and skips the
  kie balance read entirely.
- **worker** simulates the render. `kie.Client` returns a mock task id and, after a
  short delay, points ingest at `/mock/clip.mp4`, a real H.264 fixture embedded in the
  worker binary and served by the worker itself. Nothing reaches kie.

**An env flag alone was never enough, and this is the part worth understanding.** The
render queue is shared: one Postgres, and any worker polling it can claim any queued
row. A flag decides what a worker does *after* it claims a job — it has no say in
*which* jobs it claims. So a development worker would happily claim a paying customer's
scene, mock it, and write a fake clip over real work.

The fix is a column, not a flag. `scenes.dev` (`0063`) and `final_versions.dev` (`0069`)
are written by whichever web app queued the row, and the worker filters on them in
`ClaimQueuedScenes` (both its candidate set and its ceiling count), `StaleRendering` and
`ClaimPendingFinalVersions`. The last two matter as much as the first: without them a
development worker would eventually mark a real in-flight render failed, or assemble a
real delivery.

`KIE_API_KEY` is required in production and **optional in development**, which is also a
safety property rather than a convenience — demanding it would force a real credential
into a local config whose whole purpose is that it touches nothing.

## The worker

Four concurrent loops in one process:

```go
go loop.Dispatch(ctx)     // every 30s: queued → kie, respecting concurrency cap
go loop.Reconcile(ctx)    // every 30s: find renders whose webhook never arrived
go loop.Assemble(ctx)     // every 30s: complete projects → ffmpeg → storage
http.ListenAndServe(...)  // POST /webhooks/kie, GET /health (+ /mock/clip.mp4 in dev)
```

All three intervals are 30s (`cmd/worker/main.go`); what differs is the age a row must
reach before a loop will touch it — `staleAfter = 45s` for reconcile, `timeoutAfter =
90m` before a render kie still reports as in progress is failed.

The HTTP server exists for kie's callback and Render's health check. Nothing else calls
the worker. In `MODE=development` it also serves `/mock/clip.mp4`, the fixture a mocked
render "produces" — see "Development mode" below.

### Dispatch — the queue

The web app does not submit renders; it marks scenes `queued`. The worker decides when
to submit, which is what keeps 20 editors from collectively blowing through kie's rate
limit:

```sql
-- Sketch. The real statement is ClaimQueuedScenes
-- (worker/internal/store/store.go): it ranks with row_number() rather than
-- DISTINCT ON (which would drip out one scene per user per tick), and it
-- subtracts the ceiling INSIDE the claim —
-- LIMIT greatest(0, CEILING - (select count(*) ... where status='rendering'))
-- rather than counting first and claiming second, so the limit holds across
-- worker instances and not merely within one.
SELECT s.* FROM scenes s JOIN projects p ON p.id = s.project_id
WHERE s.status = 'queued'
ORDER BY row_number() OVER (PARTITION BY p.user_id ORDER BY s.created_at)
```

Round-robin matters: without it, one editor queueing 300 clips blocks everyone else for
hours. With it, a heavy user cannot starve a light one.

### Webhook rules

Three things that silently corrupt data if missed:

1. **Copy the file immediately.** Vendor result URLs expire. Storing one in the database
means the video disappears within days. 2. **Be idempotent.** A webhook may arrive
twice, and the reconcile poll may reach the same render independently. Without a `status
= 'done'` guard you get duplicate assets and double-counted cost. This one is not
hypothetical here: reconcile is currently the ONLY path that completes a render (see
below), so the guard is what keeps a late webhook from re-ingesting work the poll
already finished. 3. **Always return 200**, even on internal error, so a vendor that
retries on failure does not retry forever.

Whether kie retries on a non-200 is **not verified** — the fal-era claim that it does
was about fal. It is left as a rule anyway because the cost of following it is nothing
and the cost of being wrong is a retry storm.

### Reconcile — webhooks get lost

A deploy mid-render, a 500, a network blip, and a scene sits in `rendering` forever.

```sql
SELECT * FROM scenes
WHERE status = 'rendering'
  AND submitted_at < now() - interval '45 seconds';
```

For each, ask kie directly: completed → ingest, past 90 minutes → mark failed.

**This is not the slow path here, it is the only path.** The kie webhook has never once
been delivered to this deployment — kie's signing is opt-in and `KIE_WEBHOOK_SECRET` is
empty, so every callback is rejected and every completion arrives 45-90s late through
this poll. `docs/roadmap.md` § "The webhook has never once been delivered" has the
detail; the worker logs a warning naming the consequence at startup.

**The webhook is the fast path. The reconcile loop is the correct path. Both are
required.**

---

## Schema

```sql
prompt_templates  id, name, version, body, created_at      -- immutable, versioned
projects          id, user_id, title, script_raw, status
scenes            id, project_id, idx, script_line,
                  video_prompt, is_talking_head,
                  template_id, edited_by_human,
                  status, kie_task_id, submitted_at,
                  ref_frame_asset_id, render_settings_override
assets            id, project_id, scene_id, kind, storage_key, duration_s, bytes
runs              id, scene_id, kie_task_id, vendor, model, cost_usd, latency_ms, error, created_at
profiles          id, role, daily_cap_override_usd, weekly_cap_override_usd  -- per-account overrides (0031)
allowance_requests / allowance_grants   id, profile_id, status, expires_at   -- request + grant workflow (0032)
kie_topups        id, amount_usd, created_at                                 -- manual ledger of kie credit top-ups (0036, renamed 0070)
```

**`prompt_templates` is immutable.** New version, never an update. When output quality
drifts you must be able to answer *which template produced this*.

**`runs` is one row per attempt, not per success.** Retries and failures are where the
budget actually goes. Without this table you cannot explain a month's spend.

**`edited_by_human`** flags any prompt the operator touched. If operators keep fixing
the same class of prompt, the template is broken — this column is how you find out.

**`account_spend_windows`** (`0031_account_allowances.sql`) is a view over `profiles`'
per-account cap overrides. Its day/week boundaries are computed `at time zone
'Asia/Manila'`, mirroring the TypeScript enforcement exactly, so the admin read and the
cap check can never disagree about what "today" means.

**`allowance_requests` / `allowance_grants`** (`0032`) let an editor request a temporary
cap raise; a grant carries an `expires_at`. `0033_allowance_requests_rls_fix.sql` closed
a hole where the `using` clause was missing `status = 'pending'`, which let an editor
`PATCH` their own already-approved request through PostgREST.

**`kie_topups`** (`0036`, renamed from `fal_topups` by `0070`) is a manual ledger of kie
credit top-ups — this is what makes burn rate and runway computable.
`0037_spend_category_totals.sql` splits recorded spend into iterate vs render.
`0038_preserve_cost_history_on_delete.sql` archives cost rows so deleting a project no
longer erases its cost history — see "Known gaps" for the part of this that isn't fully
wired up yet.

**`scenes.render_settings_override`** (`0045`, applied) is a *partial* jsonb settings
object — typically just `{"model": ...}` — that lets a retry re-render one scene on a
different model than the rest of the project. Effective settings are
`projects.render_settings || coalesce(override, '{}'::jsonb)`, merged in SQL in all
three worker queries that return `render_settings` and mirrored in TypeScript by
`mergeRenderSettings` (`web/lib/models.ts`). It's sticky — nothing clears it, not even a
successful render, because it's the record of what that scene was actually billed at —
and every pricing/spend-cap site must resolve the merged, effective settings rather than
`projects.render_settings` directly, or the cap can be priced against a model the scene
never actually renders on. See "The one lever that matters" below.

**Newer tables (`0058`–`0098`), summarized rather than enumerated:**

- **`scene_versions`** (`0058`–`0059`) bundles one attempt's prompt, reference frame,
  clip and render settings into a single row, because the three are not independently
  meaningful — `scenes.active_version_id` says which one the delivery uses.
- **`final_versions`** (`0060`, plus `.dev`, `0069`) versions the assembled export
  instead of destroying the previous one on every re-assemble.
- **`elements`** (`0065`, widened by `0072`–`0073`, `0081`, `0091`/`0096`–`0097`) is an
  operator's own reusable `@tag` library (characters, products, voices, videos) —
  separate from the admin-curated `characters` table, and now shareable.
- **`scene_references`** (`0071`, kinds widened by `0079` audio and `0093`–`0094` video)
  is the per-scene, ordinal-numbered reference box `AGENTS.md` describes — ordinal is
  the contract, since kie binds `@image1`/`@audio1` by array index, not by prompt text.
- **`projects.kind`** (`0064`, extended `0067`, `0084`) distinguishes a scripted project
  from a `/ugc` clip project (and, later, an image project) so the title link routes to
  the right console.
- **Soft-delete trash bins** — `deleted_scenes` (`0088`) and `deleted_scene_versions`
  (`0092`) copy a row one step ahead of its cascade delete, so a scene or a single take
  can be restored rather than being gone the moment the transaction commits.
- **The image generator** (`0083`, `0085`, `0095`) is a separate Postgres-function
  reservation path for paid image calls (see `docs/image-generation-route-plan.md`) — it
  does not touch `scenes` or video rendering at all.

**`sidebar_budget_snapshot`** (`0044`, applied) is a single Postgres function that
collapses the sidebar's six concurrent spend/grant reads into one round trip. It calls
`user_spend_usd`/`spend_total_usd`/`user_active_grants_usd` — the same functions
`assertWithinSpendCaps` enforces against — rather than reimplementing their SQL, so the
sidebar's numbers cannot drift from what's actually enforced. See "Known gaps" for why
six reads cost as much as they did.

### Derived status

Project status is computed on every read (`web/lib/project-status.ts`
`deriveProjectStatus`), not trusted from the `projects.status` column — a stored value
drifts the first time a webhook lands during a deploy, which is exactly what happened:
nothing ever wrote `'complete'`, so a finished project sat at `'rendering'` forever.

```
complete  = no scenes in (queued, rendering), and at least one scene left draft/frame_ready
rendering = any scene queued or rendering
framed    = all scenes have ref_frame_asset_id
draft     = no scenes yet
```

`delivered` is the one status that genuinely is stored, not derived: it's set by a human
clicking Mark delivered (`actions/deliver.ts`), and no combination of scene statuses can
imply it. `projects.status` still holds it — see `0018_derived_project_status.sql` for
why the column stays instead of being dropped. `reopenProject` reverses it.

**Commitment and concurrency are two different axes** (`web/lib/editable-guard.ts`) and
must not be collapsed. Commitment is `projects.status = 'delivered'` — the thing that
locks editing. Concurrency is a scene being `queued` / `rendering`, guarded by the
narrower `isSceneInFlight(status)`. The edit lock used to fire at render-start; it now
fires at Delivered, so an editor can iterate freely on a project right up until they
commit it.

---

## The prompt compiler (optional)

**Not on the render path any more.** Editors write prompts directly in `/ugc`; Claude
handles the project Script compiler, while reference image descriptions use kie Gemini.
The compiler needs `ANTHROPIC_API_KEY`; explicit image descriptions from the
element editor need `KIE_API_KEY`. Uploading an element makes no vendor call.

Lives in `web`, because it runs synchronously inside the operator's request.

```ts
const Brief = z.object({
  character: z.string()
    .describe("One sentence: face, age, clothing, setting. Identical across all scenes."),
  scenes: z.array(z.object({
    script_line:     z.string(),
    video_prompt:    z.string(),
    is_talking_head: z.boolean(),
    duration_s:      z.number().max(8),
  })),
});

const r = await anthropic.messages.parse({
  model: "claude-sonnet-5",
  max_tokens: 8000,
  system: template.body,            // from prompt_templates, versioned
  messages: [{ role: "user", content: script }],
  output_config: { format: zodOutputFormat(Brief) },
});
```

Three jobs:

1. **Split the script.** 8 seconds is the model ceiling. Cuts must fall on natural
boundaries, not mid-sentence. 2. **Write the video prompt.** A line of dialogue has to
become a full cinematic description. The distance between those two is the entire
product. 3. **Set `is_talking_head`** — real information about the script, carried on
every scene. It no longer routes anything by itself; see "The one lever that matters"
below for what it takes, together with a project's own model selection, to actually
change price.

**Character consistency is not model magic.** The `character` string is written once and
injected into all N prompts, with the reference image passed as `image_url` on every
call. Discipline, not features.

---

## Cost model

**kie bills in credits, at 200 to the dollar.** Dollars are derived, never stored as the
source figure — `web/lib/kie/rates.ts` holds credits per second and everything else
divides.

`web/lib/kie/rates.ts` holds fifteen rate points across five models — genuinely
everything kie has been asked for or has published. The rates that matter day to day,
all receipts unless noted:

| model | resolution | sound | credits/s | $/s | provenance |
|---|---|---|---|---|---|
| `hailuo-2.3-pro` | 768P | — | 9 | $0.045 | receipt |
| `kling-3.0-pro` | 1080p (pro) | silent | 18 | $0.090 | receipt |
| `kling-3.0-pro` | 1080p (pro) | with sound | 27 | $0.135 | receipt |
| `kling-3.0-pro` | 720p (std, `/ugc` shows "480p") | with sound | 20 | $0.100 | receipt |
| `seedance-2.5` | 480P | with sound | 28 | $0.140 | receipt |
| `seedance-2.5` | 720P | with sound | 63 | $0.315 | receipt |
| `seedance-2.5` | 1080P | with sound | 114 | $0.570 | **published**, promo ends 2026-09-17 |
| `seedance-2.5` | 480P, video reference attached | with sound | 17 (billed input+output s) | $0.085 | receipt |

Kling has no `generate_audio` field — it reads `sound` instead — so its silent and sound
tiers are two genuinely different rates, not a base plus a surcharge: 18 → 27 credits/s
at 1080p, 14 → 20 at 720p/std. **Resolution does not order the price**: Seedance at 480P
costs more per second ($0.140) than Kling at 1080p silent ($0.090). A video reference
*lowers* Seedance's rate (28 → 17 cr/s) but bills more seconds — input plus output
rather than output alone — which is why it isn't simply cheaper.

### Provenance is part of the rate

Every rate carries where it came from: `receipt` means the kie credit balance (or
`creditsConsumed`) was read either side of one real render, `published` means it comes
off kie's page and nobody has been billed at it. Most of the table is receipts now; the
unmeasured tiers (Seedance 2.5 1080P, the higher Seedance 2/2-fast resolutions) are
labelled in the product, not silently averaged in.

**There is no fallback.** `rateFor()` returns `null` for an unpriced model/resolution
pair and every caller has to handle it — refuse the render, or label it. Nothing is ever
filled in from another vendor's number. That rule exists because the opposite of it cost
real money: see the appendix.

`lib/kie/offerable.ts` goes one step further and refuses to SELL a pair whose rate is
only `published`, which is a stronger question than whether it can be quoted.

### What a clip actually costs

The `/ugc` default — Seedance 2.5 at 480P, 4 seconds, sound on (every render sets
`generate_audio: true`) — is **112 credits, $0.56**. That figure is worth remembering
because it is the unit of this whole route: an operator producing an ad does this ten to
thirty times. A video reference attached to the scene drops the rate to 17 cr/s but
bills input-plus-output seconds, so it isn't automatically cheaper.

**The old $1.46 end-to-end figure is gone with fal.** It was measured on LTX-2.3-Fast, a
model this system can no longer reach, and nobody has re-measured an ad on kie. Do not
quote it.

### Where the money goes

Unchanged in shape from the fal era, and the reason there is no separate Claude credit
system: **video generation dominates and the prompt compiler is a rounding error.** A
compile is cents; a thirty-clip ad is tens of dollars. Metering compile spend separately
from render spend stopped making sense the first time anyone measured a real render.

`runs.cost_usd` is **truthful on kie** in a way it never was on fal: it is written from
the `creditsConsumed` kie reports for that task, not computed from a rate table. That is
why the `/spend` "Reconcile against the vendor" control was deleted rather than ported —
the drift it existed to detect cannot happen when the ledger records what was billed.

### Compiler models

`COMPILER_MODELS` (`web/lib/models.ts`) is operator-selectable per project. Haiku
($0.04) and Sonnet ($0.12) are enabled; Opus, GPT-5, and GPT-5-mini are present but
disabled.

### Spend controls — required before real use

Role cap defaults live in `render.yaml`: regular editor `DAILY_CAP_USD`/`WEEKLY_CAP_USD` default to `0`, trusted `10`/`25`, and admin `100`/`700`. The optional global cap is stored in `app_settings`, defaults to enabled at $100/day, and can be disabled or changed to a weekly window in Accounts Control. Per-account hourly overrides are stored on `profiles`. See `docs/spend-model.md` for the check order, Manila boundaries, overrides, and grants.

`assertWithinSpendCaps` checks kie account balance → optional global daily/weekly → weekly → optional hourly → optional daily, in
that order; the first failure blocks the request. The balance check reads
`web/lib/kie-balance.ts` (60s cache), returns `null` (never throws) on a read failure —
`null` means "skip this check", not "there is money" — and is **skipped entirely in
`MODE=development`**, since a mocked render never reaches kie.

**The balance check is a snapshot, and always racy** — several renders can pass it and
still drain the account before kie bills any of them. The backstop is in the worker:
when kie refuses a submission for lack of funds, `loop.BalanceGate` closes the dispatch
loop *ahead of* `ClaimQueuedScenes`, on a 15m → 60m backoff. Placement is the point —
claiming is what flips a scene to `'rendering'`, and the worker may not flip it back, so
an unguarded drained account would convert up to `RENDER_CONCURRENCY` scenes to
`'failed'` every 30 seconds, none of which were ever attempted.

**`runs.cost_usd` is a receipt, not a computed figure** — the worker writes it from
kie's own `creditsConsumed` on the task, not from the rate table. A drifted rate table
can still produce a wrong **quote** (the number shown before submit, and what the cap is
checked against), which is why `lib/kie/rates.ts` carries provenance, but it can no
longer corrupt the ledger after the fact — the reconcile-against-vendor control that
existed for that on fal was deleted rather than ported.

This is a **spend-cap system, not a credit system**: no per-user balance is stored or
decremented, `runs.cost_usd` is summed over the window and compared to a ceiling. An
allowance grant raises that ceiling; it is not money. Only a kie top-up is money, and
it's manual — recorded in `/spend` after funding kie's own dashboard.

---

## ffmpeg — not a bottleneck if designed correctly

The naive approach — wait for all 30 clips, then re-encode a 4-minute 1080p video —
takes 10–20 minutes on Render's 0.5 CPU and pegs the box while it runs.

**Normalise each clip as it arrives instead.** An 8-second clip takes ~5–10 seconds, and
the next clip is still 3 minutes away, so it costs zero additional wall-clock:

```bash
# on webhook, per clip
ffmpeg -i clip.mp4 -vf scale=1080:1920,fps=24 \
  -c:v libx264 -preset veryfast -crf 20 -c:a aac -ar 48000 normalized.mp4

# at the end, all clips now identical — stream copy
ffmpeg -f concat -safe 0 -i list.txt -c copy final.mp4    # ~2 seconds
```

Heavy work split into 30 small pieces that run while the pipeline is already waiting.

Cap concurrent ffmpeg processes at 2 so five simultaneous webhooks cannot saturate the
CPU.

---

## Known gaps

- kie's concurrency limit for this account is unknown. It determines how long 20
  simultaneous editors wait — at 10 concurrent, 600 queued clips take ~3 hours.
- The client's actual monthly video volume is unknown, so break-even against their
  current $20k/mo vendor spend cannot be computed. Estimated break-even is ~1,050
  videos/month.
- Model pricing is defined in two places (`web/lib/kie/rates.ts` for what the UI quotes,
  `worker/internal/kie/models.go` for what is submitted), guarded by
  `rates-drift.test.ts`. Less dangerous than on fal, since `runs.cost_usd` now records
  what kie actually billed rather than what a table predicted — a drifted table produces
  a wrong QUOTE, not a wrong ledger. `AUDIO_ENABLED` has the same duplication:
  `web/lib/models.ts`'s `isAudioEnabled()` and `worker/internal/config`'s `AudioEnabled`
  read the same env var independently and must agree, or the operator is quoted a price
  the worker won't charge.
- The three spend caps are check-then-act and can be raced past (the comment above
  `getRemainingBudget` in `web/lib/spend.ts` says so). `getGlobalDailySpend`, `getDailySpend` and `getWeeklySpend`
  each return a point-in-time total with nothing reserving budget between that read and
  the `scenes.status = 'queued'` write in `actions/enqueue.ts`, so two operators
  confirming inside the same window both see the same total, both project under the cap,
  and both proceed — overshooting by up to the sum of everything that raced through.
  Harmless with one operator and not harmless at twenty, which is the planned team size;
  the trigger for fixing it is people, not code. A real fix makes the check and the
  reservation one transaction (a `spend_reservations` row, or a running-total row read
  `for update` alongside the enqueue write) rather than two round trips with a gap.
  Recorded here because it appeared in neither this document nor the roadmap while
  thirteen call sites relied on those caps holding.
- A migration's own header comment records what was true the day it was written, and
  nothing ever goes back to correct it — this doc has said a migration was pending twice
  now after it had already shipped. `supabase migration list` (or `EXPECTED_DB_VERSION`
  / `/api/health`'s `schemaDrift`) is the only answer worth trusting about what's
  applied.
- The sidebar's six-read footer measured **169ms p50 — about two-thirds of every
  authenticated page render** — and it isn't query cost, distance, or cold starts. It's
  a measured Supabase concurrency ceiling: ~76ms for one concurrent read, ~172ms for
  six. `Promise.all` cannot create concurrency the other end won't serve; firing reads
  in parallel was the cost, not the fix. `sidebar_budget_snapshot` (`0044`, above) is
  the fix — one round trip instead of six.

---

## Appendix: the fal era (decommissioned 2026-08-31)

kie replaced fal entirely on 2026-08-31. `worker/internal/fal/`,
`web/lib/fal-balance.ts` and `web/lib/ledger-reconcile.ts` are deleted; LTX, VEO and the
fal Kling endpoint cannot be selected. None of it is running code — read the
pre-decommission history in git (`git log --all -- 'worker/internal/fal/*'`) if you need
the detail.

It earned two rules that are still live, both enforced in `web/lib/kie/rates.ts` today:
**provenance on every rate** (fal's public pricing pages disagreed with what fal
actually billed, by up to 50%, and nobody found out until someone read the billing API
against real traffic), and **no fallback, ever** (an unmeasured number silently borrowed
from another vendor's rate — Seedance 1080p was quoted at fal's $1.1497/s when kie's
real rate is $0.570, half). Read it as the post-mortem behind those two rules, not as
documentation.
