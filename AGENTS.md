# AGENTS.md

Context for AI agents here. `README.md` is what the system is, `docs/architecture.md` is
why it is shaped this way; this file is what breaks without noticing.

## Do the task, and only the task

**Ask when you are unsure. Do not guess and do not go wide.**

- One task, one change. Notice something else? Say so in a sentence and leave it.
- If the request is ambiguous, ask — a question costs a message, wrong work an afternoon.
- Do not add options, models or "while I was here" refactors nobody asked for.
- Check what the UI can actually reach — a model added to a table no control selects is
  a diff, not a feature.
- **Answer the question, do not explain.** No reasoning, no background, unless asked.

**Do not run tests, lint, tsc or prettier** — Husky and CI run them, so push and read CI,
unless the user explicitly asks you to test.

## The one rule that matters

Two services share one Postgres and **never call each other over HTTP**. `scenes.status`
is the whole contract, and each service owns a disjoint half:

```
web  →  draft → frame_ready → queued
go   →  queued → rendering → done | failed
```

**`web/` must never write `rendering`, `done`, or `failed`. `worker/` must never write
`draft` or `frame_ready`.** The web app writes `status='queued'` and stops; the worker's
dispatch loop takes it from there. A video-generation call under `web/` belongs in the
worker. No REST API between them, no GraphQL, no shared types — considered and rejected;
see `docs/architecture.md`.

## Commands

```bash
make              # list targets          make dev     # web :9000 + worker
make install      # bun + go mod          make check   # everything CI runs
make db-push      # migrate LOCAL db      make tunnel  # kie cannot reach localhost
```

`make db-push` only touches local Postgres. `db-push-remote` (`--linked`) is not the
working path for prod: apply with `supabase db query --linked -f <file>`, then insert
the row into `supabase_migrations.schema_migrations` yourself, before the deploy —
`/api/health`'s `schemaDrift` checks against `EXPECTED_DB_VERSION` (currently `0132`).

**Bun, not pnpm or npm**, pinned to 1.4.2 in four places that move together: `ci.yml`,
both `web/Dockerfile` stages, and `package.json`'s `packageManager`. Go is 1.25;
`gofmt -l .` must print nothing.

## Money

Every vendor call goes to kie. A `/ugc` clip is **$0.56** (4s at 480p on Seedance 2.5, 28
cr/s, 200 cr/$) — linear in duration, so 15s is $2.10.

**kie's published price is sold (owner's decision, 2026-10-30).** `offerable()`
(`web/lib/kie/offerable.ts`) sells a documented rate without a receipt and refuses only a
lapsed promotion; the UI labels an unpaid rate. A measured render still turns a rate into
a receipt, so do one when you can:

```bash
AUDIO=1 node scripts/kie/measure-price.mjs \
  --model bytedance/seedance-2-fast --duration 15 --resolution 480p --yes-this-spends
```

Measure at the LONGEST duration — the balance rounds to whole credits, and that error
multiplies into every quote and cap. `AUDIO=1` because every render sets it true, and a
silent receipt lands in a table nothing reads.

```bash
MODE=development   # every vendor call mocked, on BOTH services — must match
```

MODE is not only a mock switch: `web/.env.local` points at **production** Supabase, and
the deployed worker polls the same `scenes` table, so a flag alone can't decide who claims
a job. `MODE=development` writes `scenes.dev = true`; a worker claims only its own MODE's
rows. Any `MOCK_*` env var is dead text.

Captions are gone. Subtitles are added in CapCut after export.

## `/ugc` is a picker now, not a pin

- **Seedance 2.5 on Kie ("· Kie") and on BytePlus are separate picks** (owner, 2026-11-09).
  Neither is ever a fallback for the other, and no scene is moved between them.
- **BytePlus Seedance is 480p only.** `ugc-options.ts` offers no other tier and
  `generateClip`/`regenerateClip` refuse any other resolution. Its Quality menu shows like
  every model's; with no pick it defaults to `high`.
- **Roles `hybrid_editor` and `ai_animator`** (0131; 0129's `team` tag is gone). Each has
  its own spend tier (`HYBRID_EDITOR_*` / `AI_ANIMATOR_*` caps, default = the global cap's
  default) and model access via `canUseVideoModel` (`lib/model-access.ts`): a Hybrid Editor
  cannot use `wan-3.0`; an AI Animator can use every model. **No allowance approval and no
  API tokens/MCP** — those stay with `trusted_editor` and `admin`. Set by an admin in
  Accounts Control (`setAccountRole`); no client can write `role`. SQL functions that list
  the editor tiers (`pass_allowance`, `transfer_recipients`, the weekly-reset and
  limits-changed notices, `outstanding_allowance_usd`) include both.
- **`profiles.last_seen_at`** is the presence heartbeat (`touchPresence`, every 60 s per
  visible tab); Accounts Control shows green within 2 minutes.
- **Uploads keep PNG and JPEG as sent.** `toJpeg` converts WebP only (Kling rejects it).
- **Prompts are capped at `MAX_PROMPT_CHARS` = 20,000** (`lib/prompt-limits.ts`) on `/ugc`;
  a lower per-model vendor cap (`maxPromptChars`) still wins.
- **Image ratios are 9:16, 1:1 and 16:9 on every model**; Nano Banana 2 is gone from the
  picker (`nano-banana-2-1` stays).

`PINNED_MODEL_ID`/`PINNED_RESOLUTION`/`PINNED_DURATION_S` (`ugc-column.tsx`) are the
**default for a new scene**, not a fixed value — the picker offers every `offerable()`
pair (today: Seedance 2.5, Kling 3.0) and follows the selected scene's own model. Kling's
std tier renders at real 720p but the UI labels it "480p" (`ugc-tier-label.ts`, display
only). `is_talking_head` drives Kling's `sound`; Seedance always sends `generate_audio`.

**Adding a model to the rate table still changes nothing on its own** — same
receipt-before-sale rule as Money above, plus a migration: `spend-category-sql.test.ts`
refuses any model missing from `spend_category_totals`'s render list.

- **References box** — `scene_references` (PR #140), up to `maxReferencesFor(model)` (12
  on Seedance 2.5, either route; `MAX_REFERENCES` = 10 elsewhere; `ugc-references.ts`), ordinal per kind (image 1 = start frame, 2 = end frame). Only
  "Use element" adds; an upload never does, and the prompt may only `@tag` what's in the
  box. `attachSceneReferences` writes it on Generate; reopening a scene reseeds it from
  `scene_references` via `referenceTags` (`ugc/[id]/page.tsx`, user-scoped read).
- **Kling is start+end frame, no `@tags`** — `klingTagRefusal` blocks any `@tag`; frames
  must be PNG/JPG (`KLING_FRAME_EXTS`), kie 422s on WebP, unbilled.
- **Retry is gone** — `regenerateClip` refuses queued/rendering, calls `rerenderScene`
  for `done`, `retryScene(…, versionMode)` for `failed`.
- **Generate is optimistic** — an external store (not `useTransition`, which can starve
  the one paint proving something happened) shows a Queued tile before the scene exists.

## Spend caps

A **spend-cap system with USD as the display unit** — no per-user balance is stored
or decremented. Read `docs/spend-model.md` before answering anything containing
"credit". `runs.cost_usd` sums against ceilings each attempt (`assertWithinSpendCaps`),
shown to everyone in dollars (credits were dropped from the UI on 2026-11-06). **Never add a
per-user credit balance** — it's headroom under a ceiling, not money reserved.

Role cap defaults live in `render.yaml`: regular editor `DAILY_CAP_USD`/`WEEKLY_CAP_USD` default to `0`, trusted `10`/`25`, and admin `100`/`700`. The optional global team cap is stored in `app_settings` and managed in Accounts Control; it defaults to enabled at $100 daily and can be disabled or set to daily/weekly. Per-account hourly overrides live in `profiles.hourly_cap_override_usd`. Whether the per-user daily guard is ENFORCED is a setting, not a deploy (`app_settings.user_daily_cap_enabled`, off by default). Boundaries are Asia/Manila; weeks reset Monday. Order: kie funds, optional global cap, weekly (cap plus grants), optional per-user hourly, optional per-user daily. Per-account overrides beat the role tier; role env vars move everyone.

**A scene can override the project's model** (`scenes.render_settings_override`, `0045`),
merged as `project.render_settings || override`. **Sticky** — nothing clears it, since it
records what the scene was billed at — so every pricing/cap site must resolve through
the merge, never read `projects.render_settings` directly.

## Boundaries

| Rule | Why |
| --- | --- |
| Allowance decisions go through `requireApprover`, never `requireAdmin` — nobody decides their own request | Trusted editors share one bounded authority without inheriting admin writes |
| Every Server Action calls a `guard.ts` helper first | The service-role client bypasses RLS; RLS is the second line |
| `actions/elements.ts` takes `requireProject` or `requireUser` and re-checks `element.user_id` either way | The guard alone never proves anything about the ELEMENT; the owner compare refuses a forged id |
| `runs` gets a row per _attempt_ | Input to the caps; a day of failures is real money. `cost_usd IS NULL` marks an attempt the vendor didn't bill |
| Project status is derived from `scenes` on every read | Storing it drifts. `'delivered'` is the one exception — a human act no scene implies |
| Commitment (`delivered`) and concurrency (`isSceneInFlight`) stay separate axes | Conflating them fired the edit lock at render-start instead of at Delivered |

**Two project guards, mixing them is the bug to avoid**: `requireProject` (owner-only,
every write) vs `requireProjectReadable` (lets a non-owning admin through, used by every
`projects/[id]/` page). An action such a page awaits must itself be readable-guarded, or
the admin is thrown out six lines later.

## Gotchas that already cost time

- **kie accepts unknown input fields, returns 200, and bills the render** — probing by
  submitting has cost money twice; read `docs.kie.ai/market/<vendor>/<model>` first.
- **kie's webhook nests everything in `data`**: `{"code":200,"data":{"taskId":…}}`. Top
  level reads meant no callback was accepted for a month. Test from bytes, not a struct.
- **`NEXT_PUBLIC_*` is inlined at build time into the client bundle** — never a secret.
  Changing one needs a rebuild; any env var needs at least a restart.
- **Creating a table grants nothing, and `0007_grants.sql` grants too much** — default
  privileges make every new public table readable by any signed-in user unless RLS is
  enabled. Both gates must pass; `anon` holds none.
- **The render spinner uses unprefixed `animate-spin` deliberately** — a test asserts
  the absence of `motion-safe:`. Do not "fix" it.
- **A Server Action written with no UI caller** has happened three times — add the
  caller in the same change.
- **RLS with zero policies returns 0 rows, silently.** Prod had that on
  `scene_references` while local had RLS off, so the References box reopened empty only
  in prod (fixed by `0098`). Every new table needs RLS, a policy, and an RLS test.
- **Admins are read-only on projects, not everywhere** — `requireProject` rejects them;
  `requireAdmin` is the boundary behind Character Library writes.
- **The Character Library is not gone — only its sidebar entry is.** `/library` and
  `characters` (0020) are untouched; the slot now holds the **Elements Library**
  (`/elements`) — per-account rows, not one admin-curated set.
- **`NULL < x` is `NULL`.** `submitted_at` is stamped at claim time so reconcile can
  find work claimed but never submitted.

## Verifying your work

Do not report something as working until it has run — **CI is what runs it**; push and
read CI. Touched a Dockerfile? Build and run the image. Touched the webhook? POST the
same `taskId` twice — one asset, not two. Changed SQL? Apply it and read a row back.

**Read the exit code, not a grep of the output** — `go test ./...`'s INFO lines crowd a
`FAIL` out of `head`, and eslint's compact formatter doesn't print "error" a grep expects.

## Not proven yet

- **kie's concurrent-submission limit is unknown** — `RENDER_CONCURRENCY=10` assumes
  one, untested against a real burst.
- **No silent seedance rate exists at any tier** — every receipt has audio on, so "no
  surcharge" is an inference kie's docs contradict.
- **Perf under load** — `PERF_LOGGING_ENABLED=1` ships `perf_render:` lines unread.
- The worker reaches Postgres through the **session pooler**, not the IPv6-only direct
  host Render can't reach — don't "fix" `DATABASE_URL`.

## Do not commit

- `.env`, `.env.local` — real credentials
- `*.mp4` — the source recording contains third-party PII
- `web/AGENTS.md`, `web/CLAUDE.md` — generated by Next; `agentRules: false` keeps them away
